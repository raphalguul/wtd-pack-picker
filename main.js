const { app, BrowserWindow } = require('electron');
const path = require('path');
const { setMainWindow } = require('./lib/app-window');
const updater = require('./lib/updater');

// Start the Express server (listens on port 4500) and read persisted settings.
const server = require('./server');
const settings = server.getSettings();
server.setQuitHandler(() => app.quit());

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    fullscreen: !!settings.fullscreen,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    title: 'WTD Pack Picker',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  setMainWindow(win);

  const load = () => {
    win.loadURL('http://localhost:4500').catch(() => {
      setTimeout(load, 500);
    });
  };
  load();

  win.on('closed', () => app.quit());
}

app.whenReady().then(() => {
  createWindow();
  updater.init();

  if (app.isPackaged) {
    setTimeout(() => updater.check({ silent: true }), 3000);
  }
});

app.on('window-all-closed', () => app.quit());
