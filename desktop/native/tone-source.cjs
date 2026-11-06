// SPDX-License-Identifier: AGPL-3.0-or-later
const fs = require('node:fs');
const {app, BrowserWindow} = require('electron');

app.whenReady().then(async () => {
  const window = new BrowserWindow({show: false, webPreferences: {sandbox: true, backgroundThrottling: false}});
  await window.loadURL('data:text/html,<title>DxD test tone</title>');
  const deadline = Date.now() + 25000;
  while (!fs.existsSync(process.env.DXD_TEST_TONE_SIGNAL)) {
    if (Date.now() > deadline) throw new Error('Tone signal timed out');
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  await window.webContents.executeJavaScript(`(async () => {
    const context = new AudioContext();
    await context.resume();
    const gain = context.createGain();
    gain.gain.value = 0.05;
    gain.connect(context.destination);
    const oscillator = context.createOscillator();
    oscillator.frequency.value = 997;
    oscillator.connect(gain);
    oscillator.start();
    oscillator.stop(context.currentTime + 1.3);
    await new Promise(resolve => { oscillator.onended = resolve; });
    await context.close();
  })()`, true);
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
