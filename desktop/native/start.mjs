// SPDX-License-Identifier: AGPL-3.0-or-later
import {existsSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, sep} from 'node:path';
import {app} from 'electron';
import './dist/main/index.js';

const installDir = dirname(process.execPath);
const uninstaller = join(installDir, 'Uninstall DxD Native.exe');
const profile = relative(installDir, app.getPath('userData'));
// NSIS replaces the installation tree. Only update installs with a separate profile.
const profileIsSeparate = isAbsolute(profile) || profile === '..' || profile.startsWith(`..${sep}`);
if (process.platform === 'win32' && app.isPackaged && profileIsSeparate && existsSync(uninstaller)) {
  void app.whenReady().then(async () => {
    const {default: updater} = await import('electron-updater');
    const {default: log} = await import('electron-log/main.js');
    const {autoUpdater} = updater;
    autoUpdater.logger = log;
    autoUpdater.disableDifferentialDownload = true;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.autoRunAppAfterInstall = false;

    const checkForUpdates = () => {
      void autoUpdater.checkForUpdates().catch(() => {
        // electron-updater logs the failure and emits an error before rejecting.
      });
    };

    const interval = setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
    const startupCheck = setTimeout(checkForUpdates, 15000);
    app.once('before-quit', () => {
      clearTimeout(startupCheck);
      clearInterval(interval);
    });
  }).catch((error) => console.error('DxD update initialization failed', error));
}
