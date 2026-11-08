// SPDX-License-Identifier: AGPL-3.0-or-later
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const {test} = require('node:test');
const rendererPatch = require('./patch-renderer-desktop-update.cjs');

const desktop = process.env.DXD_DESKTOP_SOURCE || path.resolve(__dirname, '../../../dxd-native-source/fluxer_desktop');
const available = fs.existsSync(path.join(desktop, 'src/main/DxDUpdater.ts'));
const esbuild = available ? require(path.join(desktop, 'node_modules/esbuild')) : null;
const read = name => fs.readFileSync(path.join(desktop, 'src/main', name + '.ts'), 'utf8');
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const json = value => JSON.parse(JSON.stringify(value));

function load(source, dependencies, extras = {}) {
  const module = {exports: {}};
  const output = esbuild.transformSync(source, {loader: 'ts', format: 'cjs', target: 'node22'}).code;
  const context = vm.createContext({module, exports: module.exports, AbortController, Promise, Error, TypeError,
    require(name) {
      if (name in dependencies) return dependencies[name];
      if (name.startsWith('node:')) return require(name);
      throw new Error('Unexpected dependency: ' + name);
    }, ...extras});
  new vm.Script(output).runInContext(context);
  return module.exports;
}

function fixture({supported = true, available = true, packaged = true, install} = {}) {
  const events = [], prompts = [], handlers = new Map(), imports = [], checks = [], logs = [];
  const logger = {info() {}, warn(...args) {logs.push(args);}, error(...args) {logs.push(args);}};
  const logging = {'@electron/common/Logger': {createChildLogger: () => logger}};
  const gate = load(read('DesktopUpdateGate'), logging);
  let ready, poll, installCalls = 0;
  const runtime = {checkDxDUpdate: async options => {
    checks.push(options);
    return {supported, available, version: available ? '2026.1108.4' : null};
  }};
  const app = Object.assign(new EventEmitter(), {isPackaged: packaged, getAppPath: () => 'C:/DxD'});
  const window = {isDestroyed: () => false, isVisible: () => true, webContents: {send: (channel, data) => events.push({channel, ...data})}};
  const bridge = {
    onMainWindowReady: callback => {ready = callback;},
    runDxDUpdateInstaller: async signal => {installCalls++; return install ? install(signal) : true;},
  };
  const updater = load(read('DxDUpdater').replace('import(pathToFileURL(path.join(app.getAppPath(), \'startup-update.mjs\')).href)', '__testRuntimeImport(pathToFileURL(path.join(app.getAppPath(), \'startup-update.mjs\')).href)'), {
    ...logging,
    '@electron/common/ModulePollPlan': {resolveModulePollPlan: value => {assert.equal(value, null); return {intervalMs: 90000, jitterRatio: 0.15};}},
    '@electron/main/DesktopUpdateGate': gate,
    '@electron/main/DesktopUpdatePoll': {armDesktopUpdatePoll: (options, immediate) => {poll = {options, immediate};}},
    '@electron/main/ModuleBootHandoff': bridge,
    '@electron/main/MainI18n': {t: key => key},
    '@electron/main/PrivilegedRendererDocuments': {requirePrivilegedRendererDocumentSender: event => {if (!event.trusted) throw new Error('Untrusted renderer');}},
    electron: {app, ipcMain: {handle: (name, handler) => handlers.set(name, handler)}, dialog: {showMessageBox: (...args) => {prompts.push(args); return Promise.resolve({response: 0});}}},
  }, {__testRuntimeImport: async url => {imports.push(url); return runtime;}});
  updater.registerDxDUpdater(() => window);
  return {app, gate, events, prompts, handlers, imports, checks, runtime, bridge,
    ready: () => ready(), poll: () => poll, installCalls: () => installCalls,
    check: context => handlers.get('updater-check')({trusted: true}, context)};
}

test('manual check uses the GitHub runtime and exposes the existing header state', {skip: !available}, async () => {
  const f = fixture();
  assert.equal(f.imports.length, 0, 'Runtime import waits until after registration and configured userData');
  await f.check('user');
  assert.equal(f.imports.length, 1);
  assert.match(f.imports[0], /startup-update\.mjs$/);
  assert.equal(f.checks[0].manual, true);
  assert.ok(f.checks[0].signal instanceof AbortSignal);
  assert.deepEqual(json(f.gate.getDesktopUpdateState()), {available: true, updating: false, replacesShell: true});
  assert.deepEqual(f.events.map(x => x.type), ['checking', 'available']);
  assert.equal(f.events[1].version, '2026.1108.4');
  assert.equal(f.installCalls(), 0, 'Checking never installs');
});

