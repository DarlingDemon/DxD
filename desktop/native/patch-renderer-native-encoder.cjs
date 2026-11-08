// SPDX-License-Identifier: AGPL-3.0-or-later
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ASSET = 'assets/f56889344309eb47.js';
const BASELINE_SHA256 = 'b639465a5b169e1b81462cc0f9db77f22706fc6a382a162b5fcecb61fb518801';
const FACTORY_SHA256 = 'dd50761b77e2526aca432e66500d3c64bb4469ee76f7bb6327f7801893b38de6';
const MODULE = 'fluxer_app/pkgs/livekit-client/src/room/participant/LocalParticipant.ts';
const INSTALL = ';globalThis.dxdNativeEncoderRenderer.install(o3);';
const SCRIPT = 'native-encoder-renderer.js';
const WORKER = 'native-encoder-worker.js';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
function getFactory(source) {
  const chunks = [];
  new vm.Script(source).runInNewContext({self: {rspackChunkfluxer_app: chunks}}, {timeout: 1000});
  const factories = chunks.flatMap(chunk => Object.entries(chunk[1]));
  const matches = factories.filter(([id]) => id === '823130');
  assert.equal(matches.length, 1, 'Expected exactly one LiveKit factory');
  return matches[0][1].toString();
}
function patchRendererNativeEncoder(rendererDir) {
  const version = JSON.parse(fs.readFileSync(path.join(rendererDir, 'version.json'), 'utf8'));
  assert.equal(version.version, '2026.1106.11354', 'Unsupported renderer version');
  const mapPath = path.join(rendererDir, 'module-map.json');
  const mapText = fs.readFileSync(mapPath, 'utf8');
  const map = JSON.parse(mapText);
  assert.equal(map.build?.version, version.version, 'Unsupported module-map version');
  assert.equal(map.build?.channel, 'canary', 'Unsupported renderer channel');
  assert.equal(map.build?.desktopRenderer, true, 'Expected desktop renderer');
  assert.equal(map.modules?.[MODULE]?.concatenatedInto, 823130, 'Unexpected LocalParticipant module');
  const assetPath = path.join(rendererDir, ASSET);
  const source = fs.readFileSync(assetPath, 'utf8');
  assert.equal(map.assets?.[ASSET], sha256(source), 'LiveKit asset integrity mismatch');
  assert.ok(source.split(INSTALL).length <= 2, 'Duplicate native encoder hook');
  const baseline = source.replace(INSTALL, '');
  // Only evaluate the verified upstream registration, even when the map and a stale asset agree.
  assert.equal(sha256(baseline), BASELINE_SHA256, 'Unsupported LiveKit asset SHA256');
  const baselineFactory = getFactory(baseline);
  assert.equal(sha256(baselineFactory), FACTORY_SHA256, 'Unsupported LiveKit factory');
  assert.equal(baseline.split(baselineFactory).length, 2, 'Ambiguous LiveKit factory location');
  const transformed = baseline.replace(baselineFactory, baselineFactory.slice(0, -1) + INSTALL + '}');
  const script = fs.readFileSync(path.join(__dirname, SCRIPT));
  const worker = fs.readFileSync(path.join(__dirname, WORKER));
  const indexPath = path.join(rendererDir, 'index.html');
  const index = fs.readFileSync(indexPath, 'utf8');
  const tag = `<script defer src="/${SCRIPT}" integrity="sha256-${crypto.createHash('sha256').update(script).digest('base64')}" crossorigin="anonymous" data-dxd-native-encoder></script>`;
  const marker = /<script\b[^>]*\bdata-dxd-native-encoder\b[^>]*><\/script>/g;
  assert.ok((index.match(marker) || []).length <= 1, 'Duplicate native encoder entry');
  const cleanIndex = index.replace(marker, '');
  const entry = /<script\b(?=[^>]*\bsrc=)(?=[^>]*(?:\bdefer\b|\btype=["']module["']))[^>]*>/;
  assert.ok(entry.test(cleanIndex), 'Renderer entry script is missing');
  const updatedIndex = cleanIndex.replace(entry, match => tag + match);
  map.assets[ASSET] = sha256(transformed); map.assets[SCRIPT] = sha256(script); map.assets[WORKER] = sha256(worker);
  const updatedMap = JSON.stringify(map) + (mapText.endsWith('\n') ? '\n' : '');
  const writes = [[assetPath, transformed], [indexPath, updatedIndex], [mapPath, updatedMap], [path.join(rendererDir, SCRIPT), script], [path.join(rendererDir, WORKER), worker]];
  let changed = false;
  for (const [file, contents] of writes) {
    if (fs.existsSync(file) && fs.readFileSync(file).equals(Buffer.from(contents))) continue;
    fs.writeFileSync(file, contents); changed = true;
  }
  return {changed, asset: ASSET, sha256: map.assets[ASSET]};
}
module.exports = {patchRendererNativeEncoder, getFactory, ASSET, BASELINE_SHA256, INSTALL};
if (require.main === module) {
  assert.ok(process.argv[2], 'Pass the prepared renderer directory');
  console.log(JSON.stringify(patchRendererNativeEncoder(path.resolve(process.argv[2]))));
}
