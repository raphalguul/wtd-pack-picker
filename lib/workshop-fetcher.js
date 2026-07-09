const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');

const MAX_CONCURRENT = 2;
const DELAY_BETWEEN_REQUESTS = 800;
const REQUEST_TIMEOUT = 10000;
const MAX_RETRIES = 3;

class WorkshopFetcher extends EventEmitter {
  constructor(cacheManager, thumbnailDir) {
    super();
    this.cacheManager = cacheManager;
    this.thumbnailDir = thumbnailDir;
    this._queue = [];
    this._activeCount = 0;
    this._running = false;
    this._rateLimited = false;
    this._rateLimitUntil = 0;
    this._offline = true;
  }

  setOffline(offline) {
    this._offline = !!offline;
  }

  queueIds(ids) {
    if (this._offline) return;
    if (!Array.isArray(ids)) ids = [ids];
    for (const id of ids) {
      const strId = String(id);
      const cached = this.cacheManager.get(strId);
      if (this._queue.includes(strId)) continue;
      if (cached && cached.name) continue;
      this._queue.push(strId);
    }
    if (!this._running) {
      this._running = true;
      this._processQueue();
    }
  }

  getStatus() {
    return {
      queueSize: this._queue.length,
      activeFetchCount: this._activeCount,
      rateLimited: this._rateLimited,
      rateLimitUntil: this._rateLimited ? new Date(this._rateLimitUntil).toISOString() : null,
      running: this._running,
      offline: this._offline
    };
  }

  async _processQueue() {
    while (this._queue.length > 0 || this._activeCount > 0) {
      if (this._rateLimited) {
        const waitMs = Math.max(0, this._rateLimitUntil - Date.now());
        if (waitMs > 0) {
          await sleep(waitMs);
        }
        this._rateLimited = false;
      }

      while (this._activeCount < MAX_CONCURRENT && this._queue.length > 0) {
        const id = this._queue.shift();
        this._activeCount++;
        this._fetchWorkshop(id).finally(() => {
          this._activeCount--;
        });
      }

      await sleep(200);
    }
    this._running = false;
  }

  async _fetchWorkshop(id) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      try {
        const result = await this._doFetch(id, controller);
        if (result) return;
        return;
      } catch (e) {
        if (e.status === 429) {
          const retryAfter = e.retryAfter || 120000;
          this._rateLimited = true;
          this._rateLimitUntil = Date.now() + retryAfter;
          this._queue.unshift(id);
          return;
        }
        if (attempt < MAX_RETRIES) {
          await sleep(1000 * attempt);
        }
      }
    }
  }

  async _doFetch(id, controller) {
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const html = await fetchSteamPage(id, controller.signal);
      clearTimeout(timeoutId);

      const name = extractName(html, id);

      if (!name || name === 'Steam Community :: Error') {
        throw new Error('Steam error page');
      }

      this.cacheManager.set(id, name, null);
      this.emit('name-resolved', { id, name });

      await sleep(DELAY_BETWEEN_REQUESTS);
      return true;
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') {
        throw new Error('Request timeout');
      }
      if (e.status === 429) throw e;
      throw e;
    }
  }
}

function fetchSteamPage(workshopId, signal) {
  return new Promise((resolve, reject) => {
    const url = `https://steamcommunity.com/sharedfiles/filedetails/?id=${workshopId}`;
    const protocol = url.startsWith('https') ? https : http;

    const req = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, (res) => {
      if (res.statusCode === 429) {
        const retryAfter = parseInt(res.headers['retry-after'], 10) || 120;
        const err = new Error('Rate limited');
        err.status = 429;
        err.retryAfter = retryAfter * 1000;
        reject(err);
        return;
      }

      if (res.statusCode >= 400) {
        const err = new Error(`HTTP ${res.statusCode}`);
        err.status = res.statusCode;
        reject(err);
        return;
      }

      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy();
      });
    }
  });
}

function extractName(html, fallbackId) {
  const match = html.match(/<title>([^<]+)<\/title>/i);
  if (!match) return fallbackId;
  let title = match[1].trim();
  title = title.replace(/^Steam Workshop::\s*/i, '').replace(/\s*::\s*Steam Workshop$/i, '');
  title = title.replace(/ - Steam Workshop$/, '');
  if (!title || title === 'Steam Community') return fallbackId;
  return title;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { WorkshopFetcher };
