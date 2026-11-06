// SPDX-License-Identifier: AGPL-3.0-or-later
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {app} from 'electron';
import './dist/main/index.js';

// The unpacked build and portable copies should never run an installer.
const uninstaller = join(dirname(process.execPath), 'Uninstall DxD Native.exe');
if (process.platform === 'win32' && app.isPackaged && existsSync(uninstaller)) {
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
