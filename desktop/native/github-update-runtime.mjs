// SPDX-License-Identifier: AGPL-3.0-or-later
import {dirname, isAbsolute, join, relative, sep} from 'node:path';

export const DXD_UPDATE_FEED = 'https://github.com/DarlingDemon/DxD/releases/latest/download/';

function abortError() {
  const error = new Error('The update was cancelled.');
  error.name = 'AbortError';
  return error;
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function bounded(operation, {signal, timeout, onCancel = () => {}, timeoutMessage}) {
  let timer;
  let onAbort;
  const stopped = new Promise((resolve, reject) => {
    const cancel = error => {
      try { onCancel(); } catch {}
      reject(error);
    };
    onAbort = () => cancel(abortError());
    signal?.addEventListener('abort', onAbort, {once: true});
    if (signal?.aborted) onAbort();
    timer = setTimeout(() => cancel(new Error(timeoutMessage)), timeout);
  });
  return Promise.race([operation, stopped]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  });
}

/** One controller owns the feed and download for startup, menu and header button. */
export function createGitHubUpdateRuntime({
  app, autoUpdater, log, existsSync, execPath = process.execPath,
  platform = process.platform, arch = process.arch, now = Date.now,
  cacheTTL = 60_000,
  timeouts = {},
}) {
  const limits = {check: 5000, manualCheck: 15_000, download: 10 * 60_000, handoff: 2000, ...timeouts};
  let configured = false;
  let rawCheck = null;
  let rawDownload = null;
  let validatedUpdate = null;
  let activeInstall = null;
  let quitting = false;
  const logError = error => log?.warn?.('[DxD Update]', error?.message ?? String(error));

  const isSupported = () => {
    if (platform !== 'win32' || arch !== 'x64' || !app.isPackaged) return false;
    const installDirectory = dirname(execPath);
    const profile = relative(installDirectory, app.getPath('userData'));
    // An NSIS replacement must never overwrite a portable profile in its tree.
    const separate = isAbsolute(profile) || profile === '..' || profile.startsWith(`..${sep}`);
    return separate && existsSync(join(installDirectory, 'Uninstall DxD Native.exe'));
  };

  function configure() {
    if (configured) return;
    configured = true;
    autoUpdater.logger = log;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.disableDifferentialDownload = true;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.setFeedURL({provider: 'generic', url: DXD_UPDATE_FEED, useMultipleRangeRequest: false});
    // electron-updater can emit an error as well as reject its returned promise.
    autoUpdater.on('error', logError);
  }

  function summary(value) {
    return {supported: true, available: value?.result?.isUpdateAvailable === true, version: value?.result?.updateInfo?.version ?? null};
  }

  function cacheIsCurrent() {
    return validatedUpdate && now() - validatedUpdate.at < cacheTTL &&
      !validatedUpdate.result?.cancellationToken?.cancelled;
  }

  async function check({manual = false, signal} = {}, forInstall = false) {
    assertNotAborted(signal);
    if (!isSupported()) return {supported: false, available: false, version: null};
    configure();
    // Checking again during a download can replace electron-updater's selected
    // update provider. Publish the already validated selection until it finishes.
    if (!forInstall && activeInstall && validatedUpdate) return summary(validatedUpdate);
    if (rawDownload) throw new Error('A previous update download is still stopping. Please try again shortly.');
    if (!manual && cacheIsCurrent()) return summary(validatedUpdate);
    if (!rawCheck) {
      const operation = Promise.resolve().then(() => autoUpdater.checkForUpdates());
      rawCheck = operation;
      operation.finally(() => {if (rawCheck === operation) rawCheck = null;}).catch(() => {});
    }
    const operation = rawCheck;
    try {
      const result = await bounded(operation, {
        signal, timeout: manual ? limits.manualCheck : limits.check,
        timeoutMessage: 'GitHub did not answer the update check in time. Please try again.',
      });
      assertNotAborted(signal);
      if (!result || typeof result.isUpdateAvailable !== 'boolean') throw new Error('GitHub returned no update result. Please try again.');
      if (result.isUpdateAvailable && (!result.updateInfo?.version || !result.cancellationToken)) {
        throw new Error('GitHub returned incomplete update information. Please try again.');
      }
      validatedUpdate = {result, at: now()};
      return summary(validatedUpdate);
    } catch (error) {
      validatedUpdate = null;
      throw error;
    }
  }

  async function handOff(signal) {
    assertNotAborted(signal);
    let onQuit;
    let onError;
    const requested = new Promise((resolve, reject) => {
      onQuit = event => queueMicrotask(() => {
        if (event?.defaultPrevented) reject(new Error('DxD could not close for installation. Please try again.'));
        else resolve(true);
      });
      onError = reject;
      app.once('before-quit', onQuit);
      autoUpdater.once('error', onError);
      try { autoUpdater.quitAndInstall(true, true); }
      catch (error) { reject(error); }
    });
    try {
      // quitAndInstall has crossed the point where cancellation is possible.
      // The app's before-quit handlers abort the shutdown signal themselves;
      // that expected abort must not turn a successful installer handoff into
      // an error or reopen the splash while the process is closing.
      await bounded(requested, {timeout: limits.handoff, timeoutMessage: 'The update installer did not start. Please try again.'});
      quitting = true;
      return true;
    } finally {
      app.removeListener('before-quit', onQuit);
      autoUpdater.removeListener('error', onError);
    }
  }

  async function runInstall(splash, signal) {
    assertNotAborted(signal);
    if (!isSupported()) throw new Error('Automatic updates require an installed copy of DxD Native. Install the Windows setup first.');
    if (rawDownload) throw new Error('A previous update download is still stopping. Please try again shortly.');
    if (rawCheck || !cacheIsCurrent()) await check({manual: true, signal}, true);
    assertNotAborted(signal);
    if (!validatedUpdate?.result?.isUpdateAvailable) return false;
    const update = validatedUpdate.result;
    const cancel = () => update.cancellationToken.cancel();
    const progress = ({percent}) => {
      if (signal?.aborted) return;
      const value = Number(percent);
      splash.setSplashState({status: splash.SplashStatus.SHELL_UPDATE_DOWNLOADING, progress: Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0});
    };
    let startedQuit = false;
    splash.setSplashState({status: splash.SplashStatus.SHELL_UPDATE_DOWNLOADING, progress: 0});
    splash.openSplashWindow({darkThemeOnShow: true});
    autoUpdater.on('download-progress', progress);
    try {
      const downloading = Promise.resolve().then(() => {
        assertNotAborted(signal);
        return autoUpdater.downloadUpdate(update.cancellationToken);
      });
      rawDownload = downloading;
      downloading.finally(() => {if (rawDownload === downloading) rawDownload = null;}).catch(() => {});
      const files = await bounded(downloading, {
        signal, timeout: limits.download, onCancel: cancel,
        timeoutMessage: 'The update download timed out. Please try again.',
      });
      assertNotAborted(signal);
      if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string' || !existsSync(file))) {
        throw new Error('The update download did not produce an installer. Please try again.');
      }
      splash.setSplashState({status: splash.SplashStatus.SHELL_UPDATE_RESTARTING});
      startedQuit = await handOff(signal);
      return startedQuit;
    } catch (error) {
      validatedUpdate = null;
      throw error;
    } finally {
      autoUpdater.removeListener('download-progress', progress);
      if (!startedQuit) {
        splash.markSplashLaunching();
        splash.closeSplashWindow();
      }
    }
  }

  function install(splash, signal) {
    assertNotAborted(signal);
    if (quitting) return Promise.resolve(true);
    if (activeInstall) return activeInstall;
    const operation = Promise.resolve().then(() => runInstall(splash, signal));
    activeInstall = operation;
    operation.finally(() => {if (activeInstall === operation) activeInstall = null;}).catch(() => {});
    return operation;
  }

  return {isSupported, check, install};
}
