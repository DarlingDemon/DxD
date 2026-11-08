// SPDX-License-Identifier: AGPL-3.0-or-later
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {patchRendererGpu, GPU_CODEC_COMPONENT} = require('./patch-renderer-gpu.cjs');

const ASSET = 'assets/68382951b0e1f025.js';
const BASELINE_SHA256 = '5a3d42e4bc6959c4572a431f58ba3275aeb458d678e4d7b1a5d534998afe7ae3';
const renderer = process.env.DXD_TEST_RENDERER_DIR || path.join(__dirname, 'upstream-runtime/dist/renderer');
const baselineAvailable = fs.existsSync(path.join(renderer, ASSET));
const codecs = ['av1', 'h265', 'h264', 'vp9', 'vp8'];

function renderControl({gpu = null, locale = 'en-US', hardware = [], unknown = [], optIn = false} = {}) {
  const updates = [];
  let hookCalls = 0;
  const element = (type, props) => ({type, props});
  const context = {
    C: {PA: component => component},
    S: {uB: () => ({i18n: {locale, _: (descriptor, values = {}) => descriptor.message.replace(/\{(\w+)\}/g, (_, key) => values[key])}})},
    au: {A: {
      getScreenShareEncoderMode: () => 'auto', getPreferredScreenShareCodec: () => 'vp9',
      getScreenShareAv1OptIn: () => optIn, getScreenShareHevcOptIn: () => optIn,
    }},
    ad: {y: settings => updates.push({...settings})},
    am: {
      Uc: () => ({codec: hardware.includes('av1') && optIn ? 'av1' : 'h264'}),
      l3: () => Object.fromEntries(codecs.map(codec => [codec, {
        supported: !['av1', 'h265'].includes(codec) || optIn,
        hardwareAccelerated: unknown.includes(codec) ? 'unknown' : hardware.includes(codec) ? 'hardware' : 'software',
      }])),
    },
    aE: () => { hookCalls++; return gpu; },
    aD: codecs,
    ap: {av1: 'AV1', h265: 'H.265 (HEVC)', h264: 'H.264', vp9: 'VP9', vp8: 'VP8'},
    aT: {message: 'Automatic ({codec})'}, aP: {message: 'AV1 (requires opt-in)'},
    aO: {message: 'H.265 (requires opt-in)'}, aA: {message: 'Preferred screen share codec'},
    s: {jsx: element, jsxs: element}, eC: {G: 'combobox'}, d: {$: 'button'}, l: {lv: 'compact', jg: 'description'},
  };
  const component = new vm.Script(GPU_CODEC_COMPONENT + ';aU;').runInNewContext(context);
  const tree = component();
  assert.equal(hookCalls, 1, 'Reuse the existing asynchronous GPU report hook');
  return {tree, children: tree.props.children.filter(Boolean), updates};
}

for (const gpu of [
  {name: 'NVIDIA GeForce RTX 4080', hardware: ['av1', 'h265', 'h264']},
  {name: 'AMD Radeon RX 7900 XT', hardware: ['av1', 'h265', 'h264']},
  {name: 'NVIDIA GeForce RTX 3060', hardware: ['h265', 'h264']},
]) {
  test(`GPU recommendation and capabilities: ${gpu.name}`, () => {
    const {children, updates} = renderControl({gpu: {gpuLabel: gpu.name}, hardware: gpu.hardware});
    const [select, description, button] = children;
    assert.equal(select.props.value, 'vp9');
    assert.equal(select.props['aria-label'], 'Preferred screen share codec');
    assert.equal(select.props['data-flx'], 'user.advanced-settings-tab.select.preferred-screen-share-codec');
    assert.equal(select.props.wrapMenuText, true);
    assert.equal(select.props.options.find(option => option.value === 'h264').label, 'H.264 (hardware available)');
    assert.equal(select.props.options.find(option => option.value === 'vp9').label, 'VP9 (software encoding)');
    const av1 = select.props.options.find(option => option.value === 'av1');
    assert.equal(av1.isDisabled, true);
    assert.match(av1.label, /requires opt-in/);
    assert.equal(description.props.children, `Detected GPU: ${gpu.name}`);
    button.props.onClick();
    assert.deepEqual(updates, [{preferredScreenShareCodec: 'auto', screenShareEncoderMode: 'hardware'}]);
    select.props.onChange('h264');
    assert.deepEqual(updates[1], {preferredScreenShareCodec: 'h264'});
  });
}

test('browser or pending GPU report keeps manual options usable without GPU controls', () => {
  const {children} = renderControl({unknown: codecs});
  assert.equal(children.length, 1);
  assert.equal(children[0].props.options.find(option => option.value === 'h264').label, 'H.264 (hardware support unknown)');
  assert.equal(children[0].props.options.find(option => option.value === 'h264').isDisabled, false);
});

