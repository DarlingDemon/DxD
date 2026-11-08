// SPDX-License-Identifier: AGPL-3.0-or-later
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {GPU_CODEC_COMPONENT, patchRendererGpu} = require('./patch-renderer-gpu.cjs');
const {
  patchRendererNativeEncoderUi, NATIVE_ENCODER_COMPONENT, NATIVE_GPU_CODEC_COMPONENT,
  REPLACEMENT, ASSET, BASELINE_SHA256, PATCHED_SHA256,
} = require('./patch-renderer-native-encoder-ui.cjs');

const renderer = process.env.DXD_TEST_RENDERER_DIR || path.join(__dirname, 'payload/dist/renderer');
const baselineAvailable = fs.existsSync(path.join(renderer, ASSET));
const settings = (backend = 'auto', extra = {}) => ({backend, backends: {nvenc: true, amf: true}, installed: false, ...extra});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
const settle = async () => {await new Promise(resolve => setImmediate(resolve));};

// Execute the exact shipped component with stateful hooks, including effect cleanup.
function mount({api, locale = 'en-US'} = {}) {
  const slots = [], effects = [], cleanups = [];
  let cursor = 0, unmounted = false, lateWrites = 0;
  const element = (type, props) => ({type, props});
  const context = {
    dxdNativeEncoder: api,
    S: {uB: () => ({i18n: {locale}})},
    N: {
      useState(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
        return [slots[index], value => {if (unmounted) lateWrites++; slots[index] = value;}];
      },
      useRef(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = {current: initial};
        return slots[index];
      },
      useEffect(effect, dependencies) {
        const index = cursor++;
        if (!slots[index] || dependencies.some((value, i) => value !== slots[index][i])) {
          slots[index] = dependencies;
          effects.push(() => {cleanups[index]?.(); cleanups[index] = effect();});
        }
      },
    },
    s: {jsx: element, jsxs: element}, eC: {G: 'combobox'}, l: {lv: 'compact', jg: 'description'},
  };
  const component = new vm.Script(NATIVE_ENCODER_COMPONENT + ';dxdNativeEncoderControl;').runInNewContext(context);
  const render = () => {
    cursor = 0;
    const tree = component();
    while (effects.length) effects.shift()();
    return tree;
  };
  return {
    render,
    unmount: () => {unmounted = true; for (const cleanup of cleanups) cleanup?.();},
    lateWrites: () => lateWrites,
  };
}

const children = tree => tree.props.children.filter(Boolean);
const select = tree => children(tree).find(child => child.type === 'combobox');
const role = (tree, name) => children(tree).find(child => child.props.role === name);

test('browser without the preload API hides the native control', () => {
  assert.equal(mount().render(), null);
  assert.equal(mount({api: {getSettings: () => Promise.resolve(settings())}}).render(), null);
});

test('loads the saved device backend and disables physically unavailable options', async () => {
  const pending = deferred();
  const calls = [];
  const control = mount({api: {
    getSettings: () => pending.promise,
    setBackend: backend => {calls.push(backend); return Promise.resolve(settings(backend));},
  }});
  let tree = control.render();
  assert.equal(select(tree).props.disabled, true);
  assert.match(role(tree, 'status').props.children, /Loading/);
  pending.resolve(settings('nvenc', {installed: true, backends: {nvenc: true, amf: false}}));
  await settle();
  tree = control.render();
  const props = select(tree).props;
  assert.equal(props.value, 'nvenc');
  assert.equal(props.disabled, false);
  assert.equal(props['aria-label'], 'Screen share encoder');
  assert.equal(props.label, 'Screen share encoder');
  assert.equal(props.options.find(option => option.value === 'amf').isDisabled, true);
  assert.equal(props.options.find(option => option.value === 'nvenc').isDisabled, false);
  await props.onChange('amf');
  await props.onChange('h264');
  assert.deepEqual(calls, [], 'Unavailable backends and codec names cannot reach the backend selector');
  assert.match(children(tree)[1].props.children, /next screen share/);
  assert.match(children(tree)[1].props.children, /native encoders always use H\.264/);
});

