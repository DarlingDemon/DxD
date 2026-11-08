// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ASSET = 'assets/6f68122e39b9cb42.js';
const BASELINE = '4a1bb8a61314460aa141d84841c280f91d553d8a5311c73fdec441697c44dcd7';
const ORIGINAL = 'bootstrap(){return S(function*(){var e;(null==(e=(0,c.dl)())?void 0:e.offlineBuild)!==!0&&(this.isNative&&(yield this.bootstrapNative(),yield this.bootstrapDesktopUpdate()),this.startBackgroundChecks(),this.checkForUpdates(!1))}).call(this)}';
const REPLACEMENT = 'bootstrap(){return S(function*(){var e;if((null==(e=(0,c.dl)())?void 0:e.offlineBuild)===!0){this.isNative&&(yield this.bootstrapNative(),yield this.bootstrapDesktopUpdate());return}this.isNative&&(yield this.bootstrapNative(),yield this.bootstrapDesktopUpdate()),this.startBackgroundChecks(),this.checkForUpdates(!1)}).call(this)}';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function patchRendererDesktopUpdate(directory) {
  const mapPath = path.join(directory, 'module-map.json');
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  assert.equal(map.build.version, '2026.1106.11354');
  assert.equal(map.build.channel, 'canary');
  assert.equal(map.build.desktopRenderer, true);
  assert.equal(map.modules['fluxer_app/src/features/app/state/Updater.ts'].id, 970591);
  const file = path.join(directory, ASSET);
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(sha256(source), map.assets[ASSET], 'Updater integrity mismatch');
  const restored = source.replace(REPLACEMENT, ORIGINAL);
  assert.equal(sha256(restored), BASELINE, 'Unsupported updater renderer');
  assert.equal(restored.split(ORIGINAL).length, 2, 'Ambiguous updater bootstrap');
  const output = restored.replace(ORIGINAL, REPLACEMENT);
  if (source === output) return {changed: false, asset: ASSET, sha256: sha256(output)};
  new vm.Script(output);
  map.assets[ASSET] = sha256(output);
  fs.writeFileSync(file, output);
  fs.writeFileSync(mapPath, JSON.stringify(map));
  return {changed: true, asset: ASSET, sha256: map.assets[ASSET]};
}

module.exports = {patchRendererDesktopUpdate, ASSET, BASELINE, ORIGINAL, REPLACEMENT};
if (require.main === module) {
  assert.ok(process.argv[2], 'Pass the prepared renderer directory');
  console.log(JSON.stringify(patchRendererDesktopUpdate(path.resolve(process.argv[2]))));
}
