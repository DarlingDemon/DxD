// SPDX-License-Identifier: AGPL-3.0-or-later
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const rendererSource = fs.readFileSync(path.join(__dirname, 'native-encoder-renderer.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(__dirname, 'native-encoder-worker.js'), 'utf8');
const flush = async () => {for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));};

function fixture(backend = 'nvenc') {
  const calls = [], workers = [], frameListeners = new Set(), endListeners = new Set(), settingsListeners = new Set();
  let now = 0, sequence = 0, readPending;
  const frames = [];
  const frame = (timestamp = 123456789, width = 4, height = 2) => ({
    timestamp, visibleRect: {x: 0, y: 0, width, height},
    async copyTo(data, options) {calls.push({type: 'copy', bytes: data.byteLength, options});},
    close() {calls.push({type: 'frameClosed', timestamp});},
  });
  const feed = value => {if (readPending) {const resolve = readPending; readPending = null; resolve({value, done: false});} else frames.push(value);};
  const reader = {
    read() {return frames.length ? Promise.resolve({value: frames.shift(), done: false}) : new Promise(resolve => {readPending = resolve;});},
    async cancel() {readPending?.({done: true}); readPending = null;},
  };
  const listeners = new Map();
  const source = {kind: 'video', getSettings: () => ({width: 4, height: 2, frameRate: 30}), clone: () => ({stop() {calls.push({type: 'cloneStopped'});}}), addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type)};
  const sender = {
    track: source, getParameters: () => ({codecs: [{mimeType: 'video/H264', payloadType: 108, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f'}]}),
    async replaceTrack(value) {this.track = value; calls.push({type: 'replace', value});},
    async createEncodedSource(worker) {calls.push({type: 'encodedSource'}); queueMicrotask(() => worker.onmessage({data: {type: 'ready'}}));},
  };
  const track = {kind: 'video', source: 'screen_share', mediaStreamTrack: source, sender};
  class Participant {
    async publishOrRepublishTrack(value, options, ...rest) {
      calls.push({type: 'publish', value, options, rest});
      if (this.retryOnce && rest[1] !== true) {
        this.retryOnce = false;
        await Promise.resolve(); // Mirrors waitForNextEngineRestart after NegotiationError.
        return this.publishOrRepublishTrack(this.retryTrack || value, options, rest[0] || false, true);
      }
      return {track: value};
    }
    async unpublishTrack(value, ...args) {calls.push({type: 'unpublish', value, args}); return {track: value};}
  }
  class Worker {
    constructor(url) {this.url = url; this.messages = []; workers.push(this);}
    postMessage(message) {this.messages.push(message);}
    terminate() {this.terminated = true;}
  }
  const bridge = {
    initialBackend: backend,
    onSettings(fn) {settingsListeners.add(fn); return () => settingsListeners.delete(fn);},
    async getSettings() {calls.push({type: 'settings'}); return {backend, backends: {nvenc: true, amf: true}};},
    async start(options) {const id = `s${++sequence}`; calls.push({type: 'start', options, id}); return {id};},
    async writeFrame(id, data) {calls.push({type: 'write', id, ...data});},
    async stop(id) {calls.push({type: 'stop', id});},
    onFrame(fn) {frameListeners.add(fn); return () => frameListeners.delete(fn);},
    onEnd(fn) {endListeners.add(fn); return () => endListeners.delete(fn);},
    reportError(message) {calls.push({type: 'error', message});},
  };
  const context = {dxdNativeEncoder: bridge, document: {currentScript: {src: 'https://fixture/native-encoder-renderer.js'}}, location: {href: 'https://fixture/'}, URL, ArrayBuffer, Uint8Array, setTimeout, clearTimeout, performance: {now: () => now}, Worker, MediaStreamTrackProcessor: class {constructor() {this.readable = {getReader: () => reader};}}};
  vm.runInNewContext(rendererSource, context);
  context.dxdNativeEncoderRenderer.install(Participant);
  const participant = new Participant();
  return {calls, workers, context, bridge, participant, track, sender, frame, feed, listeners, frameListeners, endListeners, settingsListeners, setNow: value => {now = value;}};
}

test('automatic mode delegates the exact publication; cameras and audio never query native settings', async () => {
  const f = fixture('auto'), options = {videoCodec: 'vp9', simulcast: true};
  await f.participant.publishOrRepublishTrack(f.track, options, true);
  assert.equal(f.calls[0].options, options);
  assert.deepEqual(f.calls[0].rest, [true]);
  assert.deepEqual(f.calls.map(call => call.type), ['publish']);
  assert.equal(f.workers.length, 0);
  f.calls.length = 0;
  await f.participant.publishOrRepublishTrack({...f.track, source: 'camera'}, options);
  await f.participant.publishOrRepublishTrack({...f.track, kind: 'audio'}, options);
  assert.deepEqual(f.calls.map(call => call.type), ['publish', 'publish']);
});

test('automatic sharing never queries GPU settings even when that IPC would reject', async () => {
  const f = fixture('auto'), options = {videoCodec: 'vp9'};
  f.bridge.getSettings = async () => {throw new Error('GPU info unavailable');};
  f.participant.retryOnce = true;
  await f.participant.publishOrRepublishTrack(f.track, options);
  assert.deepEqual(f.calls.map(call => call.type), ['publish', 'publish']);
  assert.ok(f.calls.every(call => call.options === options));
  assert.equal(f.workers.length, 0);
});

test('native publication forces a single H264 layer and preserves timestamp across throttled restarts', async () => {
  const f = fixture(); f.feed(f.frame());
  await f.participant.publishOrRepublishTrack(f.track, {videoCodec: 'vp9', simulcast: true, screenShareEncoding: {maxBitrate: 2000000, maxFramerate: 30}});
  const published = f.calls.find(call => call.type === 'publish');
  assert.equal(published.options.videoCodec, 'h264'); assert.equal(published.options.simulcast, false); assert.equal(published.options.backupCodec, false);
  assert.equal(f.sender.track, null);
  assert.equal(f.calls.find(call => call.type === 'write').timestamp, 123456789);
  assert.equal(f.calls.find(call => call.type === 'copy').bytes, 4 * 2 * 4);
  f.workers[0].onmessage({data: {type: 'keyframe'}});
  f.setNow(1000); f.feed(f.frame(123490000)); await flush();
  assert.equal(f.calls.filter(call => call.type === 'start').length, 1);
  f.setNow(2100); f.feed(f.frame(123520000)); await flush();
  assert.equal(f.calls.filter(call => call.type === 'start').length, 2);
  assert.equal(f.calls.filter(call => call.type === 'write').at(-1).timestamp, 123520000);
  assert.equal(f.calls.filter(call => call.type === 'write').at(-1).id, 's2');
  f.feed(f.frame(123550000, 6, 4)); await flush();
  assert.equal(f.calls.filter(call => call.type === 'start').length, 3, 'Dimension change restarts immediately');
  assert.equal(f.calls.filter(call => call.type === 'start').at(-1).options.width, 6);
  for (const listener of f.frameListeners) listener({id: 's1', data: new ArrayBuffer(4), timestamp: 1});
  assert.equal(f.workers[0].messages.filter(message => message.type === 'frame').length, 0, 'Old session output is ignored');
  await f.participant.unpublishTrack(f.track);
  assert.equal(f.frameListeners.size, 0); assert.equal(f.endListeners.size, 0); assert.equal(f.listeners.size, 0);
  assert.equal(f.workers[0].terminated, true);
  assert.ok(f.calls.some(call => call.type === 'stop' && call.id === 's3'));
  assert.equal(f.calls.at(-1).type, 'unpublish');
});

test('raw writes apply backpressure and release source frames', async () => {
  const f = fixture(); let release;
  f.bridge.writeFrame = async (id, data) => {f.calls.push({type: 'write', id, ...data}); await new Promise(resolve => {release = resolve;});};
  f.feed(f.frame(1)); f.feed(f.frame(2));
  const publication = f.participant.publishOrRepublishTrack(f.track, {}); await flush();
  assert.equal(f.calls.filter(call => call.type === 'copy').length, 1);
  assert.equal(f.calls.filter(call => call.type === 'frameClosed').length, 0);
  release(); await publication; await flush();
  assert.equal(f.calls.filter(call => call.type === 'copy').length, 2);
  release(); await flush();
  await f.participant.unpublishTrack(f.track);
  assert.equal(f.calls.filter(call => call.type === 'frameClosed').length, 2);
});

test('encoder loss unpublishes and reports the forced backend without browser fallback', async () => {
  const f = fixture('amf'); f.feed(f.frame());
  const audio = {kind: 'audio', source: 'screen_share_audio'};
  f.participant.getTrackPublication = source => source === 'screen_share_audio' ? {track: audio} : undefined;
  await f.participant.publishOrRepublishTrack(f.track, {});
  for (const listener of [...f.endListeners]) listener({id: 's1', error: 'device lost'});
  await flush();
  assert.equal(f.calls.filter(call => call.type === 'unpublish').length, 2);
  assert.ok(f.calls.some(call => call.type === 'unpublish' && call.value === audio));
  assert.equal(f.calls.filter(call => call.type === 'error').length, 1);
  assert.match(f.calls.find(call => call.type === 'error').message, /AMF: device lost/);
  assert.ok(f.calls.filter(call => call.type === 'replace').every(call => call.value === null));
});

test('missing external-source runtime stops the attempted share and raises a visible error', async () => {
  const f = fixture(); f.sender.createEncodedSource = undefined;
  await assert.rejects(f.participant.publishOrRepublishTrack(f.track, {}), /packaged RTCEncodedSource/);
  assert.equal(f.calls.filter(call => call.type === 'unpublish').length, 1);
  assert.equal(f.calls.filter(call => call.type === 'error').length, 1);
  assert.equal(f.calls.filter(call => call.type === 'start').length, 0);
});

test('duplicate publication uses one native session and reconnect binds a replacement sender', async () => {
  const f = fixture(); f.feed(f.frame());
  await Promise.all([f.participant.publishOrRepublishTrack(f.track, {}), f.participant.publishOrRepublishTrack(f.track, {})]);
  assert.equal(f.workers.length, 1); assert.equal(f.calls.filter(call => call.type === 'start').length, 1);
  const previousSender = f.sender;
  f.track.sender = {...previousSender, track: f.track.mediaStreamTrack, async replaceTrack(value) {this.track = value; f.calls.push({type: 'replace', value});}};
  const republish = f.participant.publishOrRepublishTrack(f.track, {}, true);
  await flush(); f.feed(f.frame(123500000)); await republish;
  assert.equal(f.workers.length, 2); assert.equal(f.workers[0].terminated, true);
  assert.equal(f.track.sender.track, null); assert.equal(f.calls.filter(call => call.type === 'start').length, 2);
  assert.ok(f.calls.some(call => call.type === 'stop' && call.id === 's1'));
  await f.participant.unpublishTrack(f.track.mediaStreamTrack, false);
  assert.equal(f.workers[1].terminated, true); assert.equal(f.frameListeners.size, 0);
});

test('internal LiveKit negotiation retry does not await its own outer publication', {timeout: 2000}, async () => {
  const f = fixture(); f.participant.retryOnce = true; f.feed(f.frame());
  await f.participant.publishOrRepublishTrack(f.track, {videoCodec: 'vp9'});
  const publishes = f.calls.filter(call => call.type === 'publish');
  assert.equal(publishes.length, 2);
  assert.equal(publishes[1].rest[1], true);
  assert.ok(publishes.every(call => call.options.videoCodec === 'h264'));
  assert.equal(f.workers.length, 1); assert.equal(f.calls.filter(call => call.type === 'start').length, 1);
  await f.participant.unpublishTrack(f.track);
});

test('retry with a converted track adopts its native session instead of attaching twice', {timeout: 2000}, async () => {
  const f = fixture(); f.participant.retryOnce = true; f.participant.retryTrack = {...f.track}; f.feed(f.frame());
  const publication = await f.participant.publishOrRepublishTrack(f.track, {videoCodec: 'vp9'});
  assert.equal(publication.track, f.participant.retryTrack);
  assert.equal(f.workers.length, 1); assert.equal(f.calls.filter(call => call.type === 'start').length, 1);
  await f.participant.unpublishTrack(f.track);
});

test('unexpected browser track replacement fails closed instead of silently abandoning the selected backend', async () => {
  const f = fixture(); f.feed(f.frame()); await f.participant.publishOrRepublishTrack(f.track, {});
  f.sender.track = f.track.mediaStreamTrack;
  f.feed(f.frame(123500000)); await flush();
  assert.equal(f.calls.filter(call => call.type === 'unpublish').length, 1);
  assert.match(f.calls.find(call => call.type === 'error').message, /sender changed/);
  assert.equal(f.calls.filter(call => call.type === 'write').length, 1);
});

test('upstream pause, resume and source replacement keep native injection and monotonic media time', async () => {
  const f = fixture(); const originalReplace = f.sender.replaceTrack; f.feed(f.frame(123456789)); await f.participant.publishOrRepublishTrack(f.track, {});
  await f.sender.replaceTrack(null);
  assert.ok(f.calls.some(call => call.type === 'stop' && call.id === 's1'));
  const resume = f.sender.replaceTrack(f.track.mediaStreamTrack);
  await flush(); f.feed(f.frame(1000)); await resume;
  const resumed = f.calls.filter(call => call.type === 'write').at(-1);
  assert.ok(resumed.timestamp > 123456789); assert.equal(resumed.id, 's2');
  const source = {...f.track.mediaStreamTrack};
  const replace = f.sender.replaceTrack(source);
  await flush(); f.feed(f.frame(10, 6, 4)); await replace;
  assert.equal(f.workers.length, 1, 'Source changes preserve the same RTCEncodedSource worker');
  assert.equal(f.sender.track, null);
  assert.ok(f.calls.filter(call => call.type === 'write').at(-1).timestamp > resumed.timestamp);
  assert.equal(f.calls.filter(call => call.type === 'start').at(-1).options.width, 6);
  assert.ok(f.calls.filter(call => call.type === 'replace').every(call => call.value === null), 'A browser raw track is never attached');
  assert.equal(f.calls.filter(call => call.type === 'error').length, 0);
  await f.participant.unpublishTrack(f.track);
  assert.equal(f.sender.replaceTrack, originalReplace);
});

test('codec policy can synchronously read persisted backend and receive settings broadcasts', () => {
  const f = fixture('nvenc');
  assert.equal(f.context.dxdNativeEncoderRenderer.getBackend(), 'nvenc');
  for (const listener of f.settingsListeners) listener({backend: 'amf'});
  assert.equal(f.context.dxdNativeEncoderRenderer.getBackend(), 'amf');
  for (const listener of f.settingsListeners) listener({backend: 'auto'});
  assert.equal(f.context.dxdNativeEncoderRenderer.getBackend(), 'auto');
});

test('codec policy retains active native backend after selecting Auto until that share stops', async () => {
  const f = fixture('nvenc'); f.feed(f.frame());
  await f.participant.publishOrRepublishTrack(f.track, {});
  for (const listener of f.settingsListeners) listener({backend: 'auto'});
  assert.equal(f.context.dxdNativeEncoderRenderer.getBackend(), 'nvenc');
  await f.sender.replaceTrack(null);
  assert.equal(f.context.dxdNativeEncoderRenderer.getBackend(), 'nvenc', 'Paused native shares keep their codec policy');
  await f.participant.unpublishTrack(f.track);
  assert.equal(f.context.dxdNativeEncoderRenderer.getBackend(), 'auto');
});

test('worker frames use capture timestamps and bounded overflow waits for the next IDR', async () => {
  const messages = [], written = [], eventHandlers = {};
  let release;
  const writer = {write(frame) {written.push(frame); return new Promise(resolve => {release = resolve;});}, async abort() {}};
  const source = {writable: {getWriter: () => writer}};
  const self = {postMessage: message => messages.push(message), addEventListener: (name, fn) => {eventHandlers[name] = fn;}};
  vm.runInNewContext(workerSource, {self, RTCEncodedVideoFrame: class {constructor(init) {Object.assign(this, init);}}});
  eventHandlers.rtcsenderencodedsource({encodedSource: source});
  self.onmessage({data: {type: 'configure', payloadType: 108}});
  const frame = (timestamp, keyframe = false) => self.onmessage({data: {type: 'frame', data: new ArrayBuffer(4), timestamp, keyframe, width: 4, height: 2}});
  frame(1000000, true); await flush();
  assert.equal(written[0].rtpTimestampWithoutOffset, 90000);
  assert.equal(written[0].timestamp, 1000000);
  for (let i = 1; i < 10; i++) frame(1000000 + i * 33333);
  release(); await flush();
  assert.equal(written.length, 1, 'Overflowed dependent deltas are discarded');
  assert.ok(messages.some(message => message.type === 'keyframe'));
  frame(2000000, true); await flush();
  assert.equal(written.length, 2); assert.equal(written[1].type, 'key');
  release(); await flush();
});
