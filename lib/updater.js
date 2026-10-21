'use strict';

const { EventEmitter } = require('events');
const { getMainWindow } = require('./app-window');

const events = new EventEmitter();

let autoUpdater = null;
let app = null;
let dialog = null;
let initialized = false;
let checkInFlight = false;
let downloadInFlight = false;
let manualCheck = false;
let lastErrorMessage = null;
let lastErrorAt = 0;

const status = {
  state: 'idle',
  currentVersion: null,
  availableVersion: null,
  percent: 0,
  error: null,
};

function getVersion() {
  if (app) {
    try {
      return app.getVersion();
    } catch {
      /* ignore */
    }
  }
  return require('../package.json').version;
}

function getStatus() {
  return { ...status, currentVersion: getVersion() };
}

function publish(patch) {
  Object.assign(status, patch);
  events.emit('status', getStatus());
}

function showDialog(options) {
  const win = getMainWindow();
  const target = win && !win.isDestroyed() ? win : null;
  return target ? dialog.showMessageBox(target, options) : dialog.showMessageBox(options);
}

function handleError(err) {
  const message = err && err.message ? err.message : String(err);
  const now = Date.now();

  if (message === lastErrorMessage && now - lastErrorAt < 1000) return;
  lastErrorMessage = message;
  lastErrorAt = now;

  console.error('[updater]', message);
  publish({ state: 'error', error: message, percent: 0 });

  if (!manualCheck) return;
  showDialog({
    type: 'error',
    message: 'Update check failed.',
    detail: message,
    buttons: ['OK'],
  }).catch(() => {});
}

async function promptDownload(version) {
  const result = await showDialog({
    type: 'info',
    message: `A new version (v${version}) is available.`,
    detail: 'Do you want to download and install it?',
    buttons: ['Update', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });

  if (result.response !== 0) {
    publish({ state: 'idle' });
    return;
  }

  await startDownload();
}

async function startDownload() {
  if (downloadInFlight) return;
  downloadInFlight = true;
  publish({ state: 'downloading', percent: 0, error: null });

  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    downloadInFlight = false;
    handleError(err);
  }
}

function installNow() {
  publish({ state: 'installing' });
  try {
    require('./game-launcher').stopEmbedded();
  } catch {
    /* game may not be running */
  }
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
}

async function promptRestart(version) {
  const result = await showDialog({
    type: 'info',
    message: `Update downloaded (v${version}).`,
    detail: 'Do you want to restart now?',
    buttons: ['Restart', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });

  if (result.response === 0) installNow();
}

function attachListeners() {
  autoUpdater.on('checking-for-update', () => {
    publish({ state: 'checking', error: null });
  });

  autoUpdater.on('update-available', (info) => {
    publish({ state: 'available', availableVersion: info.version, error: null });
    promptDownload(info.version).catch(handleError);
  });

  autoUpdater.on('update-not-available', () => {
    publish({ state: 'none', error: null });
    if (!manualCheck) return;
    showDialog({
      type: 'info',
      message: 'No updates available.',
      detail: 'You are running the latest version.',
      buttons: ['OK'],
    }).catch(() => {});
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent || 0);
    publish({ state: 'downloading', percent });
    events.emit('progress', percent);
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloadInFlight = false;
    publish({ state: 'downloaded', availableVersion: info.version, percent: 100 });
    promptRestart(info.version).catch(handleError);
  });

  autoUpdater.on('error', handleError);
}

function init() {
  if (initialized) return;
  if (!process.versions.electron) return;

  const electron = require('electron');
  app = electron.app;
  dialog = electron.dialog;

  if (!app.isPackaged) return;

  const { autoUpdater: updater } = require('electron-updater');
  autoUpdater = updater;
  autoUpdater.logger = {
    info: (...args) => console.log('[updater]', ...args),
    warn: (...args) => console.warn('[updater]', ...args),
    error: (...args) => console.error('[updater]', ...args),
    debug: () => {},
  };
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  attachListeners();
  initialized = true;
  publish({ state: 'idle', currentVersion: getVersion() });
}

async function check({ silent = false } = {}) {
  init();

  if (!initialized) {
    const detail = process.versions.electron
      ? 'Update checks are only available in the installed app.'
      : 'Update checks are only available inside the desktop app.';
    publish({ state: 'unsupported', error: detail });
    if (!silent && dialog) {
      showDialog({
        type: 'info',
        message: 'Updates are unavailable.',
        detail,
        buttons: ['OK'],
      }).catch(() => {});
    }
    return getStatus();
  }

  if (checkInFlight || downloadInFlight) return getStatus();

  checkInFlight = true;
  manualCheck = !silent;
  publish({ state: 'checking', error: null, percent: 0 });

  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    handleError(err);
  } finally {
    checkInFlight = false;
  }

  return getStatus();
}

module.exports = {
  events,
  init,
  check,
  installNow,
  getStatus,
  getVersion,
  isSupported: () => !!autoUpdater,
};
