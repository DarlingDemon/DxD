// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createGitHubUpdateRuntime, DXD_UPDATE_FEED} from './github-update-runtime.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
const settle = async () => {for (let i = 0; i < 20; i++) await Promise.resolve();};

function fixture(overrides = {}) {
  const app = new EventEmitter();
  const installDir = path.join(os.tmpdir(), 'dxd-updater-install');
  const installer = path.join(os.tmpdir(), 'dxd-downloaded-setup.exe');
  const present = new Set([path.join(installDir, 'Uninstall DxD Native.exe'), installer]);
  app.isPackaged = true;
  app.getPath = () => path.join(os.tmpdir(), 'dxd-updater-profile');
  const autoUpdater = new EventEmitter();
  const calls = {checks: 0, downloads: 0, installs: 0, cancels: 0, feed: null, warnings: []};
  let available = true;
  let clock = 1_000;
  const update = () => ({
    isUpdateAvailable: available,
    updateInfo: {version: available ? '2026.1108.4' : '2026.1108.3'},
    cancellationToken: {cancelled: false, cancel() {this.cancelled = true; calls.cancels++;}},
  });
  autoUpdater.setFeedURL = value => {calls.feed = value;};
  autoUpdater.checkForUpdates = async () => {calls.checks++; return update();};
  autoUpdater.downloadUpdate = async () => {calls.downloads++; return [installer];};
  autoUpdater.quitAndInstall = (silent, runAfter) => {
    assert.equal(silent, true); assert.equal(runAfter, true);
    calls.installs++; app.emit('before-quit', {defaultPrevented: false});
  };
  const states = [];
  const splash = {
    SplashStatus: {SHELL_UPDATE_DOWNLOADING: 'downloading', SHELL_UPDATE_RESTARTING: 'restarting'},
    setSplashState: state => states.push(state),
    openSplashWindow: () => states.push({open: true}),
    markSplashLaunching: () => states.push({restored: true}),
    closeSplashWindow: () => states.push({closed: true}),
  };
  const runtime = createGitHubUpdateRuntime({
    app, autoUpdater, existsSync: value => present.has(value),
    execPath: path.join(installDir, 'DxD Native.exe'), platform: 'win32', arch: 'x64',
    now: () => clock, log: {warn: (...args) => calls.warnings.push(args)},
    timeouts: {check: 50, manualCheck: 150, download: 200, handoff: 20},
    ...overrides,
  });
  return {app, autoUpdater, calls, runtime, splash, states, update, present, installer,
    setAvailable: value => {available = value;}, tickClock: amount => {clock += amount;}};
}

test('shared check configures only the trusted GitHub feed and manual checks bypass cache', async () => {
  const f = fixture();
  assert.deepEqual(await f.runtime.check(), {supported: true, available: true, version: '2026.1108.4'});
  assert.deepEqual(f.calls.feed, {provider: 'generic', url: DXD_UPDATE_FEED, useMultipleRangeRequest: false});
  assert.equal(f.autoUpdater.autoDownload, false);
  assert.equal(f.autoUpdater.autoInstallOnAppQuit, false);
  assert.equal(f.autoUpdater.allowDowngrade, false);
  assert.equal(f.autoUpdater.allowPrerelease, false);
  await f.runtime.check(); assert.equal(f.calls.checks, 1);
  await f.runtime.check({manual: true}); assert.equal(f.calls.checks, 2);
  assert.equal(f.autoUpdater.listenerCount('error'), 1);
});

test('overlapping startup and manual checks share one network request', async () => {
  const f = fixture(), reply = deferred();
  f.autoUpdater.checkForUpdates = () => {f.calls.checks++; return reply.promise;};
  const first = f.runtime.check(), second = f.runtime.check({manual: true});
  await settle(); assert.equal(f.calls.checks, 1);
  reply.resolve(f.update());
  assert.deepEqual(await first, await second);
});

test('no update never downloads or starts the installer', async () => {
  const f = fixture(); f.setAvailable(false);
  assert.equal((await f.runtime.check()).available, false);
  assert.equal(await f.runtime.install(f.splash), false);
  assert.equal(f.calls.downloads, 0); assert.equal(f.calls.installs, 0);
  assert.equal(f.states.length, 0);
});

test('portable profiles, unpackaged builds, other architectures and missing uninstaller are unsupported', async () => {
  for (const mode of ['portable', 'unpackaged', 'arm', 'linux', 'uninstaller']) {
    const f = fixture(mode === 'arm' ? {arch: 'arm64'} : mode === 'linux' ? {platform: 'linux'} : {});
    if (mode === 'portable') f.app.getPath = () => path.join(os.tmpdir(), 'dxd-updater-install', 'data');
    if (mode === 'unpackaged') f.app.isPackaged = false;
    if (mode === 'uninstaller') f.present.clear();
    assert.equal(f.runtime.isSupported(), false, mode);
    assert.deepEqual(await f.runtime.check({manual: true}), {supported: false, available: false, version: null});
    await assert.rejects(f.runtime.install(f.splash), /installed copy/);
    assert.equal(f.calls.checks, 0); assert.equal(f.calls.downloads, 0);
  }
});

