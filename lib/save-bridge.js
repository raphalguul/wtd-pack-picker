const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

function getSaveHandlerPath() {
  const devPath = path.join(__dirname, '..', 'save-handler', 'bin', 'SaveHandler.exe');
  if (fs.existsSync(devPath)) {
    return devPath;
  }
  const prodPath = path.join(process.resourcesPath, 'save-handler', 'SaveHandler.exe');
  if (fs.existsSync(prodPath)) {
    return prodPath;
  }
  throw new Error('SaveHandler.exe not found. Build it first with: npm run build-save-handler');
}

function execSaveHandler(command, savePath, gamePath, jsonData) {
  return new Promise((resolve, reject) => {
    const handlerPath = getSaveHandlerPath();
    const args = [command, savePath, gamePath];

    const opts = {
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 10
    };

    const child = execFile(handlerPath, args, opts, (err, stdout, stderr) => {
      if (err) {
        const errorMsg = stderr ? stderr.trim() : err.message;
        reject(new Error(`SaveHandler failed: ${errorMsg}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        resolve(result);
      } catch (parseErr) {
        reject(new Error(`Failed to parse SaveHandler output: ${stdout.trim().substring(0, 200)}`));
      }
    });

    if (jsonData) {
      child.stdin.write(jsonData);
      child.stdin.end();
    }
  });
}

async function readSave(savePath, gamePath) {
  return execSaveHandler('read', savePath, gamePath);
}

async function writeSave(savePath, gamePath, disabledClipPacks) {
  const jsonData = JSON.stringify({ disabledClipPacks });
  return execSaveHandler('write', savePath, gamePath, jsonData);
}

module.exports = { readSave, writeSave };
