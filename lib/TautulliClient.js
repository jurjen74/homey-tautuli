'use strict';

const http = require('http');
const https = require('https');

class TautulliClient {

  constructor(baseUrl, apiKey) {
    const parsed = new URL(baseUrl);
    this._host = parsed.hostname;
    this._port = parseInt(parsed.port, 10) || (parsed.protocol === 'https:' ? 443 : 80);
    this._ssl = parsed.protocol === 'https:';
    this._basePath = parsed.pathname.replace(/\/$/, '');
    this._apiKey = apiKey;
  }

  async _get(cmd, params = {}) {
    const qs = new URLSearchParams({ apikey: this._apiKey, cmd, ...params });
    const path = `${this._basePath}/api/v2?${qs.toString()}`;
    const lib = this._ssl ? https : http;

    return new Promise((resolve, reject) => {
      const req = lib.get(
        { hostname: this._host, port: this._port, path },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => {
            try {
              const json = JSON.parse(raw);
              if (json.response?.result !== 'success') {
                reject(new Error(json.response?.message || 'API error'));
                return;
              }
              resolve(json.response.data);
            } catch (err) {
              reject(new Error('Invalid JSON response'));
            }
          });
        },
      );
      req.setTimeout(10000, () => req.destroy(new Error('Request timeout')));
      req.on('error', reject);
    });
  }

  /**
   * Fetch a Tautulli static image (e.g. platform icons) and return it as a base64 data URL.
   * @param {string} imagePath  Path relative to /interfaces/default/images/, e.g. platforms/plex.png
   * @returns {Promise<string>}  data:<mime>;base64,<data>  or '' on failure
   */
  async getStaticImage(imagePath) {
    // Try local Tautulli (works when auth is disabled or allows apikey on /images/).
    const candidates = [
      `${this._basePath}/images/${imagePath}?apikey=${this._apiKey}`,
      `${this._basePath}/images/${imagePath}`,
    ];
    const lib = this._ssl ? https : http;

    for (const path of candidates) {
      const result = await this._fetchImageBytes(lib, this._host, this._port, path);
      if (result) return result;
    }
    return '';
  }

  /**
   * Fetch an image from any URL (http or https) and return a base64 data URL.
   * Used as a fallback when local Tautulli static files are auth-protected.
   */
  async fetchImage(url) {
    const lib = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const defaultPort = parsed.protocol === 'https:' ? 443 : 80;
    const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
    const path = parsed.pathname + (parsed.search || '');
    return this._fetchImageBytes(lib, parsed.hostname, port, path);
  }

  _fetchImageBytes(lib, hostname, port, path) {
    return new Promise((resolve) => {
      const req = lib.get({ hostname, port, path }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve('');
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          const contentType = res.headers['content-type'] || '';
          if (!contentType.startsWith('image/') && !contentType.includes('svg')) {
            resolve('');
            return;
          }
          resolve(`data:${contentType};base64,${Buffer.concat(chunks).toString('base64')}`);
        });
      });
      req.setTimeout(5000, () => {
        req.destroy(); resolve('');
      });
      req.on('error', () => resolve(''));
    });
  }

  /**
   * Fetch a Plex image via Tautulli's proxy and return it as a base64 data URL.
   * @param {string} imgPath  Plex image path, e.g. /library/metadata/123/thumb/456
   * @param {number} [width=150]
   * @param {number} [height=225]
   * @returns {Promise<string>}  data:<mime>;base64,<data>  or '' on failure
   */
  async getImageBase64(imgPath, width = 150, height = 225) {
    const qs = new URLSearchParams({
      apikey: this._apiKey,
      cmd: 'pms_image_proxy',
      img: imgPath,
      width,
      height,
      fallback: 'poster',
    });
    const path = `${this._basePath}/api/v2?${qs.toString()}`;
    const lib = this._ssl ? https : http;

    return new Promise((resolve) => {
      const req = lib.get(
        { hostname: this._host, port: this._port, path },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => {
            chunks.push(chunk);
          });
          res.on('end', () => {
            const contentType = res.headers['content-type'] || '';
            if (!contentType.startsWith('image/')) {
              resolve('');
              return;
            }
            const b64 = Buffer.concat(chunks).toString('base64');
            resolve(`data:${contentType};base64,${b64}`);
          });
        },
      );
      req.setTimeout(5000, () => {
        req.destroy(); resolve('');
      });
      req.on('error', () => resolve(''));
    });
  }

  /**
   * Test connectivity — resolves with server activity data on success.
   */
  async testConnection() {
    return this._get('get_activity');
  }

  /**
   * Get current streaming sessions.
   * Returns: { stream_count, stream_count_direct_play, stream_count_transcode, sessions: [...] }
   * Each session: session_key, user, full_title, title, grandparent_title,
   *   media_type, state, progress_percent, transcode_decision, quality, player, ip_address
   */
  async getActivity() {
    return this._get('get_activity');
  }

  /**
   * Get watch history.
   * @param {object} opts
   * @param {string}  [opts.user]       Filter by username
   * @param {string}  [opts.mediaType]  movie | episode | track
   * @param {number}  [opts.length=25]  Number of records
   * @param {number}  [opts.start=0]    Offset
   * Returns: { recordsFiltered, recordsTotal, data: [...] }
   * Each record: id, date (unix), full_title, user, media_type, percent_complete, duration
   */
  async getHistory({
    user = null, mediaType = null, length = 25, start = 0,
  } = {}) {
    const params = { length, start };
    if (user) params.user = user;
    if (mediaType) params.media_type = mediaType;
    return this._get('get_history', params);
  }

  /**
   * Get all Plex users known to Tautulli.
   * Returns array of user objects: { user_id, username, friendly_name, ... }
   */
  async getUsers() {
    return this._get('get_users');
  }

  /**
   * Get play counts grouped by date.
   * @param {object} opts
   * @param {number} [opts.timeRange=7] Number of days to include
   * Returns: { categories: [...dateStrings], series: [{ name, data: [...counts] }] }
   * The last entry in each data array corresponds to today.
   */
  async getPlaysByDate({ timeRange = 7 } = {}) {
    return this._get('get_plays_by_date', { time_range: timeRange });
  }

  /**
   * Get home dashboard statistics / top lists.
   * @param {object} opts
   * @param {number} [opts.timeRange=30]  Days to include
   * @param {number} [opts.count=5]       Items per category
   * Returns array of { stat_id, rows: [...] } objects.
   * stat_id values: top_movies, top_tv, top_music, top_users, top_platforms
   */
  async getHomeStats({ timeRange = 30, count = 5 } = {}) {
    return this._get('get_home_stats', { time_range: timeRange, stats_count: count });
  }

}

module.exports = TautulliClient;
