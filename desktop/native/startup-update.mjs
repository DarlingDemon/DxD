// SPDX-License-Identifier: AGPL-3.0-or-later
import {existsSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, sep} from 'node:path';
import {app} from 'electron';
import updater from 'electron-updater';
import log from 'electron-log/main.js';

const CHECK_TIMEOUT_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

async function withDeadline(operation, timeoutMs, onTimeout = () => {}) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve(null);
        onTimeout();
      }, timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function handOffToInstaller(autoUpdater) {
  let onQuit;
  try {
    const quitting = new Promise((resolve) => {
      onQuit = () => resolve(true);
      app.once('before-quit', onQuit);
    });
    autoUpdater.quitAndInstall(true, true);
    return (await withDeadline(quitting, 2000)) === true;
  } finally {
    app.removeListener('before-quit', onQuit);
  }
}

export async function checkStartupUpdate(splash, signal) {
  const installDir = dirname(process.execPath);
  const profile = relative(installDir, app.getPath('userData'));
  // NSIS replaces the installation tree. Only update installs with a separate profile.
  const profileIsSeparate = isAbsolute(profile) || profile === '..' || profile.startsWith(`..${sep}`);
  if (!profileIsSeparate || !existsSync(join(installDir, 'Uninstall DxD Native.exe'))) return false;

  const {autoUpdater} = updater;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.disableWebInstaller = true;

  const update = await withDeadline(autoUpdater.checkForUpdates(), CHECK_TIMEOUT_MS);
  if (!update?.isUpdateAvailable || signal.aborted) return false;

  splash.setSplashState({status: splash.SplashStatus.SHELL_UPDATE_DOWNLOADING, progress: 0});
  splash.openSplashWindow({darkThemeOnShow: true});
  const cancel = () => update.cancellationToken.cancel();
  const progress = ({percent}) => splash.setSplashState({
    status: splash.SplashStatus.SHELL_UPDATE_DOWNLOADING,
    progress: percent,
  });
  signal.addEventListener('abort', cancel, {once: true});
  autoUpdater.on('download-progress', progress);
  let installing = false;
  try {
    const files = await withDeadline(autoUpdater.downloadUpdate(update.cancellationToken), DOWNLOAD_TIMEOUT_MS, cancel);
    if (files?.length && !signal.aborted) {
      splash.setSplashState({status: splash.SplashStatus.SHELL_UPDATE_RESTARTING});
      installing = await handOffToInstaller(autoUpdater);
    }
    return installing;
  } finally {
    signal.removeEventListener('abort', cancel);
    autoUpdater.removeListener('download-progress', progress);
    if (!installing) {
      splash.markSplashLaunching();
      splash.closeSplashWindow();
    }
  }
}
