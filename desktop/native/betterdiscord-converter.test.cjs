// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');
const {buildBetterDiscordConverter} = require('./betterdiscord-converter.cjs');

const sourceRoot = process.env.DXD_FLUXER_SOURCE || [
  path.resolve(__dirname, '../../upstream/native'),
  path.resolve(__dirname, '../../../dxd-native-source'),
].find((directory) => fs.existsSync(path.join(directory, 'fluxer_desktop/node_modules/esbuild/package.json')));

function loadConverter() {
  return vm.runInNewContext(buildBetterDiscordConverter(sourceRoot), {URL, Blob, TextEncoder, Uint8Array});
}

test('native wallpaper aliases only fetch the two DxD image routes without credentials', {skip: !sourceRoot}, async () => {
  const converter = loadConverter();
  const origin = 'https://darkdck.duckdns.org';
  const signal = new AbortController().signal;
  const calls = [];
  const fetchImage = async (url, options) => {
    calls.push(url);
    assert.equal(options.signal, signal);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.referrerPolicy, 'no-referrer');
    return new Response('image', {headers: {'Content-Type': 'image/jpeg'}});
  };
  for (const input of [
    null,
    'data:image/jpeg;base64,AAAA',
    'https://example.com/theme-assets/akame.jpg',
    `${origin}/theme-assets/akame.jpg?extra=1`,
    `${origin}/theme-assets/akame.jpg#extra`,
    `${origin}/theme-assets/other.jpg`,
    'https://user@darkdck.duckdns.org/theme-assets/akame.jpg',
  ]) {
    assert.equal(await converter.downloadKnownThemeWallpaper(input, origin, signal, fetchImage), null);
  }
  const akame = converter.resolveImportWallpaper('https://i.imgur.com/1JVM8CU.jpg', origin);
  const clearVision = converter.resolveImportWallpaper('https://clearvision.github.io/images/sapphire.jpg', origin);
  assert.equal((await converter.downloadKnownThemeWallpaper(akame, origin, signal, fetchImage)).type, 'image/jpeg');
  assert.equal((await converter.downloadKnownThemeWallpaper(clearVision, origin, signal, fetchImage)).size, 5);
  assert.deepEqual(calls, [`${origin}/theme-assets/akame.jpg`, `${origin}/theme-assets/clearvision-sapphire.jpg`]);
});

test('native aliases share the signed proxy downloader raster and byte limits', {skip: !sourceRoot}, async () => {
  const converter = loadConverter();
  const origin = 'https://darkdck.duckdns.org';
  const signal = new AbortController().signal;
  const alias = `${origin}/theme-assets/akame.jpg`;
  await assert.rejects(converter.downloadKnownThemeWallpaper(alias, origin, signal,
    async () => new Response('<svg/>', {headers: {'Content-Type': 'image/svg+xml'}})), /unavailable/);
  await assert.rejects(converter.downloadKnownThemeWallpaper(alias, origin, signal,
    async () => new Response('oversized', {headers: {
      'Content-Type': 'image/jpeg', 'Content-Length': String(converter.MAX_WALLPAPER_BYTES + 1),
    }})), /too large/);
  await assert.rejects(converter.downloadThemeWallpaper('https://example.com/image.jpg', origin,
    async () => 'https://example.com/media/external/invalid', signal,
    async () => assert.fail('An external proxy URL must be rejected before fetching')), /Invalid media proxy URL/);
});
