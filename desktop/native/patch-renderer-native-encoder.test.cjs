// SPDX-License-Identifier: AGPL-3.0-or-later
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {patchRendererNativeEncoder, getFactory, ASSET, BASELINE_SHA256, INSTALL} = require('./patch-renderer-native-encoder.cjs');
const renderer = process.env.DXD_TEST_RENDERER_DIR || path.resolve(__dirname, '../../../dxd-native-windows/upstream-runtime/dist/renderer');
const available = fs.existsSync(path.join(renderer, ASSET));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('pinned renderer installs exact LiveKit hook, early script and coherent integrity; second run is unchanged', {skip: !available}, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxd-native-renderer-'));
  t.after(() => {assert.ok(path.basename(temp).startsWith('dxd-native-renderer-')); fs.rmSync(temp, {recursive: true, force: true});});
  fs.mkdirSync(path.join(temp, 'assets'));
  for (const file of ['version.json', 'module-map.json', 'index.html', ASSET]) fs.copyFileSync(path.join(renderer, file), path.join(temp, file));
  const baseline = fs.readFileSync(path.join(temp, ASSET), 'utf8');
  assert.equal(hash(baseline), BASELINE_SHA256);
  const result = patchRendererNativeEncoder(temp);
  assert.equal(result.changed, true);
  const patched = fs.readFileSync(path.join(temp, ASSET), 'utf8');
  const factory = getFactory(patched);
  assert.ok(factory.endsWith(INSTALL + '}'));
  assert.equal(patched.replace(factory, factory.slice(0, -(INSTALL.length + 1)) + '}'), baseline);
  new vm.Script(patched);
  const map = JSON.parse(fs.readFileSync(path.join(temp, 'module-map.json'), 'utf8'));
  for (const file of [ASSET, 'native-encoder-renderer.js', 'native-encoder-worker.js']) assert.equal(map.assets[file], hash(fs.readFileSync(path.join(temp, file))));
  const index = fs.readFileSync(path.join(temp, 'index.html'), 'utf8');
  assert.ok(index.indexOf('data-dxd-native-encoder') < index.indexOf('src="/assets/'));
  assert.equal(patchRendererNativeEncoder(temp).changed, false);
  const coherentStale = patched + '\n// stale';
  fs.writeFileSync(path.join(temp, ASSET), coherentStale);
  map.assets[ASSET] = hash(coherentStale);
  fs.writeFileSync(path.join(temp, 'module-map.json'), JSON.stringify(map));
  assert.throws(() => patchRendererNativeEncoder(temp), /Unsupported LiveKit asset SHA256/);
  assert.equal(fs.readFileSync(path.join(temp, ASSET), 'utf8'), coherentStale);
});
