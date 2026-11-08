// SPDX-License-Identifier: AGPL-3.0-or-later
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {Readable} = require('node:stream');
const test = require('node:test');
const runtime = require('./encoder-runtime.cjs');

const PINNED_SHA256 = '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00';
const CONFIG = {backend: 'nvenc', width: 320, height: 180, frameRate: 30, bitrate: 1000000};
const CHANNEL = 'dxd-native-encoder:';
const source = fs.readFileSync(path.join(__dirname, 'native-encoder-main.cjs'), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

class Owner extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.mainFrame = {url: 'fluxer-app://app/index.html'};
    this.sent = [];
    this.destroyed = false;
  }
  isDestroyed() { return this.destroyed; }
  send(channel, payload) {
    this.sent.push({channel, payload});
    this.emit('sent', channel, payload);
  }
}

function harness(t, options = {}) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(temporaryRoot, 'dxd-native-main-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(profile)), temporaryRoot);
    assert.ok(path.basename(profile).startsWith('dxd-native-main-'));
    fs.rmSync(profile, {recursive: true, force: true});
  });
  const binary = path.join(profile, 'native-encoders', 'b6.1.1', 'ffmpeg.exe');
  const settings = path.join(profile, 'dxd-native-encoder.json');
  if (options.cached !== false) {
    fs.mkdirSync(path.dirname(binary), {recursive: true});
    if (options.realRuntime) fs.copyFileSync(process.env.DXD_TEST_FFMPEG, binary);
    else fs.writeFileSync(binary, 'cached binary fixture');
  }
  const handlers = new Map();
  const listeners = new Map();
  const instances = [];
  const probes = [];
  const dialogs = [];
  let networkCalls = 0;
  class FakeEncoder extends EventEmitter {
    constructor(configuration) {
      super();
      this.options = configuration;
      this.frames = [];
      this.stopCount = 0;
      instances.push(this);
      options.created?.(this);
    }
    async start() { await options.startEncoder?.(this); }
    async waitForCapacity() {}
    async writeFrame(frame) { this.frames.push(frame); }
    async stop() { this.stopCount++; }
  }
  const app = new EventEmitter();
  app.getPath = name => { assert.equal(name, 'userData'); return profile; };
  app.getGPUInfo = async kind => {
    assert.equal(kind, 'basic');
    return {gpuDevice: options.gpus ?? [{vendorId: 0x10de, active: true}]};
  };
  const electron = {
    app,
    ipcMain: {
      handle(channel, handler) { assert.ok(!handlers.has(channel)); handlers.set(channel, handler); },
      on(channel, listener) { assert.ok(!listeners.has(channel)); listeners.set(channel, listener); },
    },
    BrowserWindow: {fromWebContents: owner => owner},
    dialog: {showMessageBox: async (owner, detail) => { dialogs.push({owner, detail}); }},
  };
  const filesystem = {...fs, createReadStream(file, ...args) {
    if (file === binary && options.hashGate) return Readable.from((async function* () {
      options.hashStarted?.resolve();
      await options.hashGate.promise;
      yield Buffer.from('cached binary fixture');
    })());
    return fs.createReadStream(file, ...args);
  }};
  const requireMock = name => {
    if (name === 'electron') return electron;
    if (name === './encoder-runtime.cjs') return options.realRuntime ? runtime : {NativeEncoderSession: FakeEncoder};
    if (name === 'node:fs') return filesystem;
    if (name === 'node:crypto' && !options.realHash && !options.realRuntime) return {
      randomUUID: crypto.randomUUID,
      createHash: () => ({update() {}, digest: () => PINNED_SHA256}),
    };
    if (name === 'node:child_process') return {execFile(binaryName, args, flags, callback) {
      probes.push({binaryName, args, flags});
      if (options.realRuntime) return require('node:child_process').execFile(binaryName, args, flags, callback);
      if (options.probe) options.probe(callback);
      else queueMicrotask(() => callback(null, '', ''));
    }};
    return require(name);
  };
  const module = {exports: {}};
  const context = vm.createContext({
    require: requireMock, module, exports: module.exports, Buffer, ArrayBuffer,
    process: {platform: 'win32', arch: 'x64'}, AbortSignal,
    fetch: async (...args) => {
      networkCalls++;
      if (!options.fetch) throw new Error('Network access is forbidden in this test');
      return options.fetch(...args);
    },
    console: {info() {}},
  });
  new vm.Script(source, {filename: 'native-encoder-main.cjs'}).runInContext(context);
  module.exports.register();
  module.exports.register();
  const invoke = (owner, name, ...args) => Promise.resolve().then(() => handlers.get(CHANNEL + name)({sender: owner, senderFrame: owner.mainFrame}, ...args));
  const initialBackend = (owner, frame = owner.mainFrame) => {
    const event = {sender: owner, senderFrame: frame};
    listeners.get(CHANNEL + 'initial-backend')(event);
    return event.returnValue;
  };
  t.after(() => app.emit('before-quit'));
  return {profile, binary, settings, handlers, listeners, instances, probes, dialogs, app, invoke, initialBackend, networkCalls: () => networkCalls};
}

