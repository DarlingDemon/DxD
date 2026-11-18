// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {ASSET, BASELINE_SHA256, buildInsertion, transform} = require('./patch-renderer-betterdiscord.cjs');

const renderer = process.env.DXD_TEST_RENDERER_DIR || path.resolve(__dirname, '../../../dxd-native-windows/upstream-runtime/dist/renderer');
const checkout = process.env.DXD_FLUXER_SOURCE || path.resolve(__dirname, '../../../dxd-native-source');
const originalAsset = path.join(renderer, ASSET);
const canTest = fs.existsSync(originalAsset) && fs.existsSync(path.join(checkout, 'fluxer_desktop/node_modules/esbuild'));

function descendants(node) {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (!node?.props) return [];
  return [node, ...descendants(node.props.children)];
}

test('pinned Your Themes section imports a theme and applies it to the selected scope', {skip: !canTest}, async () => {
  const source = fs.readFileSync(originalAsset, 'utf8');
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), BASELINE_SHA256);
  const css = ':root { --main-color: #1177cc; }';
  class CSSStyleSheet {
    replaceSync(value) {
      assert.equal(value, css);
      this.cssRules = [{
        selectorText: ':root',
        style: {
          length: 1,
          item: () => '--main-color',
          getPropertyValue: key => key === '--main-color' ? '#1177cc' : '',
          getPropertyPriority: () => '',
        },
      }];
    }
  }
  const self = {};
  vm.runInNewContext(transform(source, buildInsertion(checkout)), {self, URL, AbortController, TextEncoder, CSSStyleSheet});
  const factories = self.rspackChunkfluxer_app[0][1];
  const h = (type, props) => ({type, props});
  const ledger = [];
  const themeLibrary = {
    themes: [],
    enabledIdsFor: () => [],
    init: async () => {ledger.push('init');},
    createThemeFromCss: (css, fileName, source) => ({id: 'saved-theme', css, fileName, source}),
    saveTheme: async theme => {ledger.push(theme);},
    setThemeEnabled: async (...args) => {ledger.push(args);},
  };
  let cursor = 0;
  const slots = [];
  const react = {
    useId: () => 'importer',
    useRef: initial => slots[cursor++] ??= {current: initial},
    useMemo: factory => factory(),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => {slots[index] = value;}];
    },
    useEffect(effect) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = effect();
    },
  };
  const settingsState = {librarySearch: ''};
  const deps = {
    384387: {jsx: h, jsxs: h, Fragment: 'fragment'},
    246254: {X: 'settings-section'},
    802468: {ju: value => value},
    969871: {A: {target: 'account'}},
    102763: {Ay: themeLibrary},
    728648: {Wn: () => false},
    389353: {$: 'button'},
    232531: {uB: () => ({i18n: {locale: 'en-US', _: () => ''}})},
    754013: {PA: component => component},
    757923: react,
    735485: {default: {getSnapshotOrNull: () => ({webAppEndpoint: 'https://darkdck.duckdns.org/'})}},
    647853: {LV: {post: () => {throw new Error('Color-only import must not make requests');}}},
    763940: {xl: () => false},
  };
  // Read the pinned alias directly so the harness fails against changes in the
  // renderer rather than silently constructing a different component.
  const settingsAlias = /\bB=s\((\d+)\)/.exec(factories[997520].toString())[1];
  deps[settingsAlias] = {A: settingsState};
  function requireModule(id) {return deps[id] ?? {};}
  requireModule.d = (exports, getters) => {
    for (const [key, get] of Object.entries(getters)) Object.defineProperty(exports, key, {get});
  };
  const section = {exports: {}};
  factories[997520](section, section.exports, requireModule);
  const body = section.exports.$();
  assert.equal(body.type, 'settings-section');
  assert.equal(body.props.id, 'your-themes');
  assert.ok(descendants(body.props.actions).some(node => node.props['data-flx'] === 'theme-settings.your-themes-section.button.import-desktop-css'));
  const importer = body.props.children[0];
  assert.equal(importer.props.target, 'account');
  slots.length = 0;
  const render = () => {cursor = 0; return descendants(importer.type(importer.props));};
  let nodes = render();
  nodes.find(node => node.type === 'textarea').props.onChange({currentTarget: {value: css}});
  nodes = render();
  nodes.find(node => node.type === 'button' && node.props.children === 'Preview theme').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  nodes = render();
  assert.ok(nodes.some(node => node.type?.name === 'Preview' && node.props.draft.settings.accent === '#1177cc'));
  nodes.find(node => node.props.type === 'checkbox').props.onChange({currentTarget: {checked: true}});
  nodes = render();
  nodes.find(node => node.type === 'button' && node.props.children === 'Save theme').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ledger[0], 'init');
  assert.equal(ledger[1].fileName, 'imported-DxD.theme.css');
  assert.equal(ledger[1].source, 'import');
  assert.match(ledger[1].css, /#1177cc/i);
  assert.deepEqual(ledger[2], ['saved-theme', true, 'account']);
});
