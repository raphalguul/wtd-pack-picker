'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const { getMainWindow } = require('./app-window');
const embed = require('./window-embed');
const { isGameRunning } = require('./steam-detector');

let screenApi = null;
let globalShortcutApi = null;
try {
  const electron = require('electron');
  screenApi = electron.screen;
  globalShortcutApi = electron.globalShortcut;
} catch {
  /* not running inside Electron */
}

let io = null;
let session = null;

function setIo(server) {
  io = server;
}

function emit(event, data) {
  try {
    if (io) io.emit(event, data);
  } catch {
    /* ignore */
  }
}

function hwndFromBuffer(buf) {
  if (!buf || !buf.length) return 0;
  if (buf.length >= 8) return Number(buf.readBigUInt64LE(0));
  return buf.readUInt32LE(0);
}

// Physical (not DIP) parent client size, via the native helper so the embedded
// child exactly fills the client area regardless of scaling/rounding.
async function getClientSize(win, hwnd) {
  if (hwnd) {
    const c = await embed.client(hwnd);
    if (c && c.found && c.width > 0 && c.height > 0) {
      return { w: c.width, h: c.height };
    }
  }
  const b = win.getContentBounds();
  return { w: Math.max(1, Math.round(b.width)), h: Math.max(1, Math.round(b.height)) };
}

function isAvailable() {
  return embed.isAvailable();
}

// Electron's fullscreen window can end up a pixel short of the monitor (e.g.
// 1920x1079), which reveals a sliver of an always-on-top taskbar at the bottom.
// Snap the window back to the exact display bounds so the child fully covers it.
function enforceFullBounds(win) {
  if (!screenApi) return;
  try {
    if (!win.isFullScreen()) return;
    const disp = screenApi.getDisplayMatching(win.getBounds());
    const b = win.getBounds();
    const d = disp.bounds;
    if (b.x !== d.x || b.y !== d.y || b.width !== d.width || b.height !== d.height) {
      win.setBounds(d);
    }
  } catch {
    /* ignore */
  }
}

function isEmbedding() {
  return !!session;
}

function isKillHotkeyActive() {
  return !!(session && session.killHotkey);
}

function killGame() {
  execFile('taskkill', ['/IM', 'WhatTheDub.exe', '/F', '/T'], { windowsHide: true }, () => {
    /* ignore errors (e.g. already exited) */
  });
}

// Kill the game and immediately restore the picker instead of waiting for the
// exit-detection grace/two-miss cycle.
function stopGame() {
  killGame();
  stopEmbedded();
}

function registerKillHotkey(accelerator) {
  if (!globalShortcutApi) return false;
  if (!accelerator) return false;
  try {
    const ok = globalShortcutApi.register(accelerator, () => {
      if (session) stopGame();
    });
    if (!ok) console.warn(`Kill hotkey "${accelerator}" could not be registered (already in use?)`);
    return ok;
  } catch (e) {
    console.warn(`Kill hotkey "${accelerator}" is invalid: ${e.message}`);
    return false;
  }
}

function unregisterKillHotkey(accelerator) {
  if (!globalShortcutApi || !accelerator) return;
  try {
    globalShortcutApi.unregister(accelerator);
  } catch {
    /* ignore */
  }
}

// Allows the setting to change while a game is embedded.
function updateKillHotkey(accelerator) {
  if (!session) return;
  unregisterKillHotkey(session.killHotkey);
  session.killHotkey = null;
  if (accelerator && registerKillHotkey(accelerator)) {
    session.killHotkey = accelerator;
  }
}

async function startEmbedded(gamePath, hotkey) {
  const win = getMainWindow();
  if (!win) return { embedded: false, reason: 'no-window' };
  if (session) return { embedded: true, already: true };
  if (!embed.isAvailable()) return { embedded: false, reason: 'helper-missing' };

  const exe = path.join(gamePath, 'WhatTheDub.exe');
  if (!fs.existsSync(exe)) return { embedded: false, reason: 'exe-missing' };

  const hwnd = hwndFromBuffer(win.getNativeWindowHandle());
  const { w, h } = await getClientSize(win, hwnd);

  const child = spawn(
    exe,
    [
      '-parentHWND', String(hwnd),
      '-popupwindow',
      '-screen-fullscreen', '0',
      '-screen-width', String(w),
      '-screen-height', String(h),
    ],
    { cwd: gamePath, detached: false, stdio: 'ignore', windowsHide: false }
  );

  session = {
    child,
    hwnd,
    gamePath,
    embedded: false,
    startedAt: Date.now(),
    killHotkey: null,
    raiseTimer: null,
    keepAliveTimer: null,
    exitTimer: null,
    resizeTimer: null,
    exitMisses: 0,
    onResize: null,
    onFS: null,
    onFocus: null,
  };

  if (hotkey && registerKillHotkey(hotkey)) {
    session.killHotkey = hotkey;
  }

  // Hide the picker UI and black out the window so only the game is visible.
  win.webContents
    .executeJavaScript("document.body.classList.add('embed-mode')")
    .catch(() => {});
  emit('embed-start');

  waitForChild(win);
  startResizeHandling(win);
  startExitDetection();

  return { embedded: true, starting: true };
}

