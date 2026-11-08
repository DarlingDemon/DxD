// SPDX-License-Identifier: AGPL-3.0-or-later
// RTCEncodedSource bypasses Chromium's encoder; these bytes come from NVENC/AMF.
(() => {
  let writer;
  let codec;
  let writing = false;
  let stopped = false;
  let needsKeyframe = true;
  const queue = [];
  const fail = error => self.postMessage({type: 'error', message: String(error?.message || error)});
  async function drain() {
    if (writing || !writer || !codec) return;
    writing = true;
    try {
      while (queue.length && !stopped) {
        const frame = queue.shift();
        await writer.write(new RTCEncodedVideoFrame({
          type: frame.keyframe ? 'key' : 'delta', payloadType: codec.payloadType,
          mimeType: 'video/H264', data: frame.data, width: frame.width, height: frame.height,
          timestamp: frame.timestamp, rtpTimestampWithoutOffset: Math.round(frame.timestamp * 0.09) >>> 0,
        }));
      }
    } catch (error) {fail(error);} finally {writing = false;}
  }
  self.addEventListener('rtcsenderencodedsource', event => {
    const source = event.encodedSource;
    writer = source.writable.getWriter();
    source.onkeyframerequest = () => self.postMessage({type: 'keyframe'});
    source.onbitrateinfochange = () => self.postMessage({type: 'bitrate', bitrate: source.allocatedBitrate});
    self.postMessage({type: 'ready'});
    void drain();
  });
  self.onmessage = event => {
    const message = event.data;
    if (message.type === 'configure') {codec = message; void drain();}
    if (message.type === 'reset') {queue.length = 0; needsKeyframe = true;}
    if (message.type === 'stop') {stopped = true; queue.length = 0; void writer?.abort().catch(() => undefined);}
    if (message.type !== 'frame' || stopped) return;
    // A lost delta invalidates later dependent frames. Resume only at an IDR.
    if (queue.length >= 3) {queue.length = 0; needsKeyframe = true; self.postMessage({type: 'keyframe'});}
    if (needsKeyframe && !message.keyframe) return;
    if (message.keyframe) needsKeyframe = false;
    queue.push(message);
    void drain();
  };
})();