test('read-only background checks arm when the window is ready and do not open dialogs', {skip: !available}, async () => {
  const f = fixture();
  assert.equal(f.poll(), undefined);
  f.ready();
  assert.equal(f.poll().immediate, true);
  await f.poll().options.check();
  assert.equal(f.checks[0].manual, false);
  await f.check('background');
  assert.equal(f.checks[1].manual, false);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.installCalls(), 0);
});

test('a current version reports not available and rejects untrusted or invalid requests', {skip: !available}, async () => {
  const f = fixture({available: false});
  await f.check('user');
  assert.deepEqual(f.events.map(x => x.type), ['checking', 'not-available']);
  assert.equal(f.gate.getDesktopUpdateState().available, false);
  await assert.rejects(f.handlers.get('updater-check')({trusted: false}, 'user'), /Untrusted renderer/);
  await assert.rejects(f.check('arbitrary'), /Invalid update check context/);
  assert.equal(f.checks.length, 1);
});

test('portable and unpackaged copies receive the DxD download page and cannot claim to be current', {skip: !available}, async () => {
  for (const packaged of [true, false]) {
    const f = fixture({supported: false, available: false, packaged});
    await f.check('user');
    assert.equal(f.events[1].type, 'unsupported');
    assert.equal(f.events[1].reason, packaged ? 'platform' : 'unpackaged');
    assert.equal(f.events[1].downloadUrl, 'https://github.com/DarlingDemon/DxD/releases/latest');
    await assert.rejects(f.gate.checkDesktopUpdateNow({manual: true}), /github\.com\/DarlingDemon\/DxD/);
    assert.equal(f.installCalls(), 0);
  }
});

test('the existing start IPC gate disables the icon while installing and prevents duplicate starts', {skip: !available}, async () => {
  let complete;
  const f = fixture({install: () => new Promise(resolve => {complete = resolve;})});
  await f.check('user');
  assert.equal(f.gate.startDesktopUpdate(), true);
  assert.equal(f.gate.startDesktopUpdate(), false);
  assert.equal(f.installCalls(), 1);
  assert.equal(f.gate.getDesktopUpdateState().updating, true);
  complete(true);
  await settle();
  assert.equal(f.gate.getDesktopUpdateState().updating, false);
  assert.equal(f.prompts.length, 0);
});

test('failed installation preserves the main window, shows an error and releases the busy gate', {skip: !available}, async () => {
  const f = fixture({install: async () => {throw new Error('Download failed');}});
  await f.check('user');
  f.gate.startDesktopUpdate();
  await settle();
  assert.equal(f.gate.getDesktopUpdateState().updating, false);
  assert.equal(f.gate.getDesktopUpdateState().available, true, 'Header still permits a retry');
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0][1].detail, /Download failed/);
  assert.equal(f.prompts[0][1].message, 'desktop.update.failedMessage');
});

test('a withdrawn or no-longer-new release clears the icon without reporting installation failure', {skip: !available}, async () => {
  const f = fixture({install: async () => false});
  await f.check('user');
  f.gate.startDesktopUpdate();
  await settle();
  assert.equal(f.gate.getDesktopUpdateState().updating, false);
  assert.equal(f.gate.getDesktopUpdateState().available, false);
  assert.equal(f.events.at(-1).type, 'not-available');
  assert.equal(f.prompts.length, 0);
});

test('a missing installation handoff is an error, and shutdown cancels verification', {skip: !available}, async () => {
  const f = fixture();
  f.bridge.runDxDUpdateInstaller = undefined;
  await f.check('user');
  f.app.emit('before-quit');
  assert.equal(f.checks[0].signal.aborted, true);
  assert.equal(f.gate.startDesktopUpdate(), true);
  await settle();
  assert.equal(f.gate.getDesktopUpdateState().updating, false);
  assert.equal(f.installCalls(), 0);
});

