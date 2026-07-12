const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const multer = require('multer');
const { detectGamePath, detectSavePath, isGameRunning } = require('./lib/steam-detector');
const { readSave, writeSave } = require('./lib/save-bridge');
const { listClips, extractClip, extractAllClips, replaceClip, replaceBatch, restoreBundle } = require('./lib/audio-bridge');
const { WorkshopFetcher } = require('./lib/workshop-fetcher');
const { CacheManager } = require('./lib/cache-manager');
const { PresetManager } = require('./lib/presets');
const { findLocalThumbnail, findWorkshopDirs } = require('./lib/thumbnail-scanner');

const app = express();
app.use(express.json());

const uploadDir = path.join(os.tmpdir(), 'wtd-uploads');
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 100 * 1024 * 1024 }
});
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const PORT = process.env.PORT || 4500;

const userDataDir = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || __dirname, 'wtd-clip-picker');
if (!fs.existsSync(userDataDir)) {
  fs.mkdirSync(userDataDir, { recursive: true });
}

function getThumbnailDir() {
  const dir = path.join(userDataDir, 'thumbs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const cacheFilePath = path.join(userDataDir, 'wtd-workshop-names.json');
const presetsFilePath = path.join(userDataDir, 'presets.json');
const settingsFilePath = path.join(userDataDir, 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(settingsFilePath)) {
      return JSON.parse(fs.readFileSync(settingsFilePath, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveSettings(s) {
  fs.writeFileSync(settingsFilePath, JSON.stringify(s, null, 2));
}

let settings = loadSettings();
if (settings.offlineMode === undefined) {
  settings.offlineMode = true;
  saveSettings(settings);
}

let seedPath = path.join(__dirname, 'workshop-names.json');
if (process.resourcesPath) {
  const alt = path.join(process.resourcesPath, 'workshop-names.json');
  if (fs.existsSync(alt)) seedPath = alt;
}
let cacheManager = new CacheManager(cacheFilePath, seedPath);
let presetManager = new PresetManager(presetsFilePath);
let workshopFetcher = new WorkshopFetcher(cacheManager, getThumbnailDir());
workshopFetcher.setOffline(settings.offlineMode);

workshopFetcher.on('name-resolved', ({ id, name }) => {
  io && io.emit('name-resolved', { id, name });
});

function getGamePath() {
  let gp = settings.gamePath;
  if (!gp) {
    gp = detectGamePath();
    if (gp) {
      settings.gamePath = gp;
      saveSettings(settings);
    }
  }
  return gp;
}

function getSavePaths() {
  const saveDir = detectSavePath();
  if (!saveDir || !fs.existsSync(saveDir)) return [];

  const result = [];
  try {
    const entries = fs.readdirSync(saveDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const saveFile = path.join(saveDir, entry.name, 'save_data.sav');
        if (fs.existsSync(saveFile)) {
          result.push({ steamId: entry.name, path: saveFile, label: entry.name });
        }
      }
    }
  } catch (e) {
    console.error('Failed to scan save directory:', e.message);
  }
  return result;
}

function getWorkshopDir() {
  if (settings.workshopPath && fs.existsSync(settings.workshopPath)) {
    return settings.workshopPath;
  }

  const dirs = findWorkshopDirs();
  let best = null;
  let bestCount = 0;

  for (const d of dirs) {
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      const count = entries.filter(e => e.isDirectory() && /^\d+$/.test(e.name)).length;
      if (count > bestCount) {
        bestCount = count;
        best = d;
      }
    } catch {}
  }

  return best;
}

function scanLocalWorkshopPacks(wsDir) {
  if (!wsDir || !fs.existsSync(wsDir)) return [];

  const packs = [];
  try {
    const entries = fs.readdirSync(wsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && /^\d+$/.test(entry.name)) {
        const cached = cacheManager.get(entry.name);
        packs.push({
          id: entry.name,
          name: (cached && cached.name) ? cached.name : null,
          thumbnailPath: (cached && cached.thumbnailPath) ? cached.thumbnailPath : null,
          isDefault: false,
        });
      }
    }
  } catch (e) {
    console.error('Failed to scan workshop dir:', e.message);
  }

  const defaultPack = {
    id: 'default',
    name: 'Default (Built-in)',
    thumbnailPath: null,
    isDefault: true,
  };

  return [defaultPack, ...packs.sort((a, b) => {
    const na = (a.name || a.id).toLowerCase();
    const nb = (b.name || b.id).toLowerCase();
    return na.localeCompare(nb);
  })];
}

function resolveLocalThumbnails(packs, wsDir, thumbDir) {
  for (const pack of packs) {
    if (pack.thumbnailPath || pack.isDefault) continue;

    const src = findLocalThumbnail(pack.id, [wsDir]);
    if (src) {
      const ext = path.extname(src);
      const dest = path.join(thumbDir, pack.id + ext);
      try {
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(src, dest);
        }
        pack.thumbnailPath = pack.id + ext;
        cacheManager.setThumbnail(pack.id, pack.thumbnailPath);
      } catch {}
    }
  }
}

async function resolvePacksWithSave(steamId) {
  const wsDir = getWorkshopDir();
  const packs = scanLocalWorkshopPacks(wsDir);

  const thumbDir = getThumbnailDir();
  resolveLocalThumbnails(packs, wsDir, thumbDir);

  let disabledSet = new Set();

  if (steamId) {
    const saves = getSavePaths();
    const saveEntry = saves.find(s => s.steamId === steamId);
    if (saveEntry) {
      const gamePath = getGamePath();
      if (gamePath) {
        try {
          const data = await readSave(saveEntry.path, gamePath);
          for (const id of (data.disabledClipPacks || [])) {
            disabledSet.add(id);
          }
        } catch (e) {
          console.error('Failed to read save for disabled state:', e.message);
        }
      }
    }
  }

  for (const pack of packs) {
    pack.enabled = !disabledSet.has(pack.id);
  }

  const unknownIds = packs.filter(p => !p.name && !p.isDefault).map(p => p.id);
  if (unknownIds.length > 0 && !settings.offlineMode) {
    workshopFetcher.queueIds(unknownIds);
  }

  return packs;
}

// Serve static
app.use('/renderer', express.static(path.join(__dirname, 'renderer')));
app.use('/thumbs', express.static(getThumbnailDir()));

// API
app.get('/api/status', (req, res) => {
  const gp = getGamePath();
  const detected = detectGamePath();
  res.json({
    gamePath: gp,
    gamePathValid: gp && fs.existsSync(gp),
    gamePathDetected: detected,
    saves: getSavePaths(),
    gameRunning: isGameRunning(),
    offlineMode: settings.offlineMode,
    workshopPath: settings.workshopPath || null,
    workshopDir: getWorkshopDir(),
  });
});

app.post('/api/settings', (req, res) => {
  if (req.body.gamePath !== undefined) {
    settings.gamePath = req.body.gamePath;
  }
  if (req.body.offlineMode !== undefined) {
    const wasOffline = settings.offlineMode;
    settings.offlineMode = !!req.body.offlineMode;
    workshopFetcher.setOffline(settings.offlineMode);
    if (wasOffline && !settings.offlineMode) {
      const wsDir = getWorkshopDir();
      if (wsDir) {
        const packs = scanLocalWorkshopPacks(wsDir);
        const unknownIds = packs.filter(p => !p.name && !p.isDefault).map(p => p.id);
        if (unknownIds.length > 0) {
          workshopFetcher.queueIds(unknownIds);
        }
      }
    }
  }
  if (req.body.workshopPath !== undefined) {
    settings.workshopPath = req.body.workshopPath || null;
  }
  saveSettings(settings);
  res.json({ success: true, offlineMode: settings.offlineMode });
});

app.get('/api/local-packs/:steamId', async (req, res) => {
  try {
    const packs = await resolvePacksWithSave(req.params.steamId);
    res.json(packs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/write-save/:steamId', async (req, res) => {
  try {
    if (isGameRunning()) {
      return res.status(409).json({ error: 'Game is running. Close it first.' });
    }

    const saves = getSavePaths();
    const saveEntry = saves.find(s => s.steamId === req.params.steamId);
    if (!saveEntry) return res.status(404).json({ error: 'Save not found' });

    const gamePath = getGamePath();
    if (!gamePath) return res.status(400).json({ error: 'Game path not configured' });

    let { disabledClipPacks } = req.body;
    if (!Array.isArray(disabledClipPacks)) {
      return res.status(400).json({ error: 'disabledClipPacks must be an array' });
    }

    // Preserve uninstalled pack IDs that the game still references
    try {
      const currentData = await readSave(saveEntry.path, gamePath);
      const currentDisabled = currentData.disabledClipPacks || [];
      const wsDir = getWorkshopDir();
      const localIds = new Set();
      if (wsDir && fs.existsSync(wsDir)) {
        const entries = fs.readdirSync(wsDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && /^\d+$/.test(e.name)) localIds.add(e.name);
        }
      }
      for (const id of currentDisabled) {
        if (id === 'default') continue;
        if (!localIds.has(id) && !disabledClipPacks.includes(id)) {
          disabledClipPacks.push(id);
        }
      }
    } catch {}

    const result = await writeSave(saveEntry.path, gamePath, disabledClipPacks);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/presets', (req, res) => {
  res.json(presetManager.getAll());
});

app.post('/api/presets', (req, res) => {
  const { name, disabledClipPacks } = req.body;
  if (!name || !Array.isArray(disabledClipPacks)) {
    return res.status(400).json({ error: 'Invalid preset data' });
  }
  presetManager.save(name, disabledClipPacks);
  res.json(presetManager.getAll());
});

app.delete('/api/presets/:name', (req, res) => {
  presetManager.delete(req.params.name);
  res.json(presetManager.getAll());
});

app.get('/api/fetcher-status', (req, res) => {
  res.json(workshopFetcher.getStatus());
});

app.post('/api/start-game', (req, res) => {
  const gp = getGamePath();
  if (!gp || !fs.existsSync(gp)) {
    return res.status(400).json({ error: 'Game path not configured or not found' });
  }
  const exe = path.join(gp, 'WhatTheDub.exe');
  if (!fs.existsSync(exe)) {
    return res.status(400).json({ error: 'WhatTheDub.exe not found' });
  }
  const { exec } = require('child_process');
  exec(`start "" "${exe}"`, { cwd: gp, windowsHide: true });
  res.json({ success: true });
});

// Music replacement endpoints
app.get('/api/music/clips', async (req, res) => {
  try {
    const gamePath = getGamePath();
    if (!gamePath) return res.status(400).json({ error: 'Game path not configured' });

    const bundlePath = path.join(gamePath, 'WhatTheDub_Data', 'StreamingAssets', 'AssetBundles', 'audio-manager');
    if (!fs.existsSync(bundlePath)) return res.status(404).json({ error: 'Audio bundle not found' });

    const clips = await listClips(gamePath);
    res.json(clips);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/music/replace', upload.single('audioFile'), async (req, res) => {
  try {
    if (isGameRunning()) {
      return res.status(409).json({ error: 'Game is running. Close it first.' });
    }

    const gamePath = getGamePath();
    if (!gamePath) return res.status(400).json({ error: 'Game path not configured' });

    const clipName = req.body.clipName;
    const inputFile = req.file;
    const fade = req.body.fade !== 'false';

    if (!clipName || !inputFile) {
      return res.status(400).json({ error: 'clipName and audioFile are required' });
    }

    const result = await replaceClip(gamePath, clipName, inputFile.path, fade);

    try { fs.unlinkSync(inputFile.path); } catch {}

    res.json(result);
  } catch (e) {
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/music/replace-batch', upload.single('audioFile'), async (req, res) => {
  try {
    if (isGameRunning()) {
      return res.status(409).json({ error: 'Game is running. Close it first.' });
    }

    const gamePath = getGamePath();
    if (!gamePath) return res.status(400).json({ error: 'Game path not configured' });

    const inputFile = req.file;
    if (!inputFile) {
      return res.status(400).json({ error: 'audioFile is required' });
    }

    let clipNames;
    try {
      clipNames = JSON.parse(req.body.clipNames || '[]');
    } catch {
      return res.status(400).json({ error: 'clipNames must be a JSON array of names' });
    }

    let fades = {};
    try {
      fades = JSON.parse(req.body.fades || '{}');
    } catch {}

    if (!Array.isArray(clipNames) || clipNames.length === 0) {
      return res.status(400).json({ error: 'clipNames must be a non-empty array' });
    }

    const replacements = clipNames.map(name => [name, inputFile.path]);
    const result = await replaceBatch(gamePath, replacements, fades);

    try { fs.unlinkSync(inputFile.path); } catch {}

    res.json(result);
  } catch (e) {
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/music/extract', async (req, res) => {
  try {
    const gamePath = getGamePath();
    if (!gamePath) return res.status(400).json({ error: 'Game path not configured' });

    const { clipName, outputPath } = req.body;
    if (!clipName || !outputPath) {
      return res.status(400).json({ error: 'clipName and outputPath are required' });
    }

    const result = await extractClip(gamePath, clipName, outputPath);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/music/restore', async (req, res) => {
  try {
    if (isGameRunning()) {
      return res.status(409).json({ error: 'Game is running. Close it first.' });
    }

    const gamePath = getGamePath();
    if (!gamePath) return res.status(400).json({ error: 'Game path not configured' });

    const result = await restoreBundle(gamePath);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.redirect('/renderer/');
});

const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', () => {});

server.listen(PORT, async () => {
  console.log(`WTD Pack Picker running at http://localhost:${PORT}`);
  console.log(`Offline mode: ${settings.offlineMode ? 'ON' : 'OFF'}`);
  console.log(`Workshop dir: ${getWorkshopDir() || '(not found)'}`);
  console.log(`Game path: ${getGamePath() || '(not detected)'}`);
  console.log(`Saves found: ${getSavePaths().length}`);
  console.log(`Cache: ${cacheManager.getSummary().total} names cached`);

  // Only auto-open browser when launched directly (not via Electron)
  if (!process.versions.electron) {
    const { exec } = require('child_process');
    exec(`start "" "http://localhost:${PORT}"`, () => {});
  }
});
