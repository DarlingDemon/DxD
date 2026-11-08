// SPDX-License-Identifier: AGPL-3.0-or-later
const {app, ipcMain, BrowserWindow, dialog} = require('electron');
const {createHash, randomUUID} = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {Readable, Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {createGunzip} = require('node:zlib');
const {NativeEncoderSession} = require('./encoder-runtime.cjs');

const RELEASE = 'b6.1.1';
const ARCHIVE_URL = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz';
const ARCHIVE_SHA256 = '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77';
const BINARY_SHA256 = '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00';
const BACKENDS = new Set(['auto', 'nvenc', 'amf']);
const sessions = new Map();
const startTasks = new Map();
const watchedOwners = new WeakSet();
const ownerGenerations = new WeakMap();
let installPromise;
let registered = false;
let selectionGeneration = 0;

function directory() {
  return path.join(app.getPath('userData'), 'native-encoders', RELEASE);
}

function binaryPath() {
  return path.join(directory(), 'ffmpeg.exe');
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'dxd-native-encoder.json');
}

function trusted(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || !frame.url.startsWith('fluxer-app://app/')) {
    throw new Error('Native video encoding requires the trusted DxD main window');
  }
}

function selectedBackend() {
  try {
    const value = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).backend;
    return BACKENDS.has(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

async function getSettings() {
  const info = await app.getGPUInfo('basic');
  const devices = info.gpuDevice ?? info.devices ?? [];
  return {
    backend: selectedBackend(),
    installed: fs.existsSync(binaryPath()),
    backends: {
      nvenc: process.platform === 'win32' && devices.some(gpu => gpu.vendorId === 0x10de),
      amf: process.platform === 'win32' && devices.some(gpu => gpu.vendorId === 0x1002),
    },
  };
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function installBinary() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Direct GPU encoders currently require Windows x64');
  }
  const binary = binaryPath();
  if (fs.existsSync(binary) && await hashFile(binary) === BINARY_SHA256) return binary;
  await fsp.mkdir(directory(), {recursive: true});
  const temporary = path.join(directory(), randomUUID());
  const archive = temporary + '.gz';
  const executable = temporary + '.exe';
  try {
    const response = await fetch(ARCHIVE_URL, {signal: AbortSignal.timeout(180000)});
    if (!response.ok || !response.body) throw new Error('Unable to download the native video encoder');
    let received = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        callback(received > 120 * 1024 * 1024 ? new Error('Encoder download exceeds its size limit') : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(archive, {flags: 'wx'}));
    if (await hashFile(archive) !== ARCHIVE_SHA256) throw new Error('Native encoder archive checksum failed');
    await pipeline(fs.createReadStream(archive), createGunzip(), fs.createWriteStream(executable, {flags: 'wx'}));
    if (await hashFile(executable) !== BINARY_SHA256) throw new Error('Native encoder executable checksum failed');
    await fsp.rename(executable, binary);
    return binary;
  } finally {
    await Promise.all([fsp.rm(archive, {force: true}), fsp.rm(executable, {force: true})]);
  }
}

function ensureBinary() {
  installPromise ??= installBinary().finally(() => { installPromise = undefined; });
  return installPromise;
}

async function probeBackend(backend, binary) {
  try {
    await promisify(execFile)(binary, [
      '-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'color=black:size=320x180:rate=30',
      '-frames:v', '2', '-an', '-c:v', backend === 'nvenc' ? 'h264_nvenc' : 'h264_amf',
      '-bf', '0', '-b:v', '1000000', '-f', 'null', '-',
    ], {windowsHide: true, timeout: 15000, maxBuffer: 32768});
  } catch (error) {
    const detail = String(error.stderr ?? error.message).slice(-1500);
    throw new Error(`Cannot start ${backend === 'nvenc' ? 'NVIDIA NVENC' : 'AMD AMF'}. Check the graphics driver. ${detail}`);
  }
}

async function setBackend(value) {
  if (!BACKENDS.has(value)) throw new Error('Unknown native video encoder');
  const generation = ++selectionGeneration;
  const settings = await getSettings();
  if (value !== 'auto') {
    if (!settings.backends[value]) throw new Error('The selected GPU is not available');
    await probeBackend(value, await ensureBinary());
  }
  if (generation !== selectionGeneration) throw new Error('A newer encoder selection superseded this request');
  const temporary = settingsPath() + '.' + randomUUID() + '.tmp';
  try {
    await fsp.writeFile(temporary, JSON.stringify({backend: value}) + '\n', {flag: 'wx'});
    if (generation !== selectionGeneration) throw new Error('A newer encoder selection superseded this request');
    await fsp.rename(temporary, settingsPath());
  } finally {
    await fsp.rm(temporary, {force: true});
  }
  return getSettings();
}

async function stopOwner(ownerId) {
  const current = sessions.get(ownerId);
  if (!current) return;
  sessions.delete(ownerId);
  await current.encoder.stop();
}

function send(owner, channel, payload) {
  if (!owner.isDestroyed()) owner.send(channel, payload);
}

function watchOwner(owner) {
  if (watchedOwners.has(owner)) return;
  watchedOwners.add(owner);
  const stop = () => {
    ownerGenerations.set(owner, (ownerGenerations.get(owner) ?? 0) + 1);
    stopOwner(owner.id).catch(() => {});
  };
  owner.once('destroyed', stop);
  owner.on('render-process-gone', stop);
  owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) stop();
  });
}

