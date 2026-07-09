const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WTD_APP_ID = '1787910';

function getSteamPath() {
  try {
    const result = execSync(
      'powershell -NoProfile -Command "(Get-ItemProperty \'HKCU:\\Software\\Valve\\Steam\' -Name SteamPath -ErrorAction Stop).SteamPath"',
      { encoding: 'utf-8', timeout: 5000 }
    );
    return result.trim();
  } catch {
    return null;
  }
}

function getLibraryFolders(steamPath) {
  const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  if (!fs.existsSync(vdfPath)) return [steamPath];

  const libraries = [steamPath];
  try {
    const content = fs.readFileSync(vdfPath, 'utf-8');
    const re = /"path"\s+"([^"]+)"/g;
    let match;
    while ((match = re.exec(content)) !== null) {
      const libPath = match[1].replace(/\\\\/g, '\\');
      if (!libraries.includes(libPath)) {
        libraries.push(libPath);
      }
    }
  } catch {
    // fallback to just the main steam path
  }
  return libraries;
}

function detectGamePath() {
  const steamPath = getSteamPath();
  if (!steamPath) return null;

  const libraries = getLibraryFolders(steamPath);
  for (const lib of libraries) {
    const manifestPath = path.join(lib, 'steamapps', `appmanifest_${WTD_APP_ID}.acf`);
    if (fs.existsSync(manifestPath)) {
      try {
        const content = fs.readFileSync(manifestPath, 'utf-8');
        const match = content.match(/"installdir"\s+"([^"]+)"/);
        if (match) {
          const installDir = match[1];
          const gamePath = path.join(lib, 'steamapps', 'common', installDir);
          if (fs.existsSync(gamePath)) {
            return gamePath;
          }
        }
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function detectSavePath() {
  const localLow = path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    'AppData', 'LocalLow', 'Wide Right Interactive', 'WhatTheDub'
  );
  if (fs.existsSync(localLow)) {
    return localLow;
  }
  return null;
}

function isGameRunning() {
  try {
    const result = execSync('tasklist /FI "IMAGENAME eq WhatTheDub.exe" /NH', {
      encoding: 'utf-8',
      timeout: 5000
    });
    return result.includes('WhatTheDub.exe');
  } catch {
    return false;
  }
}

module.exports = { detectGamePath, detectSavePath, isGameRunning };