test('IPC registration is idempotent and every handler rejects remote documents and iframes', async t => {
  const h = harness(t);
  assert.equal(h.handlers.size, 6);
  assert.equal(h.listeners.size, 1);
  const owner = new Owner(1);
  for (const url of ['https://example.com/', 'fluxer-app://app.evil/index.html', 'fluxer-app://app@evil/index.html']) {
    owner.mainFrame.url = url;
    for (const handler of h.handlers.values()) await assert.rejects(Promise.resolve().then(() => handler({sender: owner, senderFrame: owner.mainFrame})), /trusted DxD main window/);
  }
  owner.mainFrame.url = 'fluxer-app://app/index.html';
  for (const handler of h.handlers.values()) await assert.rejects(Promise.resolve().then(() => handler({sender: owner, senderFrame: {url: owner.mainFrame.url}})), /trusted DxD main window/);
  assert.equal(h.probes.length, 0);
  assert.equal(h.networkCalls(), 0);
  assert.equal(h.dialogs.length, 0);
});

test('initial backend is synchronous and fails closed for remote frames, iframes and invalid settings', t => {
  const h = harness(t, {cached: false});
  const owner = new Owner(1);
  assert.equal(h.initialBackend(owner), 'auto');
  for (const backend of ['nvenc', 'amf', 'auto']) {
    fs.writeFileSync(h.settings, JSON.stringify({backend}));
    assert.equal(h.initialBackend(owner), backend);
  }
  fs.writeFileSync(h.settings, JSON.stringify({backend: 'nvenc'}));
  for (const url of ['https://example.com/', 'fluxer-app://app.evil/index.html', 'fluxer-app://app@evil/index.html']) {
    owner.mainFrame.url = url;
    assert.equal(h.initialBackend(owner), 'auto');
  }
  owner.mainFrame.url = 'fluxer-app://app/index.html';
  assert.equal(h.initialBackend(owner, {url: owner.mainFrame.url}), 'auto');
  assert.equal(h.initialBackend(owner, null), 'auto');
  fs.writeFileSync(h.settings, JSON.stringify({backend: 'software'}));
  assert.equal(h.initialBackend(owner), 'auto');
  fs.writeFileSync(h.settings, '{broken');
  assert.equal(h.initialBackend(owner), 'auto');
  assert.equal(h.networkCalls(), 0);
  assert.equal(h.probes.length, 0);
});

test('successful selections notify the requesting owner only after persistence', async t => {
  const h = harness(t);
  const owner = new Owner(1);
  const other = new Owner(2);
  await assert.rejects(h.invoke(owner, 'select', 'software'), /Unknown native video encoder/);
  assert.equal(owner.sent.length, 0);
  for (const backend of ['nvenc', 'auto']) {
    const selected = await h.invoke(owner, 'select', backend);
    const notification = owner.sent.at(-1);
    assert.equal(notification.channel, CHANNEL + 'settings-changed');
    assert.equal(notification.payload, selected);
    assert.equal(notification.payload.backend, backend);
    assert.equal(h.initialBackend(owner), backend);
    assert.equal(JSON.parse(fs.readFileSync(h.settings, 'utf8')).backend, backend);
  }
  assert.equal(owner.sent.length, 2);
  assert.equal(other.sent.length, 0);
});

test('settings default safely and Automatic persists without installing or probing', async t => {
  const h = harness(t, {cached: false, gpus: [{vendorId: 0x10de}, {vendorId: 0x1002}]});
  const owner = new Owner(1);
  const initial = await h.invoke(owner, 'settings');
  assert.equal(initial.backend, 'auto');
  assert.equal(initial.installed, false);
  assert.equal(initial.backends.nvenc, true);
  assert.equal(initial.backends.amf, true);
  fs.writeFileSync(h.settings, '{malformed');
  assert.equal((await h.invoke(owner, 'settings')).backend, 'auto');
  fs.writeFileSync(h.settings, JSON.stringify({backend: 'software'}));
  assert.equal((await h.invoke(owner, 'settings')).backend, 'auto');
  await assert.rejects(h.invoke(owner, 'select', 'software'), /Unknown native video encoder/);
  assert.equal((await h.invoke(owner, 'select', 'auto')).backend, 'auto');
  assert.deepEqual(JSON.parse(fs.readFileSync(h.settings, 'utf8')), {backend: 'auto'});
  assert.equal(h.probes.length, 0);
  assert.equal(h.networkCalls(), 0);
});

