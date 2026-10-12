'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function getHelperPath() {
  const dev = path.join(__dirname, '..', 'window-embed', 'bin', 'WindowEmbed.exe');
  if (fs.existsSync(dev)) return dev;

  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'window-embed', 'WindowEmbed.exe');
    if (fs.existsSync(packaged)) return packaged;
  }

  return null;
}

function isAvailable() {
  return !!getHelperPath();
}

function run(args, timeout = 5000) {
  return new Promise((resolve) => {
    const helper = getHelperPath();
    if (!helper) return resolve(null);

    execFile(helper, args.map(String), { timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(String(stdout).trim()));
      } catch {
        resolve(null);
      }
    });
  });
}

function find(parentHwnd) {
  return run(['find', parentHwnd]);
}

function raise(parentHwnd, x, y, w, h) {
  return run(['raise', parentHwnd, x, y, w, h]);
}

function client(parentHwnd) {
  return run(['client', parentHwnd]);
}

function rect(parentHwnd) {
  return run(['rect', parentHwnd]);
}

function detach(parentHwnd) {
  return run(['detach', parentHwnd]);
}

function focus(parentHwnd) {
  return run(['focus', parentHwnd]);
}

module.exports = { isAvailable, getHelperPath, find, raise, client, rect, detach, focus };
