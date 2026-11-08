// SPDX-License-Identifier: AGPL-3.0-or-later
const assert = require('node:assert/strict');
const test = require('node:test');
const {METHOD, INJECTION} = require('./patch-renderer-native-encoder-policy.cjs');

test('forced native encoders request H264 before outer screen-share policy validation', () => {
  const create = new Function('globalThis', 'return {' + METHOD + INJECTION + 'return this.preferredScreenShareCodec;}}');
  for (const backend of ['nvenc', 'amf']) {
    const settings = create({dxdNativeEncoderRenderer: {getBackend: () => backend}});
    settings.preferredScreenShareCodec = 'vp9';
    assert.equal(settings.getPreferredScreenShareCodec(), 'h264');
  }
  for (const globals of [{}, {dxdNativeEncoderRenderer: {getBackend: () => 'auto'}}]) {
    const settings = create(globals);
    settings.preferredScreenShareCodec = 'vp9';
    assert.equal(settings.getPreferredScreenShareCodec(), 'vp9');
  }
});
