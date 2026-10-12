const fs = require('fs');
const path = require('path');

const THUMBNAIL_NAMES = ['preview.jpg', 'preview.png', 'thumbnail.jpg', 'thumbnail.png'];

function findWorkshopDirs() {
  const steamPath = require('./steam-detector').detectGamePath
    ? null
    : null;

  const dirs = [];

  const libraries = getSteamLibraries();
  for (const lib of libraries) {
    const wtdDir = path.join(lib, 'steamapps', 'workshop', 'content', '1495860');
    if (fs.existsSync(wtdDir)) {
      dirs.push(wtdDir);
    }
  }

  return dirs;
}

function getSteamLibraries() {
  try {
    const result = require('child_process').execSync(
      'powershell -NoProfile -Command "(Get-ItemProperty \'HKCU:\\Software\\Valve\\Steam\' -Name SteamPath -ErrorAction Stop).SteamPath"',
      { encoding: 'utf-8', timeout: 5000 }
    );
    const steamPath = result.trim();
    if (!steamPath || !fs.existsSync(steamPath)) return [];

    const libraries = [steamPath];
    const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
    if (fs.existsSync(vdfPath)) {
      const content = fs.readFileSync(vdfPath, 'utf-8');
      const re = /"path"\s+"([^"]+)"/g;
      let match;
      while ((match = re.exec(content)) !== null) {
        const libPath = match[1].replace(/\\\\/g, '\\');
        if (!libraries.includes(libPath) && fs.existsSync(libPath)) {
          libraries.push(libPath);
        }
      }
    }
    return libraries;
  } catch {
    return [];
  }
}

function findLocalThumbnail(packId, workshopDirs) {
  for (const wsDir of workshopDirs) {
    if (!fs.existsSync(wsDir)) continue;
    const packDir = path.join(wsDir, packId);
    if (!fs.existsSync(packDir)) continue;

    for (const name of THUMBNAIL_NAMES) {
      const thumbPath = path.join(packDir, name);
      if (fs.existsSync(thumbPath)) {
        return thumbPath;
      }
    }
  }
  return null;
}

function copyThumbnail(sourcePath, cacheDir, packId) {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const ext = path.extname(sourcePath);
  const fileName = `${packId}${ext}`;
  const destPath = path.join(cacheDir, fileName);

  if (fs.existsSync(destPath)) {
    return fileName;
  }

  try {
    fs.copyFileSync(sourcePath, destPath);
    return fileName;
  } catch (e) {
    return null;
  }
}

function scanLocalThumbnails(packIds, cacheManager, thumbnailCacheDir) {
  const workshopDirs = findWorkshopDirs();
  let found = 0;
  const resolved = {};

  for (const id of packIds) {
    const entry = cacheManager.get(id);
    if (entry && entry.thumbnailPath) continue;

    const sourcePath = findLocalThumbnail(id, workshopDirs);
    if (sourcePath) {
      const fileName = copyThumbnail(sourcePath, thumbnailCacheDir, id);
      if (fileName) {
        cacheManager.setThumbnail(id, fileName);
        resolved[id] = fileName;
        found++;
      }
    }
  }

  return { found, dirsScanned: workshopDirs.length, resolved };
}

module.exports = { findLocalThumbnail, scanLocalThumbnails, findWorkshopDirs };
