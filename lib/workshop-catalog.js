const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const WTD_APP_ID = 1495860;

class WorkshopCatalog extends EventEmitter {
  constructor(options = {}) {
    super();
    this.seedPath = options.seedPath || '';
    this.cacheManager = options.cacheManager || null;
    this._lastFetch = 0;
    this._refreshing = false;
  }

  async init() {
    try {
      if (this.seedPath && fs.existsSync(this.seedPath)) {
        const raw = JSON.parse(fs.readFileSync(this.seedPath, 'utf-8'));
        this._lastFetch = raw._lastFetch || 0;
        this.emit('status', { lastFetch: this._lastFetch, hasSeed: true });
      }
    } catch (e) {
      this.emit('status', { lastFetch: 0, hasSeed: false, error: e.message });
    }
  }

  getLastFetchTime() {
    return this._lastFetch;
  }

  isRefreshing() {
    return this._refreshing;
  }

  async refresh(apiKey) {
    if (this._refreshing) {
      this.emit('error', { message: 'Refresh already in progress' });
      return;
    }

    this._refreshing = true;
    this.emit('refresh-started');

    try {
      const items = await this._fetchCatalog(apiKey);

      const existing = this.cacheManager ? this.cacheManager.get() : {};
      let newCount = 0;
      let updatedCount = 0;
      const creatorToSteamIds = new Map();

      for (const item of items) {
        const id = item.id;
        if (!id || !item.title) continue;

        if (!existing[id]) {
          newCount++;
        } else {
          const oldName = existing[id].name || existing[id];
          if (oldName !== item.title) updatedCount++;
        }

        const creatorName = item.creatorName || null;
        if (this.cacheManager) {
          this.cacheManager.set(id, item.title, null, creatorName);
        }

        if (item.creatorSteamId && !creatorName) {
          if (!creatorToSteamIds.has(item.creatorSteamId)) {
            creatorToSteamIds.set(item.creatorSteamId, []);
          }
          creatorToSteamIds.get(item.creatorSteamIds).push(id);
        }
      }

      if (this.cacheManager) {
        this.cacheManager.save();
      }

      this._lastFetch = Math.floor(Date.now() / 1000);
      this.emit('refresh-complete', {
        total: items.length,
        new: newCount,
        updated: updatedCount,
        timestamp: this._lastFetch,
      });
    } catch (e) {
      this.emit('error', { message: `Catalog refresh failed: ${e.message}` });
    } finally {
      this._refreshing = false;
    }
  }

  async _fetchCatalog(apiKey) {
    const url = new URL('https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/');
    url.searchParams.set('key', apiKey);
    const inputJson = {
      appid: WTD_APP_ID,
      query_type: 1,
      cursor: '*',
      numperpage: 100,
      return_details: true,
    };
    if (this._lastFetch > 0) {
      inputJson.date_range_updated = {
        timestamp_start: this._lastFetch,
        timestamp_end: Math.floor(Date.now() / 1000),
      };
    }
    url.searchParams.set('input_json', JSON.stringify(inputJson));

    let cursor = '*';
    const allItems = [];

    while (cursor) {
      let fetchUrl;
      if (this._lastFetch > 0) {
        fetchUrl = new URL('https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/');
        fetchUrl.searchParams.set('key', apiKey);
        const input = {
          appid: WTD_APP_ID,
          query_type: 1,
          cursor: cursor,
          numperpage: 100,
          return_details: true,
          date_range_updated: {
            timestamp_start: this._lastFetch,
            timestamp_end: Math.floor(Date.now() / 1000),
          },
        };
        fetchUrl.searchParams.set('input_json', JSON.stringify(input));
      } else {
        fetchUrl = new URL('https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/');
        fetchUrl.searchParams.set('key', apiKey);
        fetchUrl.searchParams.set('appid', WTD_APP_ID.toString());
        fetchUrl.searchParams.set('query_type', '1');
        fetchUrl.searchParams.set('cursor', cursor);
        fetchUrl.searchParams.set('numperpage', '100');
        fetchUrl.searchParams.set('return_details', 'true');
      }

      const res = await fetch(fetchUrl.toString());

      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 120000;
        this.emit('status', { message: `Rate limited, waiting ${waitMs / 1000}s...` });
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      if (!res.ok) {
        throw new Error(`Steam API returned HTTP ${res.status}`);
      }

      const data = await res.json();
      const response = data.response || {};
      const items = response.publishedfiledetails || [];
      cursor = response.next_cursor || '';

      for (const item of items) {
        const id = item.publishedfileid;
        const title = item.title;
        const creatorSteamId = item.creator || null;
        if (id && title) {
          allItems.push({
            id,
            title,
            creatorSteamId,
            creatorName: null,
          });
        }
      }

      this.emit('progress', { fetched: allItems.length });
      if (!cursor || items.length === 0) break;
      await new Promise(r => setTimeout(r, 1500));
    }

    const steamIds = [...new Set(allItems.filter(i => i.creatorSteamId).map(i => i.creatorSteamId))];
    if (steamIds.length > 0) {
      const creatorNames = await this._resolveCreatorNames(apiKey, steamIds);
      for (const item of allItems) {
        if (item.creatorSteamId && creatorNames[item.creatorSteamId]) {
          item.creatorName = creatorNames[item.creatorSteamId];
        }
      }
    }

    return allItems;
  }

  async _resolveCreatorNames(apiKey, steamIds) {
    const creatorNames = {};

    for (let i = 0; i < steamIds.length; i += 100) {
      const batch = steamIds.slice(i, i + 100);
      try {
        const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/');
        url.searchParams.set('key', apiKey);
        url.searchParams.set('steamids', batch.join(','));
        const res = await fetch(url.toString());
        if (res.ok) {
          const data = await res.json();
          const players = data.response?.players || [];
          for (const player of players) {
            creatorNames[player.steamid] = player.personaname;
          }
        }
        await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        this.emit('error', { message: `Failed to resolve creator names: ${e.message}` });
      }
    }

    return creatorNames;
  }
}

module.exports = { WorkshopCatalog };
