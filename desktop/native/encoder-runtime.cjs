// SPDX-License-Identifier: AGPL-3.0-or-later
const {spawn} = require('node:child_process');
const {EventEmitter} = require('node:events');

const MAX_ENCODED_BYTES = 20 * 1024 * 1024;

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

// An AUD begins each access unit. Retain the last unit until the next AUD or EOF;
// stdout chunks are not frame boundaries. Only encoded bytes are copied here.
class AnnexBAccessUnitParser {
  constructor(maxBytes = MAX_ENCODED_BYTES) {
    this.maxBytes = integer(maxBytes, 'maxBytes', 16, MAX_ENCODED_BYTES);
    this.buffer = Buffer.alloc(0);
    this.scan = 0;
    this.payloadStart = null;
    this.types = new Set();
    this.seenAud = false;
    this.seenKeyframe = false;
    this.ended = false;
  }

  get bufferedBytes() { return this.buffer.length; }

  push(chunk) {
    if (this.ended) throw new Error('H.264 parser is already closed');
    if (!Buffer.isBuffer(chunk)) throw new Error('H.264 output must be a Buffer');
    if (this.buffer.length + chunk.length > this.maxBytes) throw new Error('H.264 access unit exceeds the encoded buffer limit');
    if (!chunk.length) return [];
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames = [];
    let consumed = 0;
    let i = this.scan;
    for (; i + 3 < this.buffer.length; i++) {
      if (this.buffer[i] !== 0 || this.buffer[i + 1] !== 0) continue;
      const prefix = this.buffer[i + 2] === 1 ? 3 : this.buffer[i + 2] === 0 && this.buffer[i + 3] === 1 ? 4 : 0;
      if (!prefix) continue;
      if (i + prefix >= this.buffer.length) break;
      if (this.payloadStart !== null && i - this.payloadStart < 2) throw new Error('Truncated H.264 NAL unit');
      if (this.payloadStart === null && this.buffer.subarray(0, i).some(byte => byte !== 0)) throw new Error('H.264 output has data before its first start code');
      const header = this.buffer[i + prefix];
      const type = header & 31;
      if ((header & 128) || type === 0 || type > 23) throw new Error('Invalid H.264 NAL header');
      if (type >= 2 && type <= 4) throw new Error('Partitioned H.264 slices are unsupported');
      if (type === 9) {
        if (this.seenAud) {
          const frame = this.finishUnit(this.buffer.subarray(consumed, i));
          if (frame) frames.push(frame);
          consumed = i;
          this.types.clear();
        }
        this.seenAud = true;
      } else if ((type === 1 || type === 5) && !this.seenAud) {
        throw new Error('H.264 slice arrived without an access unit delimiter');
      }
      this.types.add(type);
      this.payloadStart = i + prefix;
      i += prefix;
    }
    this.scan = i - consumed;
    if (this.payloadStart !== null) this.payloadStart -= consumed;
    this.buffer = this.buffer.subarray(consumed);
    return frames;
  }

  finishUnit(data) {
    const keyframe = this.types.has(5);
    if (!keyframe && !this.types.has(1)) {
      if ([...this.types].every(type => type === 9)) return null;
      throw new Error('H.264 access unit has headers but no video slice');
    }
    if (keyframe && this.types.has(1)) throw new Error('H.264 access unit mixes IDR and delta slices');
    if (keyframe && (!this.types.has(7) || !this.types.has(8))) throw new Error('H.264 keyframe is missing SPS or PPS');
    if (!this.seenKeyframe && !keyframe) throw new Error('H.264 stream did not start with a keyframe');
    if (keyframe) this.seenKeyframe = true;
    return {data, keyframe};
  }

  flush() {
    if (this.ended) return [];
    this.ended = true;
    if (!this.buffer.length) return [];
    if (this.payloadStart === null || this.buffer.length - this.payloadStart < 2) throw new Error('Truncated H.264 output at EOF');
    // A terminal start code has no NAL header, even if the preceding slice exists.
    if (this.buffer.subarray(-3).equals(Buffer.from([0, 0, 1]))) throw new Error('Truncated H.264 start code at EOF');
    const frame = this.finishUnit(this.buffer);
    this.buffer = Buffer.alloc(0);
    return frame ? [frame] : [];
  }
}

