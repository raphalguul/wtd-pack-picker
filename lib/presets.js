const fs = require('fs');
const path = require('path');

class PresetManager {
  constructor(presetsFilePath) {
    this.filePath = presetsFilePath;
    this._presets = [];
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        this._presets = Array.isArray(data) ? data : [];
      }
    } catch (e) {
      console.error('Failed to load presets:', e.message);
      this._presets = [];
    }
  }

  _save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this._presets, null, 2));
    } catch (e) {
      console.error('Failed to save presets:', e.message);
    }
  }

  getAll() {
    return [...this._presets];
  }

  save(name, disabledClipPacks) {
    const existing = this._presets.findIndex(p => p.name === name);
    const preset = {
      name,
      disabledClipPacks,
      updated: new Date().toISOString()
    };
    if (existing >= 0) {
      this._presets[existing] = preset;
    } else {
      this._presets.push(preset);
    }
    this._save();
  }

  delete(name) {
    this._presets = this._presets.filter(p => p.name !== name);
    this._save();
  }
}

module.exports = { PresetManager };
