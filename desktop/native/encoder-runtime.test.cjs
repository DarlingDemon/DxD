// SPDX-License-Identifier: AGPL-3.0-or-later
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {EventEmitter} = require('node:events');
const {PassThrough, Writable} = require('node:stream');
const test = require('node:test');
const {NativeEncoderSession, AnnexBAccessUnitParser, encoderArguments} = require('./encoder-runtime.cjs');

const nal = (type, payload = [0x80], short = false) => Buffer.from([0, 0, ...(short ? [] : [0]), 1, type, ...payload]);
const key = () => Buffer.concat([nal(9, [0xf0]), nal(7, [0x42, 0xc0, 0x1f]), nal(8), nal(5, [0x88, 0x84])]);
const delta = () => Buffer.concat([nal(9, [0xf0], true), nal(1, [0x88, 0x84], true)]);
const configuration = overrides => ({ffmpegPath: 'private-ffmpeg.exe', backend: 'nvenc', width: 4, height: 2, frameRate: 30, bitrate: 1000000, ...overrides});

function fakeProcess({holdInput = false, closeOnEnd = false, ignoreKill = false} = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(data, encoding, callback) {
      child.input.push(data);
      if (!holdInput) callback();
    },
    final(callback) {
      callback();
      if (closeOnEnd) {
        child.stdout.end();
        queueMicrotask(() => child.emit('close', 0, null));
      }
    },
  });
  child.input = [];
  child.killCount = 0;
  child.kill = () => {
    child.killCount++;
    if (!ignoreKill) queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  };
  return child;
}