async function start(event, options, generation) {
  if (generation !== (ownerGenerations.get(event.sender) ?? 0)) {
    throw new Error('The screen sharing request was cancelled');
  }
  if (!options || !['nvenc', 'amf'].includes(options.backend)) {
    throw new Error('Unknown native video encoder');
  }
  await stopOwner(event.sender.id);
  const binary = await ensureBinary();
  trusted(event);
  if (generation !== (ownerGenerations.get(event.sender) ?? 0)) {
    throw new Error('The screen sharing request was cancelled');
  }
  const encoder = new NativeEncoderSession({
    ffmpegPath: binary,
    backend: options.backend,
    width: options.width,
    height: options.height,
    frameRate: options.frameRate,
    bitrate: options.bitrate,
  });
  const id = randomUUID();
  const current = {id, encoder, owner: event.sender};
  sessions.set(event.sender.id, current);
  watchOwner(event.sender);
  encoder.on('frame', frame => {
    if (sessions.get(event.sender.id) !== current) return;
    send(event.sender, 'dxd-native-encoder:frame', {
      ...frame, id, data: frame.data.buffer.slice(frame.data.byteOffset, frame.data.byteOffset + frame.data.byteLength),
    });
  });
  encoder.on('error', error => {
    if (sessions.get(event.sender.id) !== current) return;
    send(event.sender, 'dxd-native-encoder:end', {id, error: error.message});
    stopOwner(event.sender.id).catch(() => {});
  });
  encoder.on('diagnostic', detail => {
    console.info('[DxD native encoder]', options.backend, detail);
  });
  try {
    await encoder.start();
    return {id};
  } catch (error) {
    await stopOwner(event.sender.id);
    throw error;
  }
}

function ownedSession(event, id) {
  const current = sessions.get(event.sender.id);
  if (!current || current.id !== id) throw new Error('The native encoder session has ended');
  return current;
}

function register() {
  if (registered) return;
  registered = true;
  const handle = (name, callback) => ipcMain.handle('dxd-native-encoder:' + name, (event, ...args) => {
    trusted(event);
    return callback(event, ...args);
  });
  handle('settings', () => getSettings());
  handle('select', async (event, backend) => {
    const settings = await setBackend(backend);
    send(event.sender, 'dxd-native-encoder:settings-changed', settings);
    return settings;
  });
  ipcMain.on('dxd-native-encoder:initial-backend', event => {
    try {
      trusted(event);
      event.returnValue = selectedBackend();
    } catch {
      event.returnValue = 'auto';
    }
  });
  handle('start', (event, options) => {
    watchOwner(event.sender);
    const generation = ownerGenerations.get(event.sender) ?? 0;
    const previous = startTasks.get(event.sender.id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => start(event, options, generation));
    startTasks.set(event.sender.id, task);
    void task.finally(() => {
      if (startTasks.get(event.sender.id) === task) startTasks.delete(event.sender.id);
    }).catch(() => {});
    return task;
  });
  handle('frame', async (event, id, frame) => {
    if (!frame || !(frame.data instanceof ArrayBuffer)) throw new Error('Invalid raw video frame');
    const current = ownedSession(event, id);
    await current.encoder.waitForCapacity();
    await current.encoder.writeFrame({data: Buffer.from(frame.data), timestamp: frame.timestamp});
  });
  handle('stop', async (event, id) => {
    if (sessions.get(event.sender.id)?.id === id) await stopOwner(event.sender.id);
  });
  handle('report-error', (event, message) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner) void dialog.showMessageBox(owner, {
      type: 'error', title: 'DxD Native', message: 'Screen sharing stopped',
      detail: String(message).slice(0, 2000),
    });
  });
  app.once('before-quit', () => {
    for (const ownerId of sessions.keys()) stopOwner(ownerId).catch(() => {});
  });
}

module.exports = {register};