test('failed checks invalidate availability and updater error events are handled', async () => {
  const f = fixture(); await f.runtime.check();
  f.autoUpdater.checkForUpdates = async () => {f.calls.checks++; f.autoUpdater.emit('error', new Error('offline')); throw new Error('offline');};
  await assert.rejects(f.runtime.check({manual: true}), /offline/);
  await assert.rejects(f.runtime.install(f.splash), /offline/);
  assert.equal(f.calls.checks, 3); assert.equal(f.calls.downloads, 0);
  assert.equal(f.calls.warnings.length, 2);
});

test('a check timeout cannot later publish availability or install without a fresh check', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = fixture(), late = deferred();
  f.autoUpdater.checkForUpdates = () => {f.calls.checks++; return late.promise;};
  const checking = f.runtime.check();
  const failure = assert.rejects(checking, /did not answer/);
  await settle(); t.mock.timers.tick(51); await failure;
  late.resolve(f.update()); await settle();
  f.setAvailable(false);
  f.autoUpdater.checkForUpdates = async () => {f.calls.checks++; return f.update();};
  assert.equal(await f.runtime.install(f.splash), false);
  assert.equal(f.calls.checks, 2); assert.equal(f.calls.downloads, 0);
});

test('startup timeout does not cancel a concurrent longer manual check', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = fixture(), reply = deferred();
  f.autoUpdater.checkForUpdates = () => {f.calls.checks++; return reply.promise;};
  const startup = f.runtime.check(), manual = f.runtime.check({manual: true});
  const failure = assert.rejects(startup, /did not answer/);
  await settle(); t.mock.timers.tick(51); await failure;
  reply.resolve(f.update());
  assert.equal((await manual).available, true);
  assert.equal(f.calls.checks, 1);
});

test('pre-aborted requests and a check aborted before its answer cannot initiate download', async () => {
  const f = fixture(), cancel = new AbortController(); cancel.abort();
  await assert.rejects(f.runtime.check({signal: cancel.signal}), {name: 'AbortError'});
  assert.throws(() => f.runtime.install(f.splash, cancel.signal), {name: 'AbortError'});
  assert.equal(f.calls.checks, 0);
  const waiting = deferred(), controller = new AbortController();
  f.autoUpdater.checkForUpdates = () => {f.calls.checks++; return waiting.promise;};
  const checking = f.runtime.check({signal: controller.signal});
  const failed = assert.rejects(checking, {name: 'AbortError'});
  controller.abort(); await failed;
  waiting.resolve(f.update()); await settle();
  f.autoUpdater.checkForUpdates = async () => {f.calls.checks++; return f.update();};
  await f.runtime.check();
  assert.equal(f.calls.checks, 2); assert.equal(f.calls.downloads, 0);
});

test('duplicate install clicks share progress, download and installer handoff exactly once', async () => {
  const f = fixture(), downloaded = deferred();
  await f.runtime.check();
  f.autoUpdater.downloadUpdate = () => {f.calls.downloads++; return downloaded.promise;};
  const one = f.runtime.install(f.splash), two = f.runtime.install(f.splash);
  assert.equal(one, two);
  await settle();
  f.autoUpdater.emit('download-progress', {percent: 42.5});
  assert.ok(f.states.some(state => state.progress === 42.5));
  await f.runtime.check({manual: true}); assert.equal(f.calls.checks, 1, 'Check during download must not replace the selected provider');
  downloaded.resolve([f.installer]);
  assert.equal(await one, true); assert.equal(await two, true);
  assert.equal(await f.runtime.install(f.splash), true);
  assert.equal(f.calls.downloads, 1); assert.equal(f.calls.installs, 1);
  assert.equal(f.autoUpdater.listenerCount('download-progress'), 0);
  assert.equal(f.app.listenerCount('before-quit'), 0);
  assert.equal(f.autoUpdater.listenerCount('error'), 1);
});

test('expired availability is rechecked before an install', async () => {
  const f = fixture(); await f.runtime.check(); f.tickClock(60_001); f.setAvailable(false);
  assert.equal(await f.runtime.install(f.splash), false);
  assert.equal(f.calls.checks, 2); assert.equal(f.calls.downloads, 0);
});

