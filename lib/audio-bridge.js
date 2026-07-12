const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

function getHandlerInfo() {
  const devPy = path.join(__dirname, '..', 'audio-handler', 'audio_handler.py');
  if (fs.existsSync(devPy)) {
    return { exe: 'python', baseArgs: [devPy], path: devPy };
  }
  const prodExe = path.join(process.resourcesPath, 'audio-handler', 'audio_handler.exe');
  if (fs.existsSync(prodExe)) {
    return { exe: prodExe, baseArgs: [], path: prodExe };
  }
  throw new Error('audio_handler not found');
}

function getBundlePath(gamePath) {
  return path.join(gamePath, 'WhatTheDub_Data', 'StreamingAssets', 'AssetBundles', 'audio-manager');
}

function execAudioHandler(command, args) {
  return new Promise((resolve, reject) => {
    const { exe, baseArgs } = getHandlerInfo();
    const allArgs = [...baseArgs, command, ...args];

    const child = execFile(exe, allArgs, {
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 50
    }, (err, stdout, stderr) => {
      if (err) {
        const errorMsg = stderr ? stderr.trim() : err.message;
        reject(new Error(`AudioHandler failed: ${errorMsg}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        resolve(result);
      } catch (parseErr) {
        reject(new Error(`Failed to parse AudioHandler output: ${stdout.trim().substring(0, 200)}`));
      }
    });
  });
}

async function listClips(gamePath) {
  const bundlePath = getBundlePath(gamePath);
  return execAudioHandler('list', [bundlePath]);
}

async function extractClip(gamePath, clipName, outputPath) {
  const bundlePath = getBundlePath(gamePath);
  return execAudioHandler('extract', [bundlePath, clipName, outputPath]);
}

async function extractAllClips(gamePath, outputDir) {
  const bundlePath = getBundlePath(gamePath);
  return execAudioHandler('extract-all', [bundlePath, outputDir]);
}

async function replaceClip(gamePath, clipName, inputPath, fade = true) {
  const bundlePath = getBundlePath(gamePath);
  const args = [bundlePath, clipName, inputPath];
  if (!fade) args.push('false');
  return execAudioHandler('replace', args);
}

async function replaceBatch(gamePath, replacements, fades = {}) {
  const bundlePath = getBundlePath(gamePath);
  return execAudioHandler('replace-batch', [bundlePath, JSON.stringify(replacements), JSON.stringify(fades)]);
}

async function restoreBundle(gamePath) {
  const bundlePath = getBundlePath(gamePath);
  return execAudioHandler('restore', [bundlePath]);
}

async function checkFfmpeg() {
  try {
    const result = await execAudioHandler('check-ffmpeg', []);
    return result.available === true;
  } catch {
    return false;
  }
}

module.exports = { listClips, extractClip, extractAllClips, replaceClip, replaceBatch, restoreBundle, checkFfmpeg, getBundlePath };