for (const backend of ['nvenc', 'amf']) {
  test(`real ${backend} selection waits for the backend, blocks duplicate requests and then uses returned settings`, async () => {
    const pending = deferred(), calls = [];
    const control = mount({api: {
      getSettings: async () => settings(),
      setBackend: value => {calls.push(value); return value === 'auto' ? Promise.resolve(settings('auto', {installed: true})) : pending.promise;},
    }});
    control.render(); await settle();
    const oldProps = select(control.render()).props;
    const operation = oldProps.onChange(backend);
    await oldProps.onChange(backend === 'nvenc' ? 'amf' : 'nvenc');
    let tree = control.render();
    assert.deepEqual(calls, [backend]);
    assert.equal(select(tree).props.value, 'auto', 'Selection changes only when main confirms success');
    assert.equal(select(tree).props.disabled, true);
    assert.equal(select(tree).props.isLoading, true);
    assert.equal(tree.props['aria-busy'], true);
    assert.match(role(tree, 'status').props.children, /Downloading components and checking/);
    pending.resolve(settings(backend, {installed: true}));
    await operation;
    tree = control.render();
    assert.equal(select(tree).props.value, backend);
    assert.equal(select(tree).props.disabled, false);
    assert.equal(role(tree, 'status'), undefined);
    const automatic = select(tree).props.onChange('auto');
    assert.deepEqual(calls, [backend, 'auto']);
    assert.match(role(control.render(), 'status').props.children, /Saving/);
    await automatic;
    assert.equal(select(control.render()).props.value, 'auto');
  });
}

test('failed installation shows an alert, retains saved selection and allows a retry', async () => {
  let fail = true;
  const control = mount({api: {
    getSettings: async () => settings('nvenc', {installed: true}),
    setBackend: async backend => {
      if (fail) throw new Error('GPU driver probe failed');
      return settings(backend, {installed: true});
    },
  }});
  control.render(); await settle();
  await select(control.render()).props.onChange('amf');
  let tree = control.render();
  assert.equal(select(tree).props.value, 'nvenc');
  assert.equal(select(tree).props.disabled, false);
  assert.match(role(tree, 'alert').props.children, /GPU driver probe failed/);
  fail = false;
  await select(tree).props.onChange('amf');
  tree = control.render();
  assert.equal(select(tree).props.value, 'amf');
  assert.equal(role(tree, 'alert'), undefined);
});

test('initial bridge error is visible and does not enable an uninitialized selector', async () => {
  const control = mount({api: {getSettings: async () => {throw 'settings unavailable';}, setBackend: async () => settings()}});
  control.render(); await settle();
  const tree = control.render();
  assert.equal(select(tree).props.disabled, true);
  assert.match(role(tree, 'alert').props.children, /settings unavailable/);
});

test('async settings load and backend completion do not update unmounted controls', async () => {
  const loading = deferred();
  const initial = mount({api: {getSettings: () => loading.promise, setBackend: async () => settings()}});
  initial.render(); initial.unmount(); loading.resolve(settings()); await settle();
  assert.equal(initial.lateWrites(), 0);

  const operation = deferred();
  const selecting = mount({api: {getSettings: async () => settings(), setBackend: () => operation.promise}});
  selecting.render(); await settle();
  const completion = select(selecting.render()).props.onChange('nvenc');
  selecting.unmount(); operation.reject(new Error('late failure')); await completion;
  assert.equal(selecting.lateWrites(), 0);
});

test('English, Russian and Ukrainian use localized labels and literal backend names', async () => {
  for (const [locale, label] of [['ru-RU', 'Кодировщик демонстрации'], ['uk', 'Кодувальник демонстрації'], ['fr', 'Screen share encoder']]) {
    const control = mount({locale, api: {getSettings: async () => settings(), setBackend: async () => settings()}});
    control.render(); await settle();
    const props = select(control.render()).props;
    assert.equal(props['aria-label'], label);
    assert.equal(props.options[1].label, 'NVIDIA NVENC (H.264)');
    assert.equal(props.options[2].label, 'AMD AMF (H.264)');
  }
});

test('existing GPU codec preferences and recommendation action remain byte-for-byte intact', () => {
  const addedChild = ',\n      (0,s.jsx)(dxdNativeEncoderControl,{\'data-flx\':\'user.advanced-settings-tab.native-encoder-control\'})';
  assert.equal(NATIVE_GPU_CODEC_COMPONENT.replace(addedChild, ''), GPU_CODEC_COMPONENT);
  new vm.Script(REPLACEMENT);
});

