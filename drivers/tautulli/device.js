'use strict';

const Homey = require('homey');
const TautulliClient = require('../../lib/TautulliClient');

const DEFAULT_POLL_INTERVAL = 15; // seconds
const HISTORY_WARMUP_SECONDS = 300; // pre-populate history IDs older than this on first poll

class TautulliDevice extends Homey.Device {

  async onInit() {
    this._client = this._createClient();

    // Capability migration — add new capabilities to existing devices
    for (const cap of ['plays_today', 'plays_this_week']) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch((err) => this.error(`addCapability ${cap}:`, err));
      }
    }

    // null = first poll; Map<session_key, session> after first poll
    this._prevSessions = null;

    // null = first poll; Set<id> after first poll
    this._seenHistoryIds = null;

    this._thumbCache = new Map(); // imgPath → base64 data URL

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

    await this.setCapabilityValue('active_streams', activeCount).catch(() => {});
    await this.setCapabilityValue('transcoding_streams', transcodingCount).catch(() => {});
    await this.setCapabilityValue('alarm_generic', activeCount > 0).catch(() => {});
  }

  _sessionTokens(session) {
    return {
      user: session.user || '',
      title: session.full_title || session.title || '',
      media_type: session.media_type || '',
      player: session.player || '',
      transcoded: session.transcode_decision === 'transcode',
    };
  }

  async _triggerStreamStarted(session) {
    await this.driver._streamStartedTrigger
      .trigger(this, this._sessionTokens(session))
      .catch((err) => this.error('stream_started trigger error:', err.message));
  }

  async _triggerStreamEnded(session) {
    await this.driver._streamEndedTrigger
      .trigger(this, {
        user: session.user || '',
        title: session.full_title || session.title || '',
        media_type: session.media_type || '',
        progress_percent: Number(session.progress_percent) || 0,
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
    await this.driver._watchCompletedTrigger
      .trigger(this, {
        user: record.user || '',
        title: record.full_title || record.title || '',
        media_type: record.media_type || '',
        percent_complete: Number(record.percent_complete) || 0,
        duration: Number(record.duration) || 0,
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
    const thumbUrls = await Promise.all(thumbPaths.map((p) => this._getThumbDataUrl(p)));

    return sessions.map((s, i) => ({
      thumbUrl: thumbUrls[i],
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