function sessionWith(child, options = {}, dependencies = {}) {
  let invocation;
  const session = new NativeEncoderSession(configuration(options), {
    stopTimeoutMs: 30, killTimeoutMs: 30,
    spawn(file, args, spawnOptions) {
      invocation = {file, args, spawnOptions};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    ...dependencies,
  });
  return {session, invocation: () => invocation};
}

test('Annex B framing survives every byte boundary and flushes the final AU', () => {
  const encoded = Buffer.concat([key(), delta(), key()]);
  for (let split = 1; split < encoded.length; split++) {
    const parser = new AnnexBAccessUnitParser();
    const frames = [...parser.push(encoded.subarray(0, split)), ...parser.push(encoded.subarray(split)), ...parser.flush()];
    assert.deepEqual(frames.map(frame => frame.keyframe), [true, false, true], `split ${split}`);
    assert.deepEqual(Buffer.concat(frames.map(frame => frame.data)), encoded);
    assert.equal(parser.bufferedBytes, 0);
    assert.deepEqual(parser.flush(), []);
  }
  const parser = new AnnexBAccessUnitParser();
  const frames = [];
  for (const byte of encoded) frames.push(...parser.push(Buffer.from([byte])));
  frames.push(...parser.flush());
  assert.deepEqual(frames.map(frame => frame.data), [key(), delta(), key()]);
});

test('empty AUD units are skipped, while malformed or undecodable streams fail', () => {
  const parser = new AnnexBAccessUnitParser();
  const frames = [...parser.push(Buffer.concat([nal(9), key(), nal(9)])), ...parser.flush()];
  assert.equal(frames.length, 1);
  assert.equal(frames[0].keyframe, true);
  const invalid = [
    [delta(), /did not start with a keyframe/],
    [Buffer.concat([nal(9), nal(5)]), /missing SPS or PPS/],
    [Buffer.concat([nal(9), nal(7)]), /no video slice/],
    [nal(1), /without an access unit delimiter/],
    [Buffer.concat([key(), Buffer.from([0, 0, 1])]), /Truncated.*EOF/],
    [Buffer.from([0, 0, 1, 0x89, 0x80]), /Invalid H.264 NAL/],
    [Buffer.concat([nal(9), nal(2)]), /Partitioned/],
    [Buffer.concat([nal(9), nal(7), nal(8), nal(1), nal(5)]), /mixes IDR/],
  ];
  for (const [data, pattern] of invalid) assert.throws(() => {
    const current = new AnnexBAccessUnitParser();
    current.push(data);
    current.flush();
  }, pattern);
  const limited = new AnnexBAccessUnitParser(32);
  assert.throws(() => limited.push(Buffer.alloc(33)), /buffer limit/);
});

test('configuration strictly selects native backend and bounds dimensions, rates and queues', () => {
  for (const invalid of [
    {backend: 'software'}, {width: 3842}, {height: 2162}, {width: 3}, {height: 3},
    {frameRate: 61}, {frameRate: 0}, {bitrate: Infinity}, {maxPendingFrames: 9}, {maxPendingFrames: 1},
  ]) assert.throws(() => new NativeEncoderSession(configuration(invalid)));
  for (const backend of ['nvenc', 'amf']) {
    const args = encoderArguments(configuration({backend}));
    assert.equal(args[args.indexOf('-c:v') + 1], `h264_${backend}`);
    assert.equal(args[args.indexOf('-aud') + 1], '1');
    assert.equal(args[args.indexOf('-bf') + 1], '0');
    assert.equal(args[args.indexOf('-g') + 1], '30');
    assert.ok(args.includes('scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=nv12'));
    assert.ok(!args.some(value => value.includes('libx264')));
  }
});

test('accepted frames retain exact FIFO timestamps across arbitrary output chunks', async () => {
  const child = fakeProcess({closeOnEnd: true});
  const {session, invocation} = sessionWith(child);
  const frames = [];
  const errors = [];
  session.on('frame', frame => frames.push(frame));
  session.on('error', error => errors.push(error));
  await session.start();
  assert.equal(invocation().spawnOptions.windowsHide, true);
  const data = Buffer.alloc(32);
  for (const timestamp of [100, 33433, 66766]) await session.writeFrame({data, timestamp});
  const encoded = Buffer.concat([key(), delta(), delta()]);
  for (let index = 0; index < encoded.length; index += 5) child.stdout.write(encoded.subarray(index, index + 5));
  assert.equal(frames.length, 2, 'last frame waits for EOF');
  await session.stop();
  assert.deepEqual(frames.map(frame => frame.timestamp), [100, 33433, 66766]);
  assert.deepEqual(frames.map(frame => [frame.width, frame.height, frame.keyframe]), [[4, 2, true], [4, 2, false], [4, 2, false]]);
  assert.deepEqual(errors, []);
  assert.ok(child.input.every(frame => frame === data), 'raw frame buffers are not copied');
  assert.equal(session.state, 'stopped');
});

test('queue overflow and invalid frames are rejected before accepting their timestamps', async () => {
  const child = fakeProcess();
  const {session} = sessionWith(child, {maxPendingFrames: 2});
  await session.start();
  const data = Buffer.alloc(32);
  await assert.rejects(session.writeFrame({data: Buffer.alloc(31), timestamp: 1}), /byte length/);
  await session.writeFrame({data, timestamp: 1});
  await assert.rejects(session.writeFrame({data, timestamp: 1}), /strictly increasing/);
  await session.writeFrame({data, timestamp: 2});
  await assert.rejects(session.writeFrame({data, timestamp: 3}), /backpressure/);
  assert.equal(child.input.length, 2);
  const frames = [];
  session.on('frame', frame => frames.push(frame));
  child.stdout.write(Buffer.concat([key(), delta()]));
  await session.writeFrame({data, timestamp: 3});
  assert.deepEqual(frames.map(frame => frame.timestamp), [1]);
  await session.stop();
});

test('backend failure rejects blocked stdin writes and includes driver diagnostics', async () => {
  const child = fakeProcess({holdInput: true});
  const {session} = sessionWith(child, {backend: 'amf'});
  const errors = [];
  session.on('error', error => errors.push(error));
  await session.start();
  const pending = session.writeFrame({data: Buffer.alloc(32), timestamp: 0});
  const rejected = assert.rejects(pending, /amfrt64.dll failed to open/);
  child.stderr.write('DLL amfrt64.dll failed to open');
  child.emit('close', 1, null);
  await rejected;
  await session.stop();
  assert.equal(errors.length, 1);
  await assert.rejects(session.writeFrame({data: Buffer.alloc(32), timestamp: 1}), /amfrt64.dll/);
});

test('capacity wait is bounded, shared, and resumes only after an encoded AU', async () => {
  const child = fakeProcess();
  const {session} = sessionWith(child, {maxPendingFrames: 2});
  await session.start();
  const data = Buffer.alloc(32);
  await session.waitForCapacity();
  await session.writeFrame({data, timestamp: 1});
  await session.writeFrame({data, timestamp: 2});
  const capacity = session.waitForCapacity();
  assert.equal(session.waitForCapacity(), capacity, 'one shared waiter, regardless of callers');
  let ready = false;
  capacity.then(() => { ready = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, false);
  child.stdout.write(Buffer.concat([key(), delta()]));
  await capacity;
  await session.writeFrame({data, timestamp: 3});
  const stopped = assert.rejects(session.waitForCapacity(), /Encoder stopped/);
  await session.stop();
  await stopped;
  assert.equal(session.capacityWait, null);
});

test('capacity wait rejects on backend failure or deadline without retaining waiters', async () => {
  for (const failBackend of [true, false]) {
    const child = fakeProcess();
    const {session} = sessionWith(child, {maxPendingFrames: 2}, {capacityTimeoutMs: 20});
    await session.start();
    await session.writeFrame({data: Buffer.alloc(32), timestamp: 1});
    await session.writeFrame({data: Buffer.alloc(32), timestamp: 2});
    const rejected = assert.rejects(session.waitForCapacity(), failBackend ? /backend unavailable/ : /within 5 seconds/);
    if (failBackend) child.emit('close', 1, null);
    await rejected;
    assert.equal(session.capacityWait, null);
    await session.stop();
  }
});

test('spawn failure, unsolicited output and missing accepted frames fail clearly', async () => {
  const missing = new NativeEncoderSession(configuration(), {spawn() { throw new Error('ENOENT fixture'); }});
  await assert.rejects(missing.start(), /ENOENT fixture/);
  await missing.stop();
  for (const extraOutput of [true, false]) {
    const child = fakeProcess();
    const {session} = sessionWith(child);
    const errors = [];
    session.on('error', error => errors.push(error));
    await session.start();
    if (extraOutput) child.stdout.write(Buffer.concat([key(), delta()]));
    else {
      await session.writeFrame({data: Buffer.alloc(32), timestamp: 1});
      child.emit('close', 0, null);
    }
    await session.stop();
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, extraOutput ? /without a submitted timestamp/ : /submitted frame\(s\) missing/);
  }
});

test('stop is idempotent and watchdog releases a hung process and blocked write', async () => {
  const child = fakeProcess({holdInput: true, ignoreKill: true});
  const {session} = sessionWith(child);
  await session.start();
  const pending = session.writeFrame({data: Buffer.alloc(32), timestamp: 0});
  const rejected = assert.rejects(pending, /Encoder stopped/);
  const firstStop = session.stop();
  assert.equal(session.stop(), firstStop);
  await Promise.all([firstStop, rejected]);
  assert.equal(child.killCount, 1);
  assert.equal(session.state, 'stopped');
  assert.equal(session.timestamps.length, 0);
  assert.equal(session.writes.size, 0);
  assert.equal(session.parser.bufferedBytes, 0);
});

test('a process that stops consuming stdin cannot leave a write promise hung', async () => {
  const child = fakeProcess({holdInput: true});
  const {session} = sessionWith(child, {}, {writeTimeoutMs: 20});
  await session.start();
  await assert.rejects(session.writeFrame({data: Buffer.alloc(32), timestamp: 0}), /nvenc encoder input stalled/);
  await session.stop();
  assert.equal(session.state, 'failed');
  assert.equal(session.writes.size, 0);
});

test('optional real NVIDIA runtime encodes synthetic RGBA with exact timestamps', {skip: !process.env.DXD_TEST_FFMPEG}, async () => {
  assert.ok(fs.existsSync(process.env.DXD_TEST_FFMPEG));
  const session = new NativeEncoderSession(configuration({ffmpegPath: process.env.DXD_TEST_FFMPEG, width: 320, height: 180}));
  const frames = [];
  const errors = [];
  session.on('frame', frame => frames.push(frame));
  session.on('error', error => errors.push(error));
  const data = Buffer.alloc(320 * 180 * 4, 128);
  await session.start();
  for (let index = 0; index < 35; index++) {
    await session.waitForCapacity();
    await session.writeFrame({data, timestamp: index * 33333});
  }
  await session.stop();
  assert.deepEqual(errors.map(error => error.message), []);
  assert.equal(frames.length, 35);
  assert.deepEqual(frames.map(frame => frame.timestamp), Array.from({length: 35}, (_, index) => index * 33333));
  assert.equal(frames.filter(frame => frame.keyframe).length, 2);
  assert.ok(frames.every(frame => frame.data.length > 0));
});