test('pinned asset patch changes only the helper/component and its map hash; second run is unchanged', {skip: !baselineAvailable}, t => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const temporary = fs.mkdtempSync(path.join(temporaryRoot, 'dxd-native-encoder-ui-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(temporary)), temporaryRoot);
    assert.ok(path.basename(temporary).startsWith('dxd-native-encoder-ui-'));
    fs.rmSync(temporary, {recursive: true, force: true});
  });
  fs.mkdirSync(path.join(temporary, 'assets'));
  for (const file of ['version.json', 'module-map.json', ASSET]) fs.copyFileSync(path.join(renderer, file), path.join(temporary, file));
  let original = fs.readFileSync(path.join(temporary, ASSET), 'utf8');
  if (crypto.createHash('sha256').update(original).digest('hex') === '5a3d42e4bc6959c4572a431f58ba3275aeb458d678e4d7b1a5d534998afe7ae3') {
    patchRendererGpu(temporary);
    original = fs.readFileSync(path.join(temporary, ASSET), 'utf8');
  }
  if (crypto.createHash('sha256').update(original).digest('hex') === PATCHED_SHA256) original = original.replace(REPLACEMENT, () => GPU_CODEC_COMPONENT);
  assert.equal(crypto.createHash('sha256').update(original).digest('hex'), BASELINE_SHA256);
  const map = JSON.parse(fs.readFileSync(path.join(temporary, 'module-map.json'), 'utf8'));
  map.assets[ASSET] = BASELINE_SHA256;
  map.assets['another-patch.js'] = 'another patch hash';
  const originalMap = JSON.stringify(map) + '\n';
  const reset = () => {
    fs.writeFileSync(path.join(temporary, ASSET), original);
    fs.writeFileSync(path.join(temporary, 'module-map.json'), originalMap);
    fs.copyFileSync(path.join(renderer, 'version.json'), path.join(temporary, 'version.json'));
  };
  reset();
  const result = patchRendererNativeEncoderUi(temporary);
  assert.equal(result.changed, true);
  assert.equal(result.sha256, PATCHED_SHA256);
  const patched = fs.readFileSync(path.join(temporary, ASSET), 'utf8');
  assert.equal(patched, original.replace(GPU_CODEC_COMPONENT, () => REPLACEMENT));
  new vm.Script(patched);
  assert.equal(fs.readFileSync(path.join(temporary, 'module-map.json'), 'utf8'), originalMap.replace(BASELINE_SHA256, PATCHED_SHA256));
  assert.deepEqual(patchRendererNativeEncoderUi(temporary), {...result, changed: false});

  for (const failure of ['asset', 'coherent-stale', 'map', 'version', 'channel', 'module']) {
    reset();
    if (failure === 'asset') fs.appendFileSync(path.join(temporary, ASSET), '//stale');
    if (failure === 'coherent-stale') {
      const stale = original + '//stale';
      fs.writeFileSync(path.join(temporary, ASSET), stale);
      const staleMap = JSON.parse(originalMap);
      staleMap.assets[ASSET] = crypto.createHash('sha256').update(stale).digest('hex');
      fs.writeFileSync(path.join(temporary, 'module-map.json'), JSON.stringify(staleMap));
    }
    if (['map', 'channel', 'module'].includes(failure)) {
      const staleMap = JSON.parse(originalMap);
      if (failure === 'map') staleMap.assets[ASSET] = '0'.repeat(64);
      if (failure === 'channel') staleMap.build.channel = 'stable';
      if (failure === 'module') staleMap.modules['fluxer_app/src/features/user/components/modals/tabs/advanced_settings_tab/AdvancedVideoControls.tsx'].concatenatedInto = 1;
      fs.writeFileSync(path.join(temporary, 'module-map.json'), JSON.stringify(staleMap));
    }
    if (failure === 'version') fs.writeFileSync(path.join(temporary, 'version.json'), '{"version":"new"}');
    const before = [ASSET, 'module-map.json'].map(file => fs.readFileSync(path.join(temporary, file)));
    assert.throws(() => patchRendererNativeEncoderUi(temporary));
    [ASSET, 'module-map.json'].forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(temporary, file)), before[i]));
  }
});
