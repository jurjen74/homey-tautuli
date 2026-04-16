'use strict';

const Homey = require('homey');
const TautulliClient = require('../../lib/TautulliClient');

const DEFAULT_POLL_INTERVAL = 15; // seconds
const HISTORY_WARMUP_SECONDS = 300; // pre-populate history IDs older than this on first poll

class TautulliDevice extends Homey.Device {

  async onInit() {
    this._client = this._createClient();

    // Capability migration
    if (this.hasCapability('alarm_generic')) {
      await this.removeCapability('alarm_generic').catch((err) => this.error('removeCapability alarm_generic:', err));
    }
    if (this.hasCapability('active_streams')) {
      await this.removeCapability('active_streams').catch((err) => this.error('removeCapability active_streams:', err));
    }
    for (const cap of ['measure_streams', 'plex_active', 'plays_today', 'plays_this_week']) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch((err) => this.error(`addCapability ${cap}:`, err));
      }
    }

    // null = first poll; Map<session_key, session> after first poll
    this._prevSessions = null;

    // null = first poll; Set<id> after first poll
    this._seenHistoryIds = null;

    this._thumbCache = new Map(); // imgPath → base64 data URL
    this._statsCache = new Map(); // "timeRange:count" → { data, expiresAt }

    this._pollTimer = null;
    this._startPolling();

    this.log(`${this.getName()} initialized`);
  }

  // ---------------------------------------------------------------------------
  // Client
  // ---------------------------------------------------------------------------

  _createClient() {
    const { url, apiKey } = this.getSettings();
    return new TautulliClient(url, apiKey);
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  _startPolling() {
    this._stopPolling();
    const intervalMs = (this.getSetting('pollInterval') || DEFAULT_POLL_INTERVAL) * 1000;
    this._poll().catch((err) => this.error('Initial poll error:', err));
    this._pollTimer = this.homey.setInterval(() => {
      this._poll().catch((err) => this.error('Poll interval error:', err));
    }, intervalMs);
  }

  _stopPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _poll() {
    try {
      await Promise.all([
        this._updateActivity(),
        this._updateHistory(),
        this._updateStats(),
      ]);
      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.error('Poll error:', err.message);
      await this.setUnavailable(err.message).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Activity (real-time sessions)
  // ---------------------------------------------------------------------------

  async _updateActivity() {
    const data = await this._client.getActivity();
    const sessions = data.sessions || [];

    const currentMap = new Map(sessions.map((s) => [s.session_key, s]));
    const activeCount = sessions.length;
    const transcodingCount = sessions.filter((s) => s.transcode_decision === 'transcode').length;

    if (this._prevSessions === null) {
      // First poll — record state without firing triggers
      this._prevSessions = currentMap;
    } else {
      const prevCount = this._prevSessions.size;

      // New sessions → stream_started
      for (const [key, session] of currentMap) {
        if (!this._prevSessions.has(key)) {
          await this._triggerStreamStarted(session);
        }
      }

      // Removed sessions → stream_ended
      for (const [key, session] of this._prevSessions) {
        if (!currentMap.has(key)) {
          await this._triggerStreamEnded(session);
        }
      }

      // State changes within existing sessions → paused / resumed
      for (const [key, session] of currentMap) {
        const prev = this._prevSessions.get(key);
        if (!prev) continue;

        if (prev.state === 'playing' && session.state === 'paused') {
          await this._triggerStreamPaused(session);
        } else if (prev.state === 'paused' && session.state === 'playing') {
          await this._triggerStreamResumed(session);
        }
      }

      // Active count changed → active_streams_changed
      if (activeCount !== prevCount) {
        await this.driver._activeStreamsChangedTrigger
          .trigger(this, { streams: activeCount, previous_streams: prevCount })
          .catch((err) => this.error('active_streams_changed trigger error:', err.message));

      }

      this._prevSessions = currentMap;
    }

    await this.setCapabilityValue('measure_streams', activeCount).catch(() => {});
    await this.setCapabilityValue('transcoding_streams', transcodingCount).catch(() => {});
    await this.setCapabilityValue('plex_active', activeCount > 0).catch(() => {});
  }

  _indexTokens(item) {
    const isEpisode = item.media_type === 'episode';
    const isTrack = item.media_type === 'track';
    return {
      season_number: isEpisode ? Number(item.parent_media_index) || 0 : 0,
      episode_number: isEpisode ? Number(item.media_index) || 0 : 0,
      track_number: isTrack ? Number(item.media_index) || 0 : 0,
    };
  }

  _sessionTokens(session) {
    return {
      user: session.user || '',
      title: session.full_title || session.title || '',
      media_type: session.media_type || '',
      player: session.player || '',
      transcoded: session.transcode_decision === 'transcode',
      ...this._indexTokens(session),
    };
  }

  _notify(excerpt, settingKey) {
    if (this.getSetting(settingKey) === false) return;
    this.homey.notifications.createNotification({ excerpt })
      .catch((err) => this.error('notification error:', err.message));
  }

  async _triggerStreamStarted(session) {
    const title = session.full_title || session.title || '';
    const user = session.user || '';
    this._notify(`▶ ${user} — ${title} · ${this.getName()}`, 'notifyStreamStarted');
    await this.driver._streamStartedTrigger
      .trigger(this, this._sessionTokens(session))
      .catch((err) => this.error('stream_started trigger error:', err.message));
  }

  async _triggerStreamEnded(session) {
    const title = session.full_title || session.title || '';
    const user = session.user || '';
    const pct = Number(session.progress_percent) || 0;
    this._notify(`⏹ ${user} — ${title} (${pct}%) · ${this.getName()}`, 'notifyStreamEnded');
    await this.driver._streamEndedTrigger
      .trigger(this, {
        user,
        title,
        media_type: session.media_type || '',
        progress_percent: pct,
        ...this._indexTokens(session),
      })
      .catch((err) => this.error('stream_ended trigger error:', err.message));
  }

  async _triggerStreamPaused(session) {
    await this.driver._streamPausedTrigger
      .trigger(this, {
        user: session.user || '',
        title: session.full_title || session.title || '',
        media_type: session.media_type || '',
        player: session.player || '',
        ...this._indexTokens(session),
      })
      .catch((err) => this.error('stream_paused trigger error:', err.message));
  }

  async _triggerStreamResumed(session) {
    await this.driver._streamResumedTrigger
      .trigger(this, {
        user: session.user || '',
        title: session.full_title || session.title || '',
        media_type: session.media_type || '',
        player: session.player || '',
        ...this._indexTokens(session),
      })
      .catch((err) => this.error('stream_resumed trigger error:', err.message));
  }

  // ---------------------------------------------------------------------------
  // History (completed watches)
  // ---------------------------------------------------------------------------

  async _updateHistory() {
    const result = await this._client.getHistory({ length: 25 });
    const records = result.data || [];

    if (this._seenHistoryIds === null) {
      // First poll — pre-populate IDs; only fire for records within the last
      // HISTORY_WARMUP_SECONDS (catches watches that finished just before restart).
      const cutoff = Math.floor(Date.now() / 1000) - HISTORY_WARMUP_SECONDS;
      this._seenHistoryIds = new Set();

      for (const record of records) {
        this._seenHistoryIds.add(record.id);
        if (record.date >= cutoff) {
          await this._triggerWatchCompleted(record);
        }
      }
      return;
    }

    for (const record of records) {
      if (!this._seenHistoryIds.has(record.id)) {
        this._seenHistoryIds.add(record.id);
        await this._triggerWatchCompleted(record);
      }
    }
  }

  async _triggerWatchCompleted(record) {
    const title = record.full_title || record.title || '';
    const user = record.user || '';
    const pct = Number(record.percent_complete) || 0;
    this._notify(`✓ ${user} completed ${title} (${pct}%) · ${this.getName()}`, 'notifyWatchCompleted');
    await this.driver._watchCompletedTrigger
      .trigger(this, {
        user,
        title,
        media_type: record.media_type || '',
        percent_complete: pct,
        duration: Number(record.duration) || 0,
        ...this._indexTokens(record),
      })
      .catch((err) => this.error('watch_completed trigger error:', err.message));
  }

  // ---------------------------------------------------------------------------
  // Stats (plays today / this week — feeds Insights capabilities)
  // ---------------------------------------------------------------------------

  async _updateStats() {
    const data = await this._client.getPlaysByDate({ timeRange: 7 });
    const series = data.series || [];

    let todayTotal = 0;
    let weekTotal = 0;

    for (const s of series) {
      const pts = s.data || [];
      weekTotal += pts.reduce((a, b) => a + b, 0);
      if (pts.length > 0) todayTotal += pts[pts.length - 1];
    }

    await this.setCapabilityValue('plays_today', todayTotal).catch(() => {});
    await this.setCapabilityValue('plays_this_week', weekTotal).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Public API (for widgets)
  // ---------------------------------------------------------------------------

  async getActivity() {
    return this._client.getActivity();
  }

  async getHistory(params = {}) {
    return this._client.getHistory(params);
  }

  async _getPlatformImageDataUrl(imagePath) {
    if (!imagePath) return '';
    const cacheKey = `platform:${imagePath}`;
    if (this._thumbCache.has(cacheKey)) return this._thumbCache.get(cacheKey);

    // Try local Tautulli first; fall back to the public GitHub source when
    // Tautulli's web auth blocks direct access to /images/.
    let dataUrl = await this._client.getStaticImage(imagePath);
    if (!dataUrl) {
      const filename = imagePath.split('/').pop();
      const githubUrl = `https://raw.githubusercontent.com/Tautulli/Tautulli/master/data/interfaces/default/images/platforms/${filename}`;
      dataUrl = await this._client.fetchImage(githubUrl);
    }

    if (dataUrl) this._thumbCache.set(cacheKey, dataUrl);
    return dataUrl;
  }

  async _getThumbDataUrl(imgPath) {
    if (!imgPath) return '';
    if (this._thumbCache.has(imgPath)) return this._thumbCache.get(imgPath);
    const dataUrl = await this._client.getImageBase64(imgPath);
    if (dataUrl) this._thumbCache.set(imgPath, dataUrl);
    return dataUrl;
  }

  async getNowPlaying() {
    const data = await this._client.getActivity();
    const sessions = data.sessions || [];

    const thumbPaths = sessions.map((s) => s.grandparent_thumb || s.thumb || s.parent_thumb || '');
    const userThumbPaths = sessions.map((s) => s.user_thumb || '');

    const [thumbUrls, userThumbUrls] = await Promise.all([
      Promise.all(thumbPaths.map((p) => this._getThumbDataUrl(p))),
      Promise.all(userThumbPaths.map((p) => this._getThumbDataUrl(p))),
    ]);

    return sessions.map((s, i) => ({
      thumbUrl: thumbUrls[i],
      userThumbUrl: userThumbUrls[i],
      user: s.friendly_name || s.user || '',
      title: s.full_title || s.title || '',
      grandparentTitle: s.grandparent_title || '',
      mediaType: s.media_type || '',
      state: s.state || 'playing',
      progressPercent: Number(s.progress_percent) || 0,
      // Client
      product: s.product || '',
      player: s.player || '',
      // Stream
      quality: s.quality || '',
      transcodeDecision: s.transcode_decision || '',
      throttled: s.throttled === '1',
      // Container
      container: s.stream_container || '',
      sourceContainer: s.container || '',
      // Video
      videoDecision: s.video_decision || '',
      videoCodec: s.stream_video_codec || '',
      videoResolution: s.stream_video_resolution || '',
      sourceVideoCodec: s.video_codec || '',
      sourceVideoResolution: s.video_resolution || '',
      // Audio
      audioDecision: s.audio_decision || '',
      audioCodec: s.stream_audio_codec || '',
      audioChannels: Number(s.stream_audio_channels) || 0,
      sourceAudioCodec: s.audio_codec || '',
      sourceAudioChannels: Number(s.audio_channels) || 0,
      // Subtitle
      subtitleDecision: s.subtitle_decision || '',
      subtitleCodec: s.subtitle_codec || '',
      // Network
      ipAddress: s.ip_address || '',
      location: s.location || '',
      bandwidth: Number(s.bandwidth) || 0,
    }));
  }

  async getTopStats({ timeRange = 30, count = 5 } = {}) {
    const cacheKey = `${timeRange}:${count}`;
    const cached = this._statsCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.data;

    const stats = await this._client.getHomeStats({ timeRange, count });
    const statList = Array.isArray(stats) ? stats : [];

    // platform_name (lowercase, e.g. "chrome") → platforms/{name}.png on Tautulli's web root.
    // user_thumb: Plex CDN URL proxied via pms_image_proxy.
    const SECTIONS = [
      {
        id: 'top_movies', hasPoster: true, thumbField: 'thumb', imageType: 'plex',
      },
      {
        id: 'top_tv', hasPoster: true, thumbField: 'thumb', imageType: 'plex',
      },
      {
        id: 'top_music', hasPoster: true, thumbField: 'thumb', imageType: 'plex',
      },
      {
        id: 'top_users', hasPoster: true, thumbField: 'user_thumb', imageType: 'plex',
      },
      {
        id: 'top_platforms', hasPoster: true, thumbField: 'platform_name', imageType: 'static',
      },
    ];

    const thumbFetches = SECTIONS.map(({
      id, hasPoster, thumbField, imageType,
    }) => {
      if (!hasPoster || !thumbField) return Promise.resolve('');
      const stat = statList.find((s) => s.stat_id === id);
      const first = stat && (stat.rows || [])[0];
      if (!first) return Promise.resolve('');
      if (imageType === 'static') {
        const name = first[thumbField] || '';
        return name ? this._getPlatformImageDataUrl(`platforms/${name}.svg`) : Promise.resolve('');
      }
      const path = first[thumbField] || '';
      return path ? this._getThumbDataUrl(path) : Promise.resolve('');
    });
    const thumbUrls = await Promise.all(thumbFetches);

    const result = {};
    SECTIONS.forEach(({ id, hasPoster }, idx) => {
      const stat = statList.find((s) => s.stat_id === id);
      if (!stat) return;
      result[id] = (stat.rows || []).map((row, i) => ({
        rank: i + 1,
        title: row.friendly_name || row.user || row.platform || row.platform_type || row.title || '',
        plays: Number(row.total_plays) || 0,
        thumbUrl: hasPoster && i === 0 ? thumbUrls[idx] : '',
      }));
    });

    this._statsCache.set(cacheKey, { data: result, expiresAt: Date.now() + 60000 });
    return result;
  }

  async getRecentHistory(count = 10) {
    const result = await this._client.getHistory({ length: count });
    const TYPE_LABELS = { movie: 'Movie', episode: 'TV', track: 'Music' };
    return (result.data || []).map((r) => ({
      title: r.full_title || r.title || '',
      subtitle: r.user || '',
      date: r.date ? new Date(r.date * 1000).toISOString() : null,
      badge: TYPE_LABELS[r.media_type] || r.media_type || '',
      duration: Number(r.duration) || 0,
      percentComplete: Number(r.percent_complete) || 0,
    }));
  }

  // ---------------------------------------------------------------------------
  // Settings / lifecycle
  // ---------------------------------------------------------------------------

  async onSettings({ changedKeys, newSettings }) {
    if (changedKeys.includes('url') || changedKeys.includes('apiKey')) {
      this._client = this._createClient();
    }
    if (changedKeys.includes('pollInterval')) {
      this._startPolling();
    }
  }

  async onDeleted() {
    this._stopPolling();
  }

}

module.exports = TautulliDevice;
