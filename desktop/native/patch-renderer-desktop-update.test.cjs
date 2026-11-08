// SPDX-License-Identifier: AGPL-3.0-or-later
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {test} = require('node:test');
const {patchRendererDesktopUpdate, ASSET, BASELINE, ORIGINAL, REPLACEMENT} = require('./patch-renderer-desktop-update.cjs');

// Execute the actual injected generator method, including its asynchronous
// subscription sequence, rather than mirroring it with a separate predicate.
const generatorToAsync = generator => function (...args) {
  const iterator = generator.apply(this, args);
  return (async () => {
    let result = iterator.next();
    while (!result.done) {
      try {result = iterator.next(await result.value);}
      catch (error) {result = iterator.throw(error);}
    }
    return result.value;
  })();
};
for (const [offline, native, expected] of [
  [true, true, ['native-events', 'desktop-state']],
  [true, false, []],
  [false, true, ['native-events', 'desktop-state', 'background', 'check']],
  [false, false, ['background', 'check']],
]) {
  test(`updater bootstrap subscribes correctly: offline=${offline}, native=${native}`, async () => {
    const calls = [];
    const component = new Function('S', 'c', `return {${REPLACEMENT}};`)(generatorToAsync, {dl: () => ({offlineBuild: offline})});
    Object.assign(component, {
      isNative: native,
      async bootstrapNative() {await Promise.resolve(); calls.push('native-events');},
      async bootstrapDesktopUpdate() {calls.push('desktop-state');},
      startBackgroundChecks() {calls.push('background');},
      checkForUpdates(force) {assert.equal(force, false); calls.push('check');},
    });
    await component.bootstrap();
    assert.deepEqual(calls, expected);
  });
}

test('renderer patch preserves prior modifications and rejects integrity drift', t => {
  const baselineDir = process.env.DXD_TEST_RENDERER_DIR || path.join(__dirname, 'payload/dist/renderer');
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const temporary = fs.mkdtempSync(path.join(temporaryRoot, 'dxd-update-renderer-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(temporary)), temporaryRoot);
    assert.ok(path.basename(temporary).startsWith('dxd-update-renderer-'));
    fs.rmSync(temporary, {recursive: true, force: true});
  });
  const original = fs.readFileSync(path.join(baselineDir, ASSET), 'utf8').replace(REPLACEMENT, ORIGINAL);
  assert.equal(crypto.createHash('sha256').update(original).digest('hex'), BASELINE);
  const map = JSON.parse(fs.readFileSync(path.join(baselineDir, 'module-map.json')));
  map.assets[ASSET] = BASELINE;
  const preserved = {...map.assets};
  fs.mkdirSync(path.join(temporary, 'assets'));
  fs.writeFileSync(path.join(temporary, ASSET), original);
  fs.writeFileSync(path.join(temporary, 'module-map.json'), JSON.stringify(map));
  const result = patchRendererDesktopUpdate(temporary);
  assert.equal(result.changed, true);
  const patched = fs.readFileSync(path.join(temporary, ASSET), 'utf8');
  assert.equal(patched.replace(REPLACEMENT, ORIGINAL), original);
  assert.equal(patched.split(REPLACEMENT).length, 2);
  assert.deepEqual(patchRendererDesktopUpdate(temporary), {...result, changed: false});
  const actual = JSON.parse(fs.readFileSync(path.join(temporary, 'module-map.json')));
  for (const [key, value] of Object.entries(preserved)) if (key !== ASSET) assert.equal(actual.assets[key], value);
  fs.appendFileSync(path.join(temporary, ASSET), '// drift');
  assert.throws(() => patchRendererDesktopUpdate(temporary));
});
