// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VERSION = '2026.1106.11354';
const ASSET = 'assets/fc94ccfaecdbbae4.js';
const BASELINE_SHA256 = '4439d443189086268d612527e9e08cf235c7c5d0fa0f01fb234c131ef62704d8';
const SECTION = 'fluxer_app/src/features/theme_settings/components/YourThemesSection.tsx';
const MODULE_START = '997520:function(e,t,s){s.d(t,{$:function(){return eM}});';
const COMPONENT_BOUNDARY = ',eM=(0,T.PA)(()=>{var e,t;let{i18n:s,_:a}=(0,C.uB)()';
const ORIGINAL_CHILDREN = '"data-flx":"theme-settings.your-themes-section.your-themes",children:[';
const ADDED_CHILD = '(0,n.jsx)(dxdBetterDiscordImport,{target:h.A.target}),';
const SHA256 = value => crypto.createHash('sha256').update(value).digest('hex');

function createThemeLibraryAdapters({themeLibrary, runtimeConfig}) {
  function getOrigin() {
    const endpoint = runtimeConfig.getSnapshotOrNull()?.webAppEndpoint;
    if (!endpoint) return 'https://darkdck.duckdns.org';
    try {
      const url = new URL(endpoint);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.origin;
    } catch {}
    return '';
  }

  async function saveTheme({css, fileName, target, apply}) {
    if (target !== 'desktop' && target !== 'account') throw new Error('Invalid theme target');
    await themeLibrary.init();
    const theme = themeLibrary.createThemeFromCss(css, fileName, 'import');
    await themeLibrary.saveTheme(theme);
    if (!apply) return {applied: false};
    try {
      await themeLibrary.setThemeEnabled(theme.id, true, target);
      return {applied: true};
    } catch {
      // The import has already been saved. Let the user enable it from the
      // library instead of presenting a failed save that could be repeated.
      return {applied: false};
    }
  }

  return {getOrigin, saveTheme};
}

function buildInsertion(sourceRoot) {
  const {buildBetterDiscordConverter} = require('./betterdiscord-converter.cjs');
  const {BETTERDISCORD_IMPORT_FACTORY_SOURCE} = require('./betterdiscord-import-ui.cjs');
  const {createBetterDiscordWallpaperResolver} = require('./betterdiscord-wallpaper.cjs');

  assert.equal(typeof BETTERDISCORD_IMPORT_FACTORY_SOURCE, 'string');
  const converterSource = buildBetterDiscordConverter(sourceRoot);
  assert.equal(typeof converterSource, 'string');

  // The aliases and module IDs in this block belong to the exact checked
  // renderer asset. Keep the importer isolated in its own React component.
  return `;
const dxdBetterDiscordConverter = ${converterSource};
const dxdBetterDiscordAdapters = (${createThemeLibraryAdapters.toString()})({
  themeLibrary: c.Ay,
  runtimeConfig: s(735485).default,
});
const dxdBetterDiscordResolveWallpaper = (${createBetterDiscordWallpaperResolver.toString()})({
  converter: dxdBetterDiscordConverter,
  http: s(647853).LV,
  getOrigin: dxdBetterDiscordAdapters.getOrigin,
  fetchImage: (...args) => globalThis.fetch(...args),
});
const dxdBetterDiscordImport = (${BETTERDISCORD_IMPORT_FACTORY_SOURCE})({
  React: _,
  jsx: n.jsx,
  jsxs: n.jsxs,
  Button: w.$,
  converter: dxdBetterDiscordConverter,
  getLocale: () => (0,C.uB)().i18n.locale,
  saveTheme: dxdBetterDiscordAdapters.saveTheme,
  getOrigin: dxdBetterDiscordAdapters.getOrigin,
  resolveWallpaper: dxdBetterDiscordResolveWallpaper,
});
let `;
}

