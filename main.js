const { app, BrowserWindow } = require('electron');
const path = require('path');

// Start the Express server (listens on port 4500)
require('./server');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    title: 'WTD Pack Picker',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const load = () => {
    win.loadURL('http://localhost:4500').catch(() => {
      setTimeout(load, 500);
    });
  };
  load();

  win.on('closed', () => app.quit());
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => app.quit());