function encoderArguments(options) {
  const {width, height, frameRate, bitrate, backend} = options;
  const codec = backend === 'nvenc' ? 'h264_nvenc' : 'h264_amf';
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'warning',
    '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${width}x${height}`,
    '-framerate', String(frameRate), '-i', 'pipe:0', '-an',
    '-vf', 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=nv12',
    '-c:v', codec, '-profile:v', backend === 'amf' ? 'constrained_baseline' : 'baseline',
    ...(backend === 'nvenc'
      ? ['-preset', 'p1', '-tune', 'ull', '-rc', 'cbr', '-zerolatency', '1', '-delay', '0', '-forced-idr', '1']
      : ['-usage', 'ultralowlatency', '-quality', 'speed', '-rc', 'cbr', '-header_spacing', String(frameRate)]),
    '-bf', '0', '-g', String(frameRate), '-b:v', String(bitrate), '-maxrate', String(bitrate),
    '-bufsize', String(bitrate), '-flags', '-global_header', '-aud', '1',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709',
    '-fps_mode', 'passthrough', '-flush_packets', '1', '-f', 'h264', 'pipe:1',
  ];
}

class NativeEncoderSession extends EventEmitter {
  constructor(options, dependencies = {}) {
    super();
    if (!options || !['nvenc', 'amf'].includes(options.backend)) throw new Error('backend must be nvenc or amf');
    if (typeof options.ffmpegPath !== 'string' || !options.ffmpegPath || options.ffmpegPath.includes('\0')) throw new Error('ffmpegPath is required');
    const width = integer(options.width, 'width', 2, 3840);
    const height = integer(options.height, 'height', 2, 2160);
    if (width % 2 || height % 2) throw new Error('width and height must be even for NV12');
    this.options = {
      ffmpegPath: options.ffmpegPath, backend: options.backend, width, height,
      frameRate: integer(options.frameRate, 'frameRate', 1, 60),
      bitrate: integer(options.bitrate, 'bitrate', 100000, 100000000),
      maxPendingFrames: integer(options.maxPendingFrames ?? 8, 'maxPendingFrames', 2, 8),
    };
    this.spawnProcess = dependencies.spawn || spawn;
    this.stopTimeoutMs = dependencies.stopTimeoutMs ?? 2000;
    this.killTimeoutMs = dependencies.killTimeoutMs ?? 500;
    this.capacityTimeoutMs = dependencies.capacityTimeoutMs ?? 5000;
    this.writeTimeoutMs = dependencies.writeTimeoutMs ?? 5000;
    this.state = 'idle';
    this.child = null;
    this.parser = new AnnexBAccessUnitParser();
    this.timestamps = [];
    this.writes = new Set();
    this.lastTimestamp = -1;
    this.stderr = '';
    this.failure = null;
    this.stopRequested = false;
    this.finished = false;
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    // Process errors must remain observable without crashing Electron's main process.
    this.on('error', () => {});
  }

