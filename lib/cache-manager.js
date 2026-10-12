const fs = require('fs');
const path = require('path');

class CacheManager {
  constructor(cacheFilePath, seedFilePath) {
    this.cacheFilePath = cacheFilePath;
    this.seedFilePath = seedFilePath;
    this._cache = null;
    this._loaded = false;
  }

  load() {
    if (this._loaded) return;

    let seedData = {};
    let seedMeta = {};
    let userData = {};
    let userMeta = {};

    if (this.seedFilePath && fs.existsSync(this.seedFilePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.seedFilePath, 'utf-8'));
        if (raw.__meta) {
          seedMeta = raw.__meta;
          delete raw.__meta;
        }
        seedData = raw;
      } catch (e) {
        console.error('Failed to load seed cache:', e.message);
      }
    }

    if (fs.existsSync(this.cacheFilePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.cacheFilePath, 'utf-8'));
        if (raw.__meta) {
          userMeta = raw.__meta;
          delete raw.__meta;
        }
        userData = raw;
      } catch (e) {
        console.error('Failed to load user cache:', e.message);
      }
    }

    const merged = {};
    for (const [id, value] of Object.entries(seedData)) {
      merged[id] = this._normalizeEntry(value);
    }

    for (const [id, value] of Object.entries(userData)) {
      const uEntry = this._normalizeEntry(value);
      if (merged[id]) {
        if (uEntry._updated && merged[id]._updated) {
          const uDate = new Date(uEntry._updated);
          const sDate = new Date(merged[id]._updated);
          if (uDate >= sDate) {
            this._mergeEntry(merged[id], uEntry);
            merged[id]._updated = uEntry._updated;
          }
        } else {
          this._mergeEntry(merged[id], uEntry);
          merged[id]._updated = uEntry._updated || merged[id]._updated;
        }
      } else {
        merged[id] = uEntry;
      }
    }

    this._cache = merged;
    this._loaded = true;

    this.save();
  }

  _normalizeEntry(entry) {
    if (typeof entry === 'string') {
      return { name: entry, creator: null, _updated: null };
    }
    if (entry && typeof entry === 'object') {
      return { name: entry.name || null, creator: entry.creator || null, thumbnailPath: entry.thumbnailPath || null, _updated: entry._updated || null };
    }
    return { name: String(entry), creator: null, _updated: null };
  }

  _mergeEntry(target, source) {
    if (source.name && source.name !== source.id) {
      target.name = source.name;
    }
    if (source.creator) {
      target.creator = source.creator;
    }
    if (source.thumbnailPath) {
      target.thumbnailPath = source.thumbnailPath;
    }
  }

  save() {
    if (!this._cache) return;
    try {
      const dir = path.dirname(this.cacheFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const output = { __meta: { updated: new Date().toISOString().split('T')[0] } };
      for (const [id, entry] of Object.entries(this._cache)) {
        output[id] = { name: entry.name, creator: entry.creator || null, thumbnailPath: entry.thumbnailPath || null, _updated: entry._updated };
      }
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(output, null, 2));
    } catch (e) {
      console.error('Failed to save cache:', e.message);
    }
  }

  get(id) {
    this.load();
    const entry = this._cache[id];
    if (!entry) return null;
    return {
      name: entry.name && entry.name !== id ? entry.name : null,
      creator: entry.creator || null,
      thumbnailPath: entry.thumbnailPath || null
    };
  }

  set(id, name, thumbnailPath, creator) {
    this.load();
    if (!this._cache[id]) {
      this._cache[id] = { name: id, creator: null, thumbnailPath: null, _updated: null };
    }
    if (name && name !== id) {
      this._cache[id].name = name;
    }
    if (creator) {
      this._cache[id].creator = creator;
    }
    if (thumbnailPath) {
      this._cache[id].thumbnailPath = thumbnailPath;
    }
    this._cache[id]._updated = new Date().toISOString().split('T')[0];
    this.save();
  }

  setThumbnail(id, thumbnailPath) {
    this.load();
    if (!this._cache[id]) {
      this._cache[id] = { name: id, thumbnailPath: null, _updated: null };
    }
    this._cache[id].thumbnailPath = thumbnailPath;
    this._cache[id]._updated = new Date().toISOString().split('T')[0];
    this.save();
  }

  getAll() {
    this.load();
    return this._cache;
  }

  getSummary() {
    this.load();
    let total = 0;
    let withThumbnail = 0;
    const names = {};

    for (const [id, entry] of Object.entries(this._cache)) {
      total++;
      if (entry.thumbnailPath) withThumbnail++;
      names[id] = entry.name || id;
    }

    return { total, withThumbnail, names };
  }

  getCacheJson() {
    this.load();
    return { names: this._cache };
  }
}

module.exports = { CacheManager };