test('native selection probes the exact backend and refuses unavailable GPUs or drivers', async t => {
  const noGpu = harness(t, {gpus: []});
  const owner = new Owner(1);
  await assert.rejects(noGpu.invoke(owner, 'select', 'nvenc'), /selected GPU is not available/);
  assert.equal(noGpu.probes.length, 0);
  const driver = harness(t, {probe(callback) {
    const error = new Error('encoder initialization failed');
    error.stderr = 'DLL amfrt64.dll failed to open';
    queueMicrotask(() => callback(error));
  }, gpus: [{vendorId: 0x1002}]});
  await assert.rejects(driver.invoke(owner, 'select', 'amf'), /AMD AMF.*amfrt64.dll failed to open/);
  assert.equal((await driver.invoke(owner, 'settings')).backend, 'auto');
  assert.ok(driver.probes[0].args.includes('h264_amf'));
  assert.ok(driver.probes[0].args.includes('color=black:size=320x180:rate=30'));
  assert.equal(driver.probes[0].flags.windowsHide, true);
  assert.equal(driver.probes[0].flags.timeout, 15000);
  const available = harness(t);
  assert.equal((await available.invoke(owner, 'select', 'nvenc')).backend, 'nvenc');
  assert.ok(available.probes[0].args.includes('h264_nvenc'));
  assert.equal(available.networkCalls(), 0);
});

test('corrupt downloads and cached binaries cannot reach an encoder process', async t => {
  for (const cached of [false, true]) {
    const h = harness(t, {cached, realHash: true, fetch: async () => new Response('tampered archive', {status: 200})});
    await assert.rejects(h.invoke(new Owner(1), 'select', 'nvenc'), /archive checksum failed/);
    assert.equal(h.networkCalls(), 1);
    assert.equal(h.probes.length, 0);
    assert.equal(fs.existsSync(h.settings), false);
    assert.deepEqual(fs.readdirSync(path.dirname(h.binary)), cached ? ['ffmpeg.exe'] : []);
  }
});

test('a newer Automatic selection cannot be overwritten by a delayed driver probe', async t => {
  const probeStarted = deferred();
  let completeProbe;
  const h = harness(t, {probe(callback) { completeProbe = callback; probeStarted.resolve(); }});
  const owner = new Owner(1);
  const selection = h.invoke(owner, 'select', 'nvenc');
  const superseded = assert.rejects(selection, /newer encoder selection superseded/);
  await probeStarted.promise;
  await h.invoke(owner, 'select', 'auto');
  completeProbe(null, '', '');
  await superseded;
  assert.equal(JSON.parse(fs.readFileSync(h.settings, 'utf8')).backend, 'auto');
});

test('sessions enforce owner and ID isolation, drop late output, and clean up on navigation', async t => {
  const h = harness(t);
  const owner = new Owner(1);
  const other = new Owner(2);
  await h.invoke(owner, 'select', 'nvenc');
  owner.sent.length = 0;
  const first = await h.invoke(owner, 'start', CONFIG);
  const secondOwner = await h.invoke(other, 'start', CONFIG);
  const raw = {data: new ArrayBuffer(320 * 180 * 4), timestamp: 123};
  await h.invoke(owner, 'frame', first.id, raw);
  assert.equal(h.instances[0].frames[0].timestamp, 123);
  await assert.rejects(h.invoke(other, 'frame', first.id, raw), /session has ended/);
  await h.invoke(other, 'stop', first.id);
  assert.equal(h.instances[0].stopCount, 0);
  assert.equal(h.instances[1].stopCount, 0);
  const replacement = await h.invoke(owner, 'start', CONFIG);
  assert.equal(h.instances[0].stopCount, 1);
  await h.invoke(owner, 'stop', first.id);
  assert.equal(h.instances[2].stopCount, 0, 'stale stop cannot stop the replacement');
  await assert.rejects(h.invoke(owner, 'frame', first.id, raw), /session has ended/);
  const frame = {data: Buffer.from([0, 0, 1, 5]), timestamp: 100, width: 320, height: 180, keyframe: true};
  h.instances[0].emit('frame', frame);
  assert.equal(owner.sent.length, 0);
  h.instances[2].emit('frame', frame);
  assert.equal(owner.sent[0].payload.id, replacement.id);
  assert.equal(owner.sent[0].payload.data.byteLength, frame.data.length);
  owner.emit('did-start-navigation', {}, owner.mainFrame.url, true, true);
  assert.equal(h.instances[2].stopCount, 0, 'same-document navigation preserves capture');
  owner.emit('did-start-navigation', {}, owner.mainFrame.url, false, true);
  assert.equal(h.instances[2].stopCount, 1);
  await assert.rejects(h.invoke(owner, 'frame', replacement.id, raw), /session has ended/);
  other.destroyed = true;
  other.emit('destroyed');
  assert.equal(h.instances[1].stopCount, 1);
  await h.invoke(other, 'stop', secondOwner.id);
});