  start() {
    if (this.startPromise) return this.startPromise;
    if (this.state !== 'idle') return Promise.reject(this.failure || new Error('Encoder is stopped'));
    this.state = 'starting';
    this.startPromise = new Promise((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
      try {
        const child = this.child = this.spawnProcess(this.options.ffmpegPath, encoderArguments(this.options), {
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
        child.once('spawn', () => {
          if (this.state !== 'starting') return;
          this.state = 'running';
          resolve();
          this.emit('diagnostic', {backend: this.options.backend, codec: `h264_${this.options.backend}`, state: 'running'});
        });
        child.once('error', error => this.fail(new Error(`Cannot start ${this.options.backend} encoder: ${error.message}`)));
        child.once('close', (code, signal) => this.closed(code, signal));
        child.stdin.on('error', error => {
          if (!this.stopRequested) this.fail(new Error(`${this.options.backend} encoder input failed: ${error.message}`));
        });
        child.stdout.on('data', chunk => {
          if (this.failure || this.finished) return;
          try { this.publish(this.parser.push(chunk)); } catch (error) { this.fail(error); }
        });
        child.stdout.once('end', () => this.flushOutput());
        child.stdout.on('error', error => this.fail(error));
        child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-8192); });
        child.stderr.on('error', error => this.fail(error));
      } catch (error) { this.fail(error); }
    });
    return this.startPromise;
  }

  waitForCapacity() {
    if (this.state !== 'running') return Promise.reject(this.failure || new Error('Encoder is not running'));
    if (this.timestamps.length < this.options.maxPendingFrames) return Promise.resolve();
    if (this.capacityWait) return this.capacityWait.promise;
    const wait = {};
    wait.promise = new Promise((resolve, reject) => { wait.resolve = resolve; wait.reject = reject; });
    wait.timer = setTimeout(() => {
      if (this.capacityWait !== wait) return;
      this.capacityWait = null;
      wait.reject(new Error('Encoder capacity did not recover within 5 seconds'));
    }, this.capacityTimeoutMs);
    this.capacityWait = wait;
    return wait.promise;
  }

  settleCapacity(error) {
    const wait = this.capacityWait;
    if (!wait || (!error && this.timestamps.length >= this.options.maxPendingFrames)) return;
    this.capacityWait = null;
    clearTimeout(wait.timer);
    if (error) wait.reject(error);
    else wait.resolve();
  }

  // Keep data unchanged until this promise resolves. The timestamp is retained
  // until its encoded AU arrives; accepted frames are never silently discarded.
  writeFrame({data, timestamp} = {}) {
    if (this.state !== 'running') return Promise.reject(this.failure || new Error('Encoder is not running'));
    if (!Buffer.isBuffer(data) || data.length !== this.options.width * this.options.height * 4) return Promise.reject(new Error('RGBA frame byte length does not match the configured dimensions'));
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp <= this.lastTimestamp) return Promise.reject(new Error('Frame timestamps must be strictly increasing integer microseconds'));
    if (this.timestamps.length >= this.options.maxPendingFrames) return Promise.reject(new Error('Encoder backpressure limit reached; wait for an encoded frame'));
    this.timestamps.push(timestamp);
    this.lastTimestamp = timestamp;
    return new Promise((resolve, reject) => {
      const write = {reject};
      this.writes.add(write);
      write.timer = setTimeout(() => this.fail(new Error(`${this.options.backend} encoder input stalled for 5 seconds`)), this.writeTimeoutMs);
      try {
        this.child.stdin.write(data, error => {
          if (!this.writes.delete(write)) return;
          clearTimeout(write.timer);
          if (error) {
            reject(error);
            this.fail(new Error(`${this.options.backend} encoder write failed: ${error.message}`));
          } else resolve();
        });
      } catch (error) { this.fail(error); }
    });
  }

  publish(frames) {
    for (const frame of frames) {
      if (!this.timestamps.length) throw new Error('Encoder produced a frame without a submitted timestamp');
      const timestamp = this.timestamps.shift();
      this.settleCapacity();
      this.emit('frame', {...frame, timestamp, width: this.options.width, height: this.options.height});
    }
  }

  flushOutput() {
    if (this.failure || this.finished) return;
    try { this.publish(this.parser.flush()); } catch (error) { this.fail(error); }
  }

  rejectWrites(error) {
    this.settleCapacity(error);
    for (const write of this.writes) {
      clearTimeout(write.timer);
      write.reject(error);
    }
    this.writes.clear();
  }

  fail(error) {
    if (this.failure || this.finished) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.state = 'failed';
    this.rejectStart?.(this.failure);
    this.rejectWrites(this.failure);
    this.emit('error', this.failure);
    if (!this.child) return this.finish();
    this.child.kill();
    this.armForceFinish();
  }

  closed(code, signal) {
    if (this.finished) return;
    if (!this.failure && code !== 0 && !this.stopRequested) {
      this.fail(new Error(`${this.options.backend} encoder exited (${code ?? signal}): ${this.stderr.trim() || 'backend unavailable'}`));
    }
    if (!this.failure && !this.killedForStop) {
      this.flushOutput();
      if (!this.failure && this.timestamps.length) this.fail(new Error(`Encoder exited with ${this.timestamps.length} submitted frame(s) missing`));
    }
    if (!this.failure && !this.stopRequested) this.fail(new Error(`${this.options.backend} encoder exited unexpectedly (${code ?? signal})`));
    if (this.state === 'starting') this.rejectStart(new Error('Encoder exited before starting'));
    this.finish();
  }

  armForceFinish() {
    if (this.forceTimer || this.finished) return;
    this.forceTimer = setTimeout(() => this.finish(), this.killTimeoutMs);
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.stopTimer);
    clearTimeout(this.forceTimer);
    this.rejectStart?.(this.failure || new Error('Encoder stopped before starting'));
    this.rejectWrites(this.failure || new Error('Encoder stopped'));
    this.child?.stdin.destroy();
    this.child?.stdout.destroy();
    this.child?.stderr.destroy();
    this.timestamps.length = 0;
    this.parser.buffer = Buffer.alloc(0);
    if (!this.failure) this.state = 'stopped';
    this.resolveDone();
  }

  stop() {
    if (this.stopRequested || this.finished) return this.done;
    this.stopRequested = true;
    if (!this.child) {
      this.finish();
      return this.done;
    }
    if (!this.failure) this.state = 'stopping';
    this.rejectWrites(new Error('Encoder stopped'));
    this.child.stdin.end();
    this.stopTimer = setTimeout(() => {
      this.killedForStop = true;
      this.child.kill();
      this.armForceFinish();
    }, this.stopTimeoutMs);
    return this.done;
  }
}

module.exports = {NativeEncoderSession, AnnexBAccessUnitParser, encoderArguments, MAX_ENCODED_BYTES};
