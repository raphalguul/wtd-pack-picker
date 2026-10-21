'use strict';

const fs = require('fs');
const path = require('path');

const WTD_APP_ID = '1495860';
const STEAM_APPID_FILENAME = 'steam_appid.txt';
const BACKUP_SUFFIX = '.wtdpackpicker.bak';

function getSteamAppIdPath(gamePath) {
  return path.join(gamePath, STEAM_APPID_FILENAME);
}

function getBackupPath(appIdPath) {
  const base = `${appIdPath}${BACKUP_SUFFIX}`;
  if (!fs.existsSync(base)) return base;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${base}.${stamp}`;
}

function writeCanonical(appIdPath) {
  const tempPath = `${appIdPath}.wtdpackpicker.tmp`;
  try {
    fs.writeFileSync(tempPath, WTD_APP_ID, { encoding: 'ascii' });
    fs.renameSync(tempPath, appIdPath);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

// Keep the game in our process tree by preventing SteamAPI from relaunching it
// through Steam. The file is left in place; this only repairs it when missing,
// incorrect, or not in the canonical 7-byte form.
function ensureSteamAppId(gamePath) {
  if (!gamePath) {
    return { ok: false, reason: 'game-path-missing' };
  }

  try {
    if (!fs.statSync(gamePath).isDirectory()) {
      return { ok: false, reason: 'game-path-missing' };
    }
  } catch {
    return { ok: false, reason: 'game-path-missing' };
  }

  const appIdPath = getSteamAppIdPath(gamePath);

  let existing = null;
  try {
    existing = fs.readFileSync(appIdPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return { ok: false, reason: 'read-failed', error: err.message, path: appIdPath };
    }
  }

  if (existing === WTD_APP_ID) {
    return { ok: true, changed: false, path: appIdPath };
  }

  if (existing !== null && existing.trim() === WTD_APP_ID) {
    try {
      writeCanonical(appIdPath);
      return { ok: true, changed: true, path: appIdPath };
    } catch (err) {
      return { ok: false, reason: 'write-failed', error: err.message, path: appIdPath };
    }
  }

  let backup = null;
  if (existing !== null) {
    backup = getBackupPath(appIdPath);
    try {
      fs.renameSync(appIdPath, backup);
    } catch (err) {
      return { ok: false, reason: 'backup-failed', error: err.message, path: appIdPath };
    }
  }

  try {
    writeCanonical(appIdPath);
    return { ok: true, changed: true, path: appIdPath, backup };
  } catch (err) {
    if (backup) {
      try {
        fs.renameSync(backup, appIdPath);
      } catch {
        /* leave the backup in place if restoration fails */
      }
    }
    return { ok: false, reason: 'write-failed', error: err.message, path: appIdPath, backup };
  }
}

module.exports = {
  WTD_APP_ID,
  STEAM_APPID_FILENAME,
  getSteamAppIdPath,
  ensureSteamAppId,
};
