// SPDX-License-Identifier: AGPL-3.0-or-later
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('../web/node_modules/@electron/asar');

const version = '2026.1106.11354';
const upstream = process.argv[2];
assert.ok(upstream, 'Pass the resources directory of the matching official Windows build');
const archive = path.join(upstream, 'app.asar');
const upstreamPackage = JSON.parse(asar.extractFile(archive, 'package.json'));
assert.equal(upstreamPackage.version, version);
assert.equal(upstreamPackage.name, 'fluxer_desktop_canary');

const runtime = path.join(__dirname, 'upstream-runtime');
const payload = path.join(__dirname, 'payload');
const desktop = path.join(__dirname, '../../upstream/native/fluxer_desktop');
if (!fs.existsSync(path.join(runtime, 'package.json'))) asar.extractAll(archive, runtime);
assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, 'dist/renderer/version.json'))).version, version);
fs.cpSync(path.join(runtime, 'dist/renderer'), path.join(desktop, 'dist/renderer'), {recursive: true});
fs.mkdirSync(payload, {recursive: true});
fs.cpSync(path.join(runtime, 'node_modules'), path.join(payload, 'vendor'), {recursive: true});
for (const directory of ['icons', 'badges']) {
  fs.cpSync(path.join(upstream, directory), path.join(payload, directory), {recursive: true});
}
fs.copyFileSync(path.join(desktop, 'LICENSE'), path.join(payload, 'LICENSE'));
fs.writeFileSync(path.join(payload, 'package.json'), JSON.stringify({
  name: 'dxd-native',
  version,
  description: 'DxD based on Fluxer Desktop',
  author: 'DxD',
  license: 'AGPL-3.0-or-later',
  main: 'dist/main/index.js',
  type: 'module',
}, null, 2));

const buildChannel = `// SPDX-License-Identifier: AGPL-3.0-or-later
export type BuildChannel = 'stable' | 'canary' | 'development';
export const BUILD_CHANNEL = 'canary' as BuildChannel;
export const IS_CANARY = BUILD_CHANNEL === 'canary';
export const CHANNEL_DISPLAY_NAME = BUILD_CHANNEL;
`;
fs.writeFileSync(path.join(desktop, 'src/common/BuildChannel.ts'), buildChannel);
