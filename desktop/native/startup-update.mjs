// SPDX-License-Identifier: AGPL-3.0-or-later
import {existsSync} from 'node:fs';
import {app} from 'electron';
import updater from 'electron-updater';
import log from 'electron-log/main.js';
import {createGitHubUpdateRuntime} from './github-update-runtime.mjs';

const runtime = createGitHubUpdateRuntime({app, autoUpdater: updater.autoUpdater, log, existsSync});

export const isDxDUpdateSupported = () => runtime.isSupported();
export const checkDxDUpdate = options => runtime.check(options);
export const installDxDUpdate = (splash, signal) => runtime.install(splash, signal);

export async function checkStartupUpdate(splash, signal) {
  const update = await checkDxDUpdate({signal});
  if (!update.available || signal?.aborted) return false;
  return installDxDUpdate(splash, signal);
}