test('RU and UK labels follow the selected locale, and GPU names remain literal', () => {
  for (const [locale, expectedGpu, expectedButton] of [
    ['ru-RU', 'Обнаружена видеокарта: GPU $&', 'Подобрать для моей видеокарты'],
    ['uk', 'Виявлена відеокарта: GPU $&', 'Підібрати для моєї відеокарти'],
  ]) {
    const {children} = renderControl({gpu: {gpuLabel: 'GPU $&'}, locale, hardware: ['h264']});
    assert.equal(children[1].props.children, expectedGpu);
    assert.equal(children[2].props.children, expectedButton);
    assert.match(children[0].props.options.find(option => option.value === 'h264').label, /аппаратное|апаратне/);
  }
  assert.equal(renderControl({locale: 'fr'}).children[0].props.options[3].label, 'H.264 (software encoding)');
});

test('opted-in modern hardware exposes AV1 without changing the manual selection', () => {
  const {children} = renderControl({hardware: ['av1', 'h265', 'h264'], optIn: true});
  const select = children[0];
  assert.equal(select.props.options[0].label, 'Automatic (AV1)');
  assert.equal(select.props.options[1].label, 'AV1 (hardware available)');
  assert.equal(select.props.options[1].isDisabled, false);
  assert.equal(select.props.value, 'vp9');
});

test('pinned renderer changes only the component and map hash, and a second run is unchanged', {skip: !baselineAvailable}, t => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const temporary = fs.mkdtempSync(path.join(temporaryRoot, 'dxd-renderer-gpu-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(temporary)), temporaryRoot);
    assert.ok(path.basename(temporary).startsWith('dxd-renderer-gpu-'));
    fs.rmSync(temporary, {recursive: true, force: true});
  });
  fs.mkdirSync(path.join(temporary, 'assets'));
  for (const file of ['version.json', 'module-map.json', ASSET]) fs.copyFileSync(path.join(renderer, file), path.join(temporary, file));
  const originalAsset = fs.readFileSync(path.join(temporary, ASSET), 'utf8');
  const originalMap = fs.readFileSync(path.join(temporary, 'module-map.json'), 'utf8');
  assert.equal(crypto.createHash('sha256').update(originalAsset).digest('hex'), BASELINE_SHA256);
  const result = patchRendererGpu(temporary);
  assert.equal(result.changed, true);
  const patchedAsset = fs.readFileSync(path.join(temporary, ASSET), 'utf8');
  const patchedMap = fs.readFileSync(path.join(temporary, 'module-map.json'), 'utf8');
  const start = originalAsset.indexOf('let aU=(0,C.PA)(()=>{');
  const end = originalAsset.indexOf('}),aM=(0,C.PA)', start) + 2;
  assert.equal(patchedAsset, originalAsset.slice(0, start) + GPU_CODEC_COMPONENT + originalAsset.slice(end));
  assert.equal(patchedMap, originalMap.replace(BASELINE_SHA256, result.sha256));
  new vm.Script(patchedAsset);
  assert.deepEqual(patchRendererGpu(temporary), {...result, changed: false});
  assert.equal(fs.readFileSync(path.join(temporary, ASSET), 'utf8'), patchedAsset);
  assert.equal(fs.readFileSync(path.join(temporary, 'module-map.json'), 'utf8'), patchedMap);

  for (const failure of ['asset', 'coherent-stale', 'map', 'version', 'channel']) {
    fs.writeFileSync(path.join(temporary, ASSET), originalAsset);
    fs.writeFileSync(path.join(temporary, 'module-map.json'), originalMap);
    fs.copyFileSync(path.join(renderer, 'version.json'), path.join(temporary, 'version.json'));
    if (failure === 'asset') fs.appendFileSync(path.join(temporary, ASSET), '\n// stale');
    if (failure === 'coherent-stale') {
      const staleAsset = originalAsset + '\n// stale';
      const staleHash = crypto.createHash('sha256').update(staleAsset).digest('hex');
      fs.writeFileSync(path.join(temporary, ASSET), staleAsset);
      fs.writeFileSync(path.join(temporary, 'module-map.json'), originalMap.replace(BASELINE_SHA256, staleHash));
    }
    if (failure === 'map') {
      const map = JSON.parse(originalMap); map.assets[ASSET] = '0'.repeat(64);
      fs.writeFileSync(path.join(temporary, 'module-map.json'), JSON.stringify(map));
    }
    if (failure === 'version') fs.writeFileSync(path.join(temporary, 'version.json'), '{"version":"new"}');
    if (failure === 'channel') {
      const map = JSON.parse(originalMap); map.build.channel = 'stable';
      fs.writeFileSync(path.join(temporary, 'module-map.json'), JSON.stringify(map));
    }
    const beforeAsset = fs.readFileSync(path.join(temporary, ASSET));
    const beforeMap = fs.readFileSync(path.join(temporary, 'module-map.json'));
    assert.throws(() => patchRendererGpu(temporary));
    assert.deepEqual(fs.readFileSync(path.join(temporary, ASSET)), beforeAsset);
    assert.deepEqual(fs.readFileSync(path.join(temporary, 'module-map.json')), beforeMap);
  }
});
