let mainWindow = null;

function setMainWindow(win) {
  mainWindow = win;
}

function getMainWindow() {
  return mainWindow;
}

module.exports = { setMainWindow, getMainWindow };