function waitForChild(win) {
  const s = session;
  if (!s) return;

  let tries = 0;

  const attempt = async () => {
    if (session !== s) return; // superseded
    tries++;

    const { w, h } = await getClientSize(win, s.hwnd);
    const res = await embed.raise(s.hwnd, 0, 0, w, h);
    if (session !== s) return;

    if (res && res.found) {
      s.embedded = true;
      enforceFullBounds(win);
      emit('embed-ready', { hwnd: res.hwnd, pid: res.pid });
      startKeepAlive(win);
      return;
    }

    if (tries >= 60) {
      emit('embed-timeout');
      return;
    }

    s.raiseTimer = setTimeout(attempt, 400);
  };

  s.raiseTimer = setTimeout(attempt, 300);
}

// Unity re-lays-out its window after we stop polling; keep re-glueing the child
// to the parent client area so it never drifts a few pixels short.
function startKeepAlive(win) {
  const s = session;
  if (!s) return;

  s.keepAliveTimer = setInterval(async () => {
    if (session !== s || !s.embedded) return;
    enforceFullBounds(win);
    const { w, h } = await getClientSize(win, s.hwnd);
    if (session !== s) return;
    embed.raise(s.hwnd, 0, 0, w, h);
  }, 1000);
}

function startResizeHandling(win) {
  const s = session;
  if (!s) return;

  const reRaise = () => {
    if (session !== s || !s.embedded) return;
    enforceFullBounds(win);
    clearTimeout(s.resizeTimer);
    s.resizeTimer = setTimeout(async () => {
      if (session !== s) return;
      const { w, h } = await getClientSize(win, s.hwnd);
      await embed.raise(s.hwnd, 0, 0, w, h);
    }, 150);
  };

  s.onResize = reRaise;
  s.onFS = reRaise;
  s.onFocus = () => {
    if (session !== s || !s.embedded) return;
    embed.focus(s.hwnd);
  };

  win.on('resize', s.onResize);
  win.on('enter-full-screen', s.onFS);
  win.on('leave-full-screen', s.onFS);
  win.on('focus', s.onFocus);
}

function startExitDetection() {
  const s = session;
  if (!s) return;

  const GRACE_MS = 10000;

  s.exitTimer = setInterval(() => {
    if (session !== s) return;
    if (Date.now() - s.startedAt < GRACE_MS) return;

    if (isGameRunning()) {
      s.exitMisses = 0;
      return;
    }

    s.exitMisses++;
    if (s.exitMisses >= 2) {
      stopEmbedded();
    }
  }, 2000);
}

function stopEmbedded() {
  const win = getMainWindow();
  const s = session;
  session = null;
  if (!s) return;

  clearTimeout(s.raiseTimer);
  clearInterval(s.keepAliveTimer);
  clearInterval(s.exitTimer);
  clearTimeout(s.resizeTimer);

  unregisterKillHotkey(s.killHotkey);

  if (win) {
    if (s.onResize) win.removeListener('resize', s.onResize);
    if (s.onFS) {
      win.removeListener('enter-full-screen', s.onFS);
      win.removeListener('leave-full-screen', s.onFS);
    }
    if (s.onFocus) win.removeListener('focus', s.onFocus);
  }

  // Detach the game window only if it is still alive; if the game has already
  // exited this is a harmless no-op.
  if (s.embedded) {
    embed.detach(s.hwnd).catch(() => {});
  }

  if (win && !win.isDestroyed()) {
    win.webContents
      .executeJavaScript("document.body.classList.remove('embed-mode')")
      .catch(() => {});
  }

  emit('embed-stop');
}

module.exports = { setIo, startEmbedded, stopEmbedded, stopGame, updateKillHotkey, isAvailable, isEmbedding, isKillHotkeyActive };
