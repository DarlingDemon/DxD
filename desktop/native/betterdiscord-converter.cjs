// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createRequire} = require('node:module');
const path = require('node:path');

const WEB_PATCH = path.join(__dirname, '../../web/theme-import/dxd-theme-import.patch');
const WEB_UTILS = 'fluxer_app/src/features/theme_studio/utils';

function readAddedModule(patch, name) {
  const file = `${WEB_UTILS}/${name}.ts`;
  const header = `diff --git a/${file} b/${file}\n`;
  const sections = patch.split(header);
  assert.equal(sections.length, 2, `Expected one web converter module: ${file}`);
  const section = sections[1].split(/^diff --git /mu, 1)[0];
  const match = /^new file mode \d+\nindex [^\n]+\n--- \/dev\/null\n\+\+\+ b\/.+\n@@ -0,0 \+1,(\d+) @@\n((?:\+[^\n]*\n)+)$/u.exec(section);
  assert.ok(match, `Expected an added file with a single hunk: ${file}`);
  const lines = match[2].slice(0, -1).split('\n');
  assert.equal(lines.length, Number(match[1]), `Unexpected source length: ${file}`);
  return lines.map((line) => line.slice(1)).join('\n') + '\n';
}

function replaceOnce(source, expected, replacement, description) {
  assert.equal(source.split(expected).length, 2, `Unexpected ${description}`);
  return source.replace(expected, () => replacement);
}

function nativeWallpaperModule(source) {
  const download = 'const response = await fetchImage(proxy.href, {';
  // The web importer validates the signed media URL before this point. Reuse
  // its bounded reader for the two exact DxD wallpaper routes as well.
  return replaceOnce(source, download, `return downloadResolvedThemeWallpaper(proxy.href, signal, fetchImage);
}

export async function downloadKnownThemeWallpaper(
  value: string | null, origin: string, signal: AbortSignal, fetchImage: typeof fetch = fetch,
): Promise<Blob | null> {
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const dxdOrigins = ['https://darkdck.duckdns.org', 'https://darkdc.pp.ua'];
  const dxdPaths = ['/theme-assets/clearvision-sapphire.jpg', '/theme-assets/akame.jpg'];
  if (url.origin !== origin || !dxdOrigins.includes(url.origin) || !dxdPaths.includes(url.pathname) ||
      url.username || url.password || url.href !== url.origin + url.pathname) return null;
  return downloadResolvedThemeWallpaper(url.href, signal, fetchImage);
}

export async function downloadResolvedThemeWallpaper(
  value: string, signal: AbortSignal, fetchImage: typeof fetch = fetch,
): Promise<Blob> {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid resolved wallpaper URL');
  signal.throwIfAborted();
  const response = await fetchImage(url.href, {`, 'web wallpaper download boundary');
}

function nativeThemeModule(source) {
  // The old textarea classes no longer exist in the desktop renderer. Its
  // current message boxes consume --background-textarea. Apply a validated
  // surface directly as well so gradients work (background-color cannot use one).
  const oldRules = '${targets(\'GuildsLayout.module__userAreaWrapper\', \'TextareaInput.module__textarea\', \'TextareaInput.module__textareaWrapper\')} { background: transparent !important; }';
  const newRules = "${targets('GuildsLayout.module__userAreaWrapper')} { background: transparent !important; }\n" +
    "${targets('TextareaInput.module__textareaOuterRow', 'TextareaInput.module__mainWrapperEditing')} { background: ${composer} !important; }";
  source = replaceOnce(source, oldRules, newRules, 'web composer rules');
  source = replaceOnce(source, "\t'--wallpaper',\n];", "\t'--wallpaper',\n\t'--dxd-wallpaper',\n];", 'web wallpaper keys');
  // Preserve embedded raster images already stored in a theme. Keep the same
  // format and byte ceiling as a newly prepared wallpaper before applying it.
  return replaceOnce(source, '\tif (rawUrl) {\n\t\ttry {\n\t\t\tconst url = new URL(rawUrl[1] ?? rawUrl[2] ?? rawUrl[3]);', `
  if (rawUrl) {
    const value = rawUrl[1] ?? rawUrl[2] ?? rawUrl[3];
    const raster = /^data:image\\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (raster && raster[1].length % 4 === 0) {
      const encoded = raster[1];
      const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
      if (encoded.length * 3 / 4 - padding <= MAX_EMBEDDED_WALLPAPER_BYTES) wallpaper = value;
    }
    try {
      const url = new URL(value);`, 'web wallpaper extraction');
}

/** Returns a standalone browser expression whose value is the converter exports. */
function buildBetterDiscordConverter(sourceRoot) {
  const esbuild = createRequire(path.resolve(sourceRoot, 'fluxer_desktop/package.json'))('esbuild');
  const patch = fs.readFileSync(WEB_PATCH, 'utf8').replace(/\r\n/gu, '\n');
  const appearance = readAddedModule(patch, 'ThemeAppearanceImport');
  const importer = readAddedModule(patch, 'BetterDiscordImport');
  const wallpaper = readAddedModule(patch, 'ThemeWallpaperImport');
  // The three modules depend only on one another and browser APIs. Compile as
  // one unit to keep the same implementation without shipping a second copy.
  const removeLocalImport = (source, name) => {
    const importPattern = new RegExp(`^import \\{[^}]+\\} from '\\./${name}';\\n`, 'mu');
    assert.ok(importPattern.test(source), `Missing converter dependency: ${name}`);
    return source.replace(importPattern, '');
  };
  const source = [
    appearance,
    nativeThemeModule(removeLocalImport(importer, 'ThemeAppearanceImport')),
    nativeWallpaperModule(removeLocalImport(wallpaper, 'BetterDiscordImport')),
  ].join('\n');
  assert.doesNotMatch(source, /^import\s/mu, 'Unexpected external converter dependency');
  const {code} = esbuild.transformSync(source, {loader: 'ts', format: 'cjs', target: 'chrome130', minify: true});
  return `(()=>{const module={exports:{}};${code}\nreturn module.exports;})()`;
}

module.exports = {buildBetterDiscordConverter};