test('offline entry wiring keeps splash ownership in Bootstrap', {skip: !available}, () => {
  const main = read('index'), bootstrap = read('Bootstrap');
  assert.match(main, /if \(process\.env\.FLUXER_OFFLINE === '1'\) \{\s+const \{registerDxDUpdater\}/);
  assert.match(main, /registerDxDUpdater\(getMainWindow\)/);
  assert.match(bootstrap, /setDxDUpdateInstaller\(async \(signal\) =>/);
  assert.match(bootstrap, /return installDxDUpdate\(splash, signal\)/);
  assert.doesNotMatch(read('DxDUpdater'), /import\(['"]@electron\/main\/SplashWindow/);
});

const renderer = process.env.DXD_TEST_RENDERER_DIR || path.join(__dirname, 'payload/dist/renderer');
const compiledUpdater = path.join(renderer, 'assets/6f68122e39b9cb42.js');
const compiledAvailable = available && fs.existsSync(compiledUpdater);
for (const loggedOut of [false, true]) {
  test(`actual compiled offline Updater subscribes and applies through native desktopUpdate.start: loggedOut=${loggedOut}`, {skip: !compiledAvailable}, async () => {
    const map = JSON.parse(fs.readFileSync(path.join(renderer, 'module-map.json')));
    assert.equal(map.modules['fluxer_app/src/features/app/state/Updater.ts'].id, 970591);
    const xstate = require(path.resolve(desktop, '../fluxer_app/node_modules/xstate'));
    const mobx = require(path.resolve(desktop, '../fluxer_app/node_modules/mobx'));
    let factories, bootstrap, nativeListener, stateListener, startCalls = 0, flushes = 0;
    const context = vm.createContext({self: {rspackChunkfluxer_app: {push: entry => {factories = entry[1];}}},
      Promise, Date, URL, AbortSignal,
      window: {setInterval() {throw new Error('Offline renderer must not start original feed checks');}},
    });
    const compiledSource = fs.readFileSync(compiledUpdater, 'utf8');
    const original = compiledSource.replace(rendererPatch.REPLACEMENT, rendererPatch.ORIGINAL);
    assert.equal(crypto.createHash('sha256').update(original).digest('hex'), rendererPatch.BASELINE);
    const patchedSource = original.replace(rendererPatch.ORIGINAL, rendererPatch.REPLACEMENT);
    new vm.Script(patchedSource).runInContext(context);
    const api = {
      offlineBuild: true, platform: 'win32',
      getDesktopInfo: async () => ({version: '2026.1108.4'}),
      onUpdaterEvent(listener) {nativeListener = listener; return () => {};},
      desktopUpdate: {
        onStateChanged(listener) {stateListener = listener; return () => {};},
        state: async () => ({available: false, updating: false, replacesShell: false}),
        start: async () => {startCalls++;},
      },
    };
    const dependencies = {
      857950: {A: {BUILD_VERSION: '2026.1106.11354'}},
      109903: {UO: 'https://unused.example/download'},
      735485: {A: {productName: 'DxD', getSnapshotOrNull: () => null}},
      257777: {l: []}, 768372: {U3: () => null},
      925438: {V: class {warn() {} debug() {} info() {} error() {}}},
      97214: {m4: async () => {if (loggedOut) throw new Error('No active account'); return {desktopVersion: '2026.1108.4', desktopChannel: 'canary'};}},
      210028: {[map.modules['fluxer_app/src/features/platform/utils/MobXPersistence.ts'].exportMap.flushPendingPersistWrites]: () => {flushes++;}},
      4128: {M: (store, initialize) => {bootstrap = initialize();}},
      763940: {dl: () => api, xl: () => true, PQ() {throw new Error('Native update must not open a download page');}},
      770334: {b: () => true},
      71861: {mj: xstate.setup, Q$: xstate.initialTransition, kY: xstate.transition},
      741854: {a: xstate.assign},
      672769: {l_: mobx.makeAutoObservable, h5: mobx.runInAction},
      671754: {},
    };
    const requireModule = id => {
      assert.ok(id in dependencies, `Unexpected compiled Updater dependency ${id}`);
      return dependencies[id];
    };
    requireModule.d = (exports, getters) => {
      for (const [name, get] of Object.entries(getters)) Object.defineProperty(exports, name, {get});
    };
    requireModule.e = () => Promise.resolve();
    const module = {exports: {}};
    factories[970591](module, module.exports, requireModule);
    await bootstrap;
    const updater = module.exports.A;
    assert.equal(typeof nativeListener, 'function', 'Native updater event subscription survives failed account lookup');
    assert.equal(typeof stateListener, 'function', 'Desktop state subscription is installed');
    assert.equal(updater.desktopUpdateAvailable, false);
    stateListener({available: true, updating: false, replacesShell: true});
    assert.equal(updater.desktopUpdateAvailable, true, 'UpdaterIcon desktop affordance can now become visible');
    assert.equal(updater.desktopUpdateReplacesShell, true);
    await updater.applyUpdate();
    assert.equal(startCalls, 1, 'The real applyUpdate used by the header button invokes native start');
    assert.equal(flushes, 1);
    stateListener({available: false, updating: true, replacesShell: false});
    assert.equal(updater.desktopUpdateInProgress, true, 'UpdaterIcon shows its disabled updating state');
    stateListener({available: false, updating: false, replacesShell: false});
    assert.equal(updater.desktopUpdateInProgress, false);
    assert.equal(updater.desktopUpdateAvailable, false);
    updater.dispose();
  });
}