function transform(source, insertion) {
  assert.equal(source.split(MODULE_START).length, 2, 'Unexpected theme settings module');
  assert.equal(source.split(COMPONENT_BOUNDARY).length, 2, 'Unexpected Your Themes component');
  assert.equal(source.split(ORIGINAL_CHILDREN).length, 2, 'Unexpected Your Themes section');
  return source.replace(COMPONENT_BOUNDARY, () => insertion + COMPONENT_BOUNDARY.slice(1))
    .replace(ORIGINAL_CHILDREN, () => ORIGINAL_CHILDREN + ADDED_CHILD);
}

function patchRendererBetterDiscord(rendererDirectory, sourceRoot) {
  const version = JSON.parse(fs.readFileSync(path.join(rendererDirectory, 'version.json'), 'utf8'));
  assert.equal(version.version, VERSION, 'Unsupported renderer version');
  const mapPath = path.join(rendererDirectory, 'module-map.json');
  const mapText = fs.readFileSync(mapPath, 'utf8');
  const map = JSON.parse(mapText);
  assert.equal(map.build?.version, VERSION, 'Unsupported module-map version');
  assert.equal(map.build?.channel, 'canary', 'Unsupported renderer channel');
  assert.equal(map.build?.desktopRenderer, true, 'Expected desktop renderer');
  assert.equal(map.modules?.[SECTION]?.id, 997520, 'Unexpected theme settings module ID');
  assert.equal(map.modules?.[SECTION]?.exportMap?.YourThemesSection, '$', 'Unexpected theme settings export');
  const config = map.modules?.['fluxer_app/src/features/app/state/RuntimeConfig.ts'];
  assert.equal(config?.id, 735485, 'Unexpected runtime config module ID');
  assert.equal(config?.exportMap?.default, 'default', 'Unexpected runtime config export');
  const transport = map.modules?.['fluxer_app/src/features/platform/transport/RestTransport.ts'];
  assert.equal(transport?.id, 647853, 'Unexpected REST transport module ID');
  assert.equal(transport?.exportMap?.http, 'LV', 'Unexpected REST transport export');

  const assetPath = path.join(rendererDirectory, ASSET);
  const source = fs.readFileSync(assetPath, 'utf8');
  const inputHash = SHA256(source);
  assert.equal(map.assets?.[ASSET], inputHash, 'Theme settings asset integrity mismatch');
  const insertion = buildInsertion(sourceRoot);

  if (source.includes(ADDED_CHILD)) {
    assert.equal(source.split(ADDED_CHILD).length, 2, 'Unexpected number of importer components');
    const restored = source
      .replace(insertion + COMPONENT_BOUNDARY.slice(1), COMPONENT_BOUNDARY)
      .replace(ADDED_CHILD, '');
    assert.equal(SHA256(restored), BASELINE_SHA256, 'Unsupported patched theme settings asset');
    return {changed: false, asset: ASSET, sha256: inputHash};
  }

  assert.equal(inputHash, BASELINE_SHA256, 'Unsupported theme settings asset SHA256');
  const patched = transform(source, insertion);
  new vm.Script(patched);
  const outputHash = SHA256(patched);
  const originalEntry = JSON.stringify(ASSET) + ':' + JSON.stringify(inputHash);
  assert.equal(mapText.split(originalEntry).length, 2, 'Expected one module-map theme settings asset hash');
  const updatedMap = mapText.replace(originalEntry, JSON.stringify(ASSET) + ':' + JSON.stringify(outputHash));
  fs.writeFileSync(assetPath, patched);
  fs.writeFileSync(mapPath, updatedMap);
  return {changed: true, asset: ASSET, sha256: outputHash};
}

module.exports = {patchRendererBetterDiscord, createThemeLibraryAdapters, buildInsertion, transform, ASSET, BASELINE_SHA256};

if (require.main === module) {
  assert.ok(process.argv[2] && process.argv[3], 'Pass the renderer directory and Fluxer source checkout');
  console.log(JSON.stringify(patchRendererBetterDiscord(path.resolve(process.argv[2]), path.resolve(process.argv[3]))));
}
