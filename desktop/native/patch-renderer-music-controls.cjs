// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {MUSIC_PLAYER_CONTROLS_FACTORY_SOURCE} = require('./music-player-controls-runtime.cjs');

const VERSION = '2026.1106.11354';
const ASSET = 'assets/8684e9d9831c3739.js';
const BASELINE_SHA256 = 'f8b827df5d0b339daeb8ce684e1c70facdbeaf78633ad57b4e7ac21c74c94c3b';
const MODULE = 'fluxer_app/src/features/channel/components/MessageAttachments.tsx';
const MODULE_START = '99397:function(e,t,n){let a;n.d(t,{C:function(){return lH}});';
const INSERT_BEFORE = 'nU.default.renderReactions&&c.length>0&&(0,i.jsx)(i8.G,{message:t,isPreview:o,onPopoutToggle:l,"data-flx":"channel.message-attachments.message-reactions"})';
// These bindings are pinned by module-map.json and verified baseline SHA256.
const COMPONENT = `const dxdMusicPlayerControls=${MUSIC_PLAYER_CONTROLS_FACTORY_SOURCE}({React:A,jsx:i.jsx,jsxs:i.jsxs,Button:iL.$,http:n(647853).LV,getLocale:()=>(0,P.uB)().i18n.locale});`;
const COMPONENT_BOUNDARY = 'lH=(0,K.PA)(()=>{let{channel:e,message:t,handleDelete:n,previewContext:a,onPopoutToggle:l,suppressMessageActions:r}=(0,ez.p_)()';
const ADD_CHILD = 'nU.default.renderEmbeds&&!t.suppressEmbeds&&(0,i.jsx)(dxdMusicPlayerControls,{message:t,channel:e,isPreview:o,"data-flx":"channel.music-player-controls.host"}),';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function transformedSource(source) {
  assert.equal(source.split(MODULE_START).length, 2, 'Unexpected message attachments module');
  assert.equal(source.split(COMPONENT_BOUNDARY).length, 2, 'Unexpected message attachments component');
  assert.equal(source.split(INSERT_BEFORE).length, 2, 'Unexpected message attachments child boundary');
  // A declaration inserted before the module's first var would read React
  // before initialization. Insert immediately before lH, after all imports.
  const componentStart = source.indexOf(COMPONENT_BOUNDARY);
  assert.equal(source[componentStart - 1], ',', 'Unexpected component declaration boundary');
  return source.slice(0, componentStart - 1) + ';' + COMPONENT + 'let ' + source.slice(componentStart)
    .replace(INSERT_BEFORE, () => ADD_CHILD + INSERT_BEFORE);
}

function patchRendererMusicControls(rendererDir) {
  const version = JSON.parse(fs.readFileSync(path.join(rendererDir, 'version.json'), 'utf8'));
  assert.equal(version.version, VERSION, 'Unsupported renderer version');
  const mapPath = path.join(rendererDir, 'module-map.json');
  const mapText = fs.readFileSync(mapPath, 'utf8');
  const map = JSON.parse(mapText);
  assert.equal(map.build?.version, VERSION, 'Unsupported module-map version');
  assert.equal(map.build?.channel, 'canary', 'Unsupported renderer channel');
  assert.equal(map.build?.desktopRenderer, true, 'Expected desktop renderer');
  assert.equal(map.modules?.[MODULE]?.id, 99397, 'Unexpected message attachments module ID');
  assert.equal(map.modules?.['fluxer_app/src/features/platform/transport/RestTransport.ts']?.id, 647853, 'Unexpected REST module ID');
  assert.equal(map.modules?.['fluxer_app/src/features/platform/transport/RestTransport.ts']?.exportMap?.http, 'LV', 'Unexpected REST export');
  const assetPath = path.join(rendererDir, ASSET);
  const source = fs.readFileSync(assetPath, 'utf8');
  const inputHash = sha256(source);
  assert.equal(map.assets?.[ASSET], inputHash, 'Message asset integrity mismatch');
  if (source.includes(COMPONENT)) {
    assert.equal(source.split(COMPONENT).length, 2, 'Duplicate music controls component');
    assert.equal(source.split(ADD_CHILD).length, 2, 'Unexpected music controls child');
    const restored = source.replace(';' + COMPONENT + 'let ' + COMPONENT_BOUNDARY, ',' + COMPONENT_BOUNDARY).replace(ADD_CHILD, '');
    assert.equal(sha256(restored), BASELINE_SHA256, 'Unsupported patched message asset');
    return {changed: false, asset: ASSET, sha256: inputHash};
  }
  assert.equal(inputHash, BASELINE_SHA256, 'Unsupported message asset SHA256');
  const patched = transformedSource(source);
  new vm.Script(patched);
  const outputHash = sha256(patched);
  const hashEntry = JSON.stringify(ASSET) + ':' + JSON.stringify(inputHash);
  assert.equal(mapText.split(hashEntry).length, 2, 'Expected one module-map message asset hash');
  const updatedMap = mapText.replace(hashEntry, JSON.stringify(ASSET) + ':' + JSON.stringify(outputHash));
  fs.writeFileSync(assetPath, patched);
  fs.writeFileSync(mapPath, updatedMap);
  return {changed: true, asset: ASSET, sha256: outputHash};
}

module.exports = {patchRendererMusicControls, transformedSource, COMPONENT, ADD_CHILD, INSERT_BEFORE, COMPONENT_BOUNDARY, ASSET, BASELINE_SHA256};
if (require.main === module) {
  assert.ok(process.argv[2], 'Pass the prepared renderer directory');
  console.log(JSON.stringify(patchRendererMusicControls(path.resolve(process.argv[2]))));
}
