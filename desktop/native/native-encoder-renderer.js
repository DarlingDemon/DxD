// SPDX-License-Identifier: AGPL-3.0-or-later
(() => {
  const workerUrl = new URL('native-encoder-worker.js', document.currentScript?.src || location.href).href;
  const sessions = new WeakMap();
  const activeSessions = new Set();
  const publications = new WeakMap();
  const installed = new WeakSet();
  let desiredBackend = globalThis.dxdNativeEncoder?.initialBackend || 'auto';
  const updateBackend = settings => {if (['auto', 'nvenc', 'amf'].includes(settings?.backend)) desiredBackend = settings.backend;};
  globalThis.dxdNativeEncoder?.onSettings?.(updateBackend);
  const clamp = (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value) || fallback));
  const mediaTrack = track => track?.mediaStreamTrack || track;
  const isScreen = (track, options) => (options?.source || track?.source) === 'screen_share' && (track?.kind || mediaTrack(track)?.kind) === 'video';
  const timeout = (promise, label) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error(label)), 10000);})]).finally(() => clearTimeout(timer));
  };
  class NativeScreenSession {
    constructor(participant, track, backend, options, unpublish, bridge) {
      Object.assign(this, {participant, track, backend, options, unpublish, bridge});
      this.sender = track.sender;
      this.originalReplaceTrack = this.sender?.replaceTrack;
      this.nativeReplaceTrack = value => this.originalReplaceTrack.call(this.sender, value);
      this.interceptedReplaceTrack = value => this.changeSource(value);
      this.source = mediaTrack(track);
      this.stopped = false;
      this.paused = false;
      this.generation = 0;
      this.lastTimestamp = -1;
      this.nativeId = null;
      this.lastRestart = 0;
      this.pendingKeyframe = false;
      this.frameRate = Math.round(clamp(options.screenShareEncoding?.maxFramerate || this.source.getSettings().frameRate, 30, 1, 60));
      this.maxBitrate = Math.round(clamp(options.screenShareEncoding?.maxBitrate || options.videoEncoding?.maxBitrate, 8000000, 128000, 50000000));
      this.bitrate = this.maxBitrate;
      this.onEnded = () => {void this.stop();};
    }
    async start() {
      if (typeof this.sender?.createEncodedSource !== 'function' || typeof MediaStreamTrackProcessor !== 'function') throw new Error('Native encoding requires the packaged RTCEncodedSource runtime');
      const codec = this.sender.getParameters().codecs?.find(value => value.mimeType?.toLowerCase() === 'video/h264');
      if (!codec || !/packetization-mode=1/.test(codec.sdpFmtpLine || '') || !/profile-level-id=42[ce]0/i.test(codec.sdpFmtpLine || '')) throw new Error('Native encoding requires negotiated H.264 constrained baseline');
      this.worker = new Worker(workerUrl);
      let ready, rejectReady;
      const workerReady = new Promise((resolve, reject) => {ready = resolve; rejectReady = reject;});
      void workerReady.catch(() => undefined);
      this.worker.onerror = event => {const error = new Error(event.message || 'Native video worker failed'); rejectReady(error); void this.fail(error);};
      this.worker.onmessage = event => {
        const message = event.data;
        if (message.type === 'ready') ready();
        if (message.type === 'error') {const error = new Error(message.message); rejectReady(error); void this.fail(error);}
        if (message.type === 'keyframe') this.pendingKeyframe = true;
        if (message.type === 'bitrate' && message.bitrate > 0) {
          const next = clamp(message.bitrate, this.maxBitrate, 128000, this.maxBitrate);
          if (Math.abs(next - this.bitrate) >= Math.max(100000, this.bitrate * 0.25)) this.pendingBitrate = next;
        }
      };
      this.offFrame = this.bridge.onFrame(frame => {
        if (this.stopped || frame.id !== this.nativeId) return;
        const data = frame.data instanceof ArrayBuffer ? frame.data : new Uint8Array(frame.data).buffer;
        this.worker.postMessage({type: 'frame', ...frame, data}, [data]);
      });
      this.offEnd = this.bridge.onEnd(event => {
        if (!this.stopped && event.id === this.nativeId) void this.fail(new Error(event.error || 'Native video encoder stopped unexpectedly'));
      });
      await this.nativeReplaceTrack(null);
      await timeout(this.sender.createEncodedSource(this.worker), 'Native video source did not initialize');
      await timeout(workerReady, 'Native video worker did not initialize');
      this.worker.postMessage({type: 'configure', payloadType: codec.payloadType});
      this.sender.replaceTrack = this.interceptedReplaceTrack;
      await this.bindSource(this.source);
    }
    async clearCapture() {
      this.generation++;
      this.source.removeEventListener('ended', this.onEnded);
      const reader = this.reader; this.reader = null;
      this.clone?.stop(); this.clone = null;
      try {await reader?.cancel();} catch {}
      const nativeId = this.nativeId; this.nativeId = null;
      this.worker?.postMessage({type: 'reset'});
      if (nativeId) await this.bridge.stop(nativeId);
    }
    changeSource(source) {
      const change = (this.sourceChange || Promise.resolve()).then(async () => {
        if (this.stopped) return;
        this.paused = source === null;
        await this.clearCapture();
        if (!source || this.stopped) return;
        await this.bindSource(source);
      }).catch(async error => {if (!this.stopped) {await this.fail(error); throw error;}});
      this.sourceChange = change.catch(() => undefined);
      return change;
    }
    async bindSource(source) {
      this.source = source;
      this.source.addEventListener('ended', this.onEnded);
      this.clone = source.clone();
      const reader = this.reader = new MediaStreamTrackProcessor({track: this.clone}).readable.getReader();
      const generation = ++this.generation;
      const first = await timeout(reader.read(), 'Screen capture did not produce a frame');
      if (generation !== this.generation || this.stopped) {first.value?.close(); return;}
      if (first.done) throw new Error('Screen capture ended before native encoding started');
      await this.write(first.value, generation);
      if (this.stopped) throw new Error('Native video source stopped while starting');
      this.pumpPromise = this.pump(reader, generation).catch(error => {if (generation === this.generation && !this.paused) return this.fail(error);});
    }
    async restart(width, height, generation) {
      const previous = this.nativeId;
      this.nativeId = null;
      this.worker.postMessage({type: 'reset'});
      if (previous) await this.bridge.stop(previous);
      if (this.stopped) return;
      this.bitrate = this.pendingBitrate || this.bitrate;
      this.pendingBitrate = null;
      this.pendingKeyframe = false;
      const opened = await this.bridge.start({backend: this.backend, width, height, frameRate: this.frameRate, bitrate: this.bitrate});
      if (this.stopped || generation !== this.generation) {await this.bridge.stop(opened.id); return;}
      this.nativeId = opened.id;
      this.width = width; this.height = height;
      this.lastRestart = performance.now();
    }
    async write(frame, generation) {
      try {
        if (this.stopped || this.paused || generation !== this.generation) return;
        if (this.sender.track !== null) throw new Error('Screen-share sender changed; restart sharing to use the selected native encoder');
        const rect = frame.visibleRect || {x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight};
        const width = Math.floor(rect.width / 2) * 2, height = Math.floor(rect.height / 2) * 2;
        if (!width || !height) throw new Error('Screen capture frame is empty');
        const changed = width !== this.width || height !== this.height;
        if (!this.nativeId || changed || ((this.pendingKeyframe || this.pendingBitrate) && performance.now() - this.lastRestart >= 2000)) await this.restart(width, height, generation);
        if (this.stopped || generation !== this.generation || !this.nativeId) return;
        const data = new ArrayBuffer(width * height * 4);
        await frame.copyTo(data, {format: 'RGBA', rect: {x: rect.x, y: rect.y, width, height}, layout: [{offset: 0, stride: width * 4}]});
        // Preserve capture time across encoder restarts and bridge a new capture clock monotonically.
        if (this.timestampGeneration !== generation) {
          this.timestampOffset = this.lastTimestamp < 0 ? 0 : Math.max(0, this.lastTimestamp + Math.round(1000000 / this.frameRate) - frame.timestamp);
          this.timestampGeneration = generation;
        }
        const timestamp = frame.timestamp + this.timestampOffset;
        if (!this.stopped && generation === this.generation && timestamp > this.lastTimestamp) {
          this.lastTimestamp = timestamp;
          await this.bridge.writeFrame(this.nativeId, {data, timestamp});
        }
      } finally {frame.close();}
    }
    async pump(reader, generation) {
      while (!this.stopped && generation === this.generation) {
        const next = await reader.read();
        if (next.done) {if (!this.stopped && generation === this.generation) await this.stop(); return;}
        await this.write(next.value, generation);
      }
    }
    async fail(error) {
      if (this.stopped || this.failed) return;
      this.failed = true;
      await this.stop();
      try {await this.unpublish.call(this.participant, this.track);} catch {}
      const audio = this.participant.getTrackPublication?.('screen_share_audio')?.track;
      if (audio) {try {await this.unpublish.call(this.participant, audio);} catch {}}
      this.bridge.reportError(`${this.backend.toUpperCase()}: ${error?.message || error}`);
    }
    async stop() {
      if (this.stopPromise) return this.stopPromise;
      this.stopped = true;
      activeSessions.delete(this);
      this.stopPromise = (async () => {
        this.offFrame?.(); this.offEnd?.();
        if (this.sender?.replaceTrack === this.interceptedReplaceTrack) this.sender.replaceTrack = this.originalReplaceTrack;
        await this.clearCapture().catch(() => undefined);
        this.worker?.postMessage({type: 'stop'}); this.worker?.terminate();
        try {await this.nativeReplaceTrack(null);} catch {}
      })();
      return this.stopPromise;
    }
  }
  function install(LocalParticipant) {
    if (installed.has(LocalParticipant)) return;
    installed.add(LocalParticipant);
    const prototype = LocalParticipant.prototype;
    const publish = prototype.publishOrRepublishTrack;
    const unpublish = prototype.unpublishTrack;
    if (typeof publish !== 'function' || typeof unpublish !== 'function') throw new Error('Unsupported LiveKit native encoder integration');
    prototype.publishOrRepublishTrack = async function(track, options, ...rest) {
      const bridge = globalThis.dxdNativeEncoder;
      if (!bridge || !isScreen(track, options)) return publish.call(this, track, options, ...rest);
      const pending = publications.get(track);
      // LiveKit retries negotiation from inside its own outstanding publication.
      if (pending && rest[1] === true) return publish.call(this, track, options, ...rest);
      if (pending) {await pending; return this.publishOrRepublishTrack(track, options, ...rest);}
      const operation = (async () => {
        const active = sessions.get(track);
        const settings = active && !active.stopped ? {backend: active.backend} : await bridge.getSettings();
        if (!active || active.stopped) updateBackend(settings);
        if (settings.backend === 'auto') return publish.call(this, track, options, ...rest);
        let session, publication;
        try {
          if (!['nvenc', 'amf'].includes(settings.backend)) throw new Error('Unknown native video encoder');
          if (settings.backends && !settings.backends[settings.backend]) throw new Error('Selected native video encoder is unavailable');
          const forced = {...options, videoCodec: 'h264', simulcast: false, backupCodec: false, scalabilityMode: 'L1T1'};
          publication = await publish.call(this, track, forced, ...rest);
          const local = publication.track;
          const current = sessions.get(local);
          if (current && !current.stopped && current.sender === local.sender) {sessions.set(track, current); return publication;}
          await active?.stop();
          session = new NativeScreenSession(this, local, settings.backend, forced, unpublish, bridge);
          activeSessions.add(session);
          sessions.set(track, session); sessions.set(local, session); sessions.set(mediaTrack(local), session);
          await session.start();
          return publication;
        } catch (error) {
          await session?.stop();
          if (publication?.track) {try {await unpublish.call(this, publication.track);} catch {}}
          if (!session?.failed) bridge.reportError(`${settings.backend.toUpperCase()}: ${error?.message || error}`);
          throw error;
        }
      })();
      publications.set(track, operation);
      try {return await operation;} finally {if (publications.get(track) === operation) publications.delete(track);}
    };
    prototype.unpublishTrack = async function(track, ...args) {
      await publications.get(track)?.catch(() => undefined);
      const session = sessions.get(track) || sessions.get(mediaTrack(track));
      await session?.stop();
      return unpublish.call(this, track, ...args);
    };
  }
  globalThis.dxdNativeEncoderRenderer = Object.freeze({install, getBackend: () => {
    for (const session of activeSessions) if (!session.stopped) return session.backend;
    return desiredBackend;
  }});
})();
