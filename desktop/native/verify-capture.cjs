// SPDX-License-Identifier: AGPL-3.0-or-later
// Local smoke test: capture only the fixture window and a separate test tone process.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {app, BrowserWindow, desktopCapturer, protocol, session} = require('electron');

const {ProcessLoopback, getBackendInfo} = require(path.join(
  __dirname, 'payload/vendor/@fluxer/win-process-loopback',
));
const {loadError} = require(path.join(__dirname, 'payload/vendor/@fluxer/win-game-capture'));
const fixtureOrigin = 'dxd-test://fixture';
protocol.registerSchemesAsPrivileged([{scheme: 'dxd-test', privileges: {standard: true, secure: true}}]);
const watchdog = setTimeout(() => app.exit(1), 25000);

async function verify() {
  const backend = getBackendInfo();
  assert.ok(backend.processSupported && backend.systemSupported, backend.reason);
  assert.ifError(loadError);

  const partition = session.fromPartition('dxd-capture-test');
  partition.protocol.handle('dxd-test', () => new Response(`<!doctype html>
    <title>DxD Capture Fixture</title><body style="margin:0;background:rgb(21,197,73)"></body>`, {
    headers: {'Content-Type': 'text/html'},
  }));
  const target = new BrowserWindow({
    title: 'DxD Capture Fixture', width: 540, height: 360, frame: false,
    backgroundColor: '#15c549',
    webPreferences: {session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false},
  });
  const viewer = new BrowserWindow({
    show: false,
    webPreferences: {session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false},
  });
  await Promise.all([target.loadURL(fixtureOrigin), viewer.loadURL(fixtureOrigin)]);
  const sources = await desktopCapturer.getSources({types: ['window'], thumbnailSize: {width: 0, height: 0}});
  const source = sources.find((item) => item.id === target.getMediaSourceId());
  assert.ok(source, 'The test window was not listed as a capture source');
  partition.setDisplayMediaRequestHandler((request, callback) => {
    callback(request.frame === viewer.webContents.mainFrame ? {video: source} : null);
  });

  const tonePid = Number(process.env.DXD_TEST_TONE_PID);
  const toneSignal = process.env.DXD_TEST_TONE_SIGNAL;
  assert.ok(Number.isInteger(tonePid) && tonePid > 0 && toneSignal, 'Set the test tone process and signal');
  const capturedAudio = new ProcessLoopback(tonePid, {captureScope: 'process', includeProcessTree: true});
  let audioFrames = 0;
  let peak = 0;
  capturedAudio.on('frame', ({samples, channels, sampleRate}) => {
    assert.equal(channels, 2);
    assert.equal(sampleRate, 48000);
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    audioFrames += 1;
  });
  capturedAudio.on('error', (error) => { console.error(error); app.exit(1); });
  await capturedAudio.start();
  try {
    const [video] = await Promise.all([
      viewer.webContents.executeJavaScript(`(async () => {
        const stream = await navigator.mediaDevices.getDisplayMedia({video: true, audio: false});
        try {
          const video = document.createElement('video');
          video.muted = true;
          video.srcObject = stream;
          document.body.append(video);
          await video.play();
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d');
          let pixel;
          for (let attempt = 0; attempt < 10; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            context.drawImage(video, 0, 0, 1, 1);
            pixel = [...context.getImageData(0, 0, 1, 1).data];
            if (pixel[1] > 120 && pixel[0] < 80) break;
          }
          return {width: video.videoWidth, height: video.videoHeight, pixel};
        } finally { stream.getTracks().forEach(track => track.stop()); }
      })()`, true),
      new Promise((resolve) => {
        fs.writeFileSync(toneSignal, 'play');
        setTimeout(resolve, 2100);
      }),
    ]);
    assert.ok(video.width > 0 && video.height > 0 && video.pixel[1] > 120 && video.pixel[0] < 80, JSON.stringify(video));
    assert.ok(audioFrames > 0 && peak > 0.001, `Silent capture: ${audioFrames} frames, peak ${peak}`);
    console.log(JSON.stringify({electron: process.versions.electron, video, audioFrames, peak, systemLoopback: backend.systemLoopbackMode}));
  } finally {
    capturedAudio.stop();
    target.destroy();
    viewer.destroy();
  }
}

app.whenReady().then(verify).then(() => {
  clearTimeout(watchdog);
  app.exit(0);
}, (error) => {
  console.error(error);
  app.exit(1);
});