test('reload, crash and destroy cancel a start awaiting binary verification', async t => {
  for (const cancellation of ['reload', 'crash', 'destroy']) {
    const hashGate = deferred();
    const hashStarted = deferred();
    const h = harness(t, {hashGate, hashStarted});
    fs.writeFileSync(h.settings, JSON.stringify({backend: 'nvenc'}));
    const owner = new Owner(1);
    const pending = h.invoke(owner, 'start', CONFIG);
    const rejected = assert.rejects(pending, /request was cancelled/, cancellation);
    await hashStarted.promise;
    if (cancellation === 'reload') owner.emit('did-start-navigation', {}, owner.mainFrame.url, false, true);
    if (cancellation === 'crash') owner.emit('render-process-gone');
    if (cancellation === 'destroy') { owner.destroyed = true; owner.emit('destroyed'); }
    hashGate.resolve();
    await rejected;
    assert.equal(h.instances.length, 0, cancellation);
  }
});

test('an active native backend can reconnect after the next-share preference changes', async t => {
  const h = harness(t);
  const owner = new Owner(1);
  await h.invoke(owner, 'select', 'nvenc');
  const first = await h.invoke(owner, 'start', CONFIG);
  await h.invoke(owner, 'select', 'auto');
  const replacement = await h.invoke(owner, 'start', CONFIG);
  assert.notEqual(first.id, replacement.id);
  assert.equal(h.instances[1].options.backend, 'nvenc');
  assert.equal((await h.invoke(owner, 'settings')).backend, 'auto');
  await assert.rejects(h.invoke(owner, 'start', {...CONFIG, backend: 'software'}), /Unknown native video encoder/);
  await h.invoke(owner, 'stop', replacement.id);
});

test('starts serialize per owner and application shutdown stops every active owner', async t => {
  const firstCreated = deferred();
  const firstStart = deferred();
  let count = 0;
  const h = harness(t, {startEncoder() {
    if (++count === 1) { firstCreated.resolve(); return firstStart.promise; }
  }});
  fs.writeFileSync(h.settings, JSON.stringify({backend: 'nvenc'}));
  const owner = new Owner(1);
  const pending = h.invoke(owner, 'start', CONFIG);
  await firstCreated.promise;
  const next = h.invoke(owner, 'start', CONFIG);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.instances.length, 1);
  firstStart.resolve();
  await Promise.all([pending, next]);
  assert.equal(h.instances.length, 2);
  assert.equal(h.instances[0].stopCount, 1);
  await h.invoke(new Owner(2), 'start', CONFIG);
  h.app.emit('before-quit');
  assert.ok(h.instances.every(encoder => encoder.stopCount === 1));
});

test('optional cached real NVENC uses synthetic frames with actual IPC session ownership', {skip: !process.env.DXD_TEST_FFMPEG}, async t => {
  const h = harness(t, {realRuntime: true});
  const owner = new Owner(1);
  const selected = await h.invoke(owner, 'select', 'nvenc');
  assert.equal(selected.backend, 'nvenc');
  assert.ok(h.probes[0].args.includes('color=black:size=320x180:rate=30'));
  const current = await h.invoke(owner, 'start', CONFIG);
  const firstFrame = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No encoded IPC frame arrived')), 4000);
    owner.on('sent', (channel, payload) => {
      if (channel === CHANNEL + 'frame') { clearTimeout(timeout); resolve(payload); }
      if (channel === CHANNEL + 'end') { clearTimeout(timeout); reject(new Error(payload.error)); }
    });
  });
  const bytes = new ArrayBuffer(320 * 180 * 4);
  new Uint8Array(bytes).fill(128);
  await assert.rejects(h.invoke(new Owner(2), 'frame', current.id, {data: bytes, timestamp: 0}), /session has ended/);
  for (let index = 0; index < 4; index++) await h.invoke(owner, 'frame', current.id, {data: bytes, timestamp: index * 33333});
  const encoded = await firstFrame;
  assert.equal(encoded.id, current.id);
  assert.equal(encoded.timestamp, 0);
  assert.equal(encoded.width, 320);
  assert.equal(encoded.height, 180);
  assert.equal(encoded.keyframe, true);
  assert.ok(encoded.data.byteLength > 0);
  assert.equal(h.networkCalls(), 0);
  await h.invoke(owner, 'stop', current.id);
  await assert.rejects(h.invoke(owner, 'frame', current.id, {data: bytes, timestamp: 999999}), /session has ended/);
});
