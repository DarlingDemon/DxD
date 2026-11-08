// SPDX-License-Identifier: AGPL-3.0-or-later
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ASSET = 'assets/eeb38a34f675f19c.js';
const BASELINE = 'ff83f386e7679961cac4016a00b601ec85b3abc5765240dd7e69c372b8774641';
const METHOD = 'getPreferredScreenShareCodec(){';
const INJECTION = 'const dxd=globalThis.dxdNativeEncoderRenderer;if(dxd&&dxd.getBackend()!=="auto")return"h264";';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function patchRendererNativeEncoderPolicy(directory) {
  const mapPath = path.join(directory, 'module-map.json');
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  assert.equal(map.build.version, '2026.1106.11354');
  assert.equal(map.build.channel, 'canary');
  assert.equal(map.build.desktopRenderer, true);
  assert.equal(map.modules['fluxer_app/src/features/voice/state/VoiceSettings.ts'].id, 49939);
  const assetPath = path.join(directory, ASSET);
  const input = fs.readFileSync(assetPath, 'utf8');
  assert.equal(sha256(input), map.assets[ASSET], 'Voice settings integrity mismatch');
  const original = input.replace(METHOD + INJECTION, METHOD);
  assert.equal(sha256(original), BASELINE, 'Unsupported voice settings renderer');
  assert.equal(original.split(METHOD).length, 2, 'Ambiguous codec preference method');
  const output = original.replace(METHOD, METHOD + INJECTION);
  if (output === input) return {changed: false};
  map.assets[ASSET] = sha256(output);
  fs.writeFileSync(assetPath, output);
  fs.writeFileSync(mapPath, JSON.stringify(map));
  return {changed: true, sha256: map.assets[ASSET]};
}

module.exports = {patchRendererNativeEncoderPolicy, METHOD, INJECTION};
if (require.main === module) {
  assert.ok(process.argv[2], 'Pass the prepared renderer directory');
  console.log(JSON.stringify(patchRendererNativeEncoderPolicy(path.resolve(process.argv[2]))));
}