test('normal before-quit shutdown abort does not cancel an installer already handed off', async () => {
  const f = fixture(), shutdown = new AbortController();
  f.app.once('before-quit', () => shutdown.abort());
  await f.runtime.check();
  assert.equal(await f.runtime.install(f.splash, shutdown.signal), true);
  assert.equal(shutdown.signal.aborted, true);
  assert.equal(f.calls.installs, 1);
  assert.equal(f.states.some(state => state.closed), false);
});

test('installation waits for an in-flight manual check before selecting the downloaded version', async () => {
  const f = fixture(), newer = deferred(); await f.runtime.check();
  f.autoUpdater.checkForUpdates = () => {f.calls.checks++; return newer.promise;};
  const checking = f.runtime.check({manual: true}), installing = f.runtime.install(f.splash);
  await settle(); assert.equal(f.calls.downloads, 0);
  f.setAvailable(false); newer.resolve(f.update());
  await checking; assert.equal(await installing, false); assert.equal(f.calls.downloads, 0);
});

test('aborted and timed-out downloads cancel their token and never install a late result', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const mode of ['abort', 'timeout']) {
    const f = fixture(), downloaded = deferred(), controller = new AbortController();
    await f.runtime.check();
    f.autoUpdater.downloadUpdate = () => {f.calls.downloads++; return downloaded.promise;};
    const installing = f.runtime.install(f.splash, controller.signal);
    const failed = assert.rejects(installing, mode === 'abort' ? {name: 'AbortError'} : /download timed out/);
    await settle();
    if (mode === 'abort') controller.abort(); else t.mock.timers.tick(201);
    await failed;
    downloaded.resolve([f.installer]); await settle();
    assert.equal(f.calls.cancels, 1); assert.equal(f.calls.installs, 0);
    assert.equal(f.autoUpdater.listenerCount('download-progress'), 0);
    assert.ok(f.states.some(state => state.closed));
  }
});

test('failed or missing downloads restore the app and allow a fresh check and retry', async () => {
  for (const mode of ['failure', 'empty', 'missing']) {
    const f = fixture(); await f.runtime.check();
    f.autoUpdater.downloadUpdate = async () => {
      f.calls.downloads++;
      if (mode === 'failure') throw new Error('download failed');
      return mode === 'empty' ? [] : ['missing-file.exe'];
    };
    await assert.rejects(f.runtime.install(f.splash), mode === 'failure' ? /download failed/ : /did not produce/);
    assert.ok(f.states.some(state => state.closed)); assert.equal(f.calls.installs, 0);
    f.autoUpdater.downloadUpdate = async () => {f.calls.downloads++; return [f.installer];};
    assert.equal(await f.runtime.install(f.splash), true);
    assert.equal(f.calls.checks, 2); assert.equal(f.calls.installs, 1);
  }
});

test('a cancelled download must settle before a retry can change provider or start another download', async () => {
  const f = fixture(), download = deferred(), controller = new AbortController();
  await f.runtime.check();
  f.autoUpdater.downloadUpdate = () => {f.calls.downloads++; return download.promise;};
  const installing = f.runtime.install(f.splash, controller.signal);
  const aborted = assert.rejects(installing, {name: 'AbortError'});
  await settle(); controller.abort(); await aborted;
  await assert.rejects(f.runtime.check({manual: true}), /still stopping/);
  await assert.rejects(f.runtime.install(f.splash), /still stopping/);
  assert.equal(f.calls.checks, 1); assert.equal(f.calls.downloads, 1);
  download.resolve([f.installer]); await settle();
  f.autoUpdater.downloadUpdate = async () => {f.calls.downloads++; return [f.installer];};
  assert.equal(await f.runtime.install(f.splash), true);
  assert.equal(f.calls.checks, 2); assert.equal(f.calls.downloads, 2); assert.equal(f.calls.installs, 1);
});

test('installer failures, a prevented quit and missing quit event report failure with cleaned listeners', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const mode of ['throw', 'event', 'prevented', 'timeout']) {
    const f = fixture(); await f.runtime.check();
    f.autoUpdater.quitAndInstall = () => {
      if (mode === 'throw') throw new Error('installer failed');
      if (mode === 'event') f.autoUpdater.emit('error', new Error('installer failed'));
      if (mode === 'prevented') f.app.emit('before-quit', {defaultPrevented: true});
    };
    const installing = f.runtime.install(f.splash);
    const failed = assert.rejects(installing, mode === 'prevented' ? /could not close/ : mode === 'timeout' ? /installer did not start/ : /installer failed/);
    await settle(); if (mode === 'timeout') t.mock.timers.tick(21); await failed;
    assert.equal(f.app.listenerCount('before-quit'), 0);
    assert.equal(f.autoUpdater.listenerCount('error'), 1);
    assert.equal(f.autoUpdater.listenerCount('download-progress'), 0);
    assert.ok(f.states.some(state => state.closed));
  }
});
