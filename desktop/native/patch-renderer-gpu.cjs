// SPDX-License-Identifier: AGPL-3.0-or-later
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ASSET = 'assets/68382951b0e1f025.js';
const BASELINE_SHA256 = '5a3d42e4bc6959c4572a431f58ba3275aeb458d678e4d7b1a5d534998afe7ae3';
const PATCHED_SHA256 = 'f69a906f506af1a616db0da0e01bc4888a0d97fa9d17238ceb7bc109c4d41304';
const COMPONENT_START = 'let aU=(0,C.PA)(()=>{';
const COMPONENT_END = '}),aM=(0,C.PA)';
const COMPONENT_MODULE = 'fluxer_app/src/features/user/components/modals/tabs/advanced_settings_tab/AdvancedVideoControls.tsx';

// Equivalent to the source patch's ScreenShareCodecControl. The aliases belong to
// module 759066 in the exact upstream asset pinned above; no encoder backend is forced.
const GPU_CODEC_COMPONENT = String.raw`let aU=(0,C.PA)(()=>{
  const {i18n}=(0,S.uB)();
  const encoderMode=au.A.getScreenShareEncoderMode();
  const gpuReport=aE();
  const automaticCodec=(0,am.Uc)(encoderMode).codec;
  const av1OptIn=au.A.getScreenShareAv1OptIn();
  const hevcOptIn=au.A.getScreenShareHevcOptIn();
  const capabilities=(0,am.l3)();
  const translations={
    en:{hardware:'{codec} (hardware available)',software:'{codec} (software encoding)',unknown:'{codec} (hardware support unknown)',gpu:'Detected GPU: {gpu}',recommended:'Use recommended for my GPU'},
    ru:{hardware:'{codec} (доступно аппаратное кодирование)',software:'{codec} (программное кодирование)',unknown:'{codec} (поддержка GPU неизвестна)',gpu:'Обнаружена видеокарта: {gpu}',recommended:'Подобрать для моей видеокарты'},
    uk:{hardware:'{codec} (доступне апаратне кодування)',software:'{codec} (програмне кодування)',unknown:'{codec} (підтримка GPU невідома)',gpu:'Виявлена відеокарта: {gpu}',recommended:'Підібрати для моєї відеокарти'}
  };
  const messages=translations[String(i18n.locale||'en').toLowerCase().split('-')[0]]||translations.en;
  const options=[{value:'auto',label:i18n._(aT,{codec:ap[automaticCodec]})},...aD.map(codec=>{
    let label=ap[codec];
    if(codec==='av1'&&!av1OptIn)label=i18n._(aP);
    else if(codec==='h265'&&!hevcOptIn)label=i18n._(aO);
    const capability=capabilities[codec];
    return {value:codec,label:messages[capability.hardwareAccelerated].replace('{codec}',()=>label),isDisabled:!capability.supported};
  })];
  return (0,s.jsxs)('div',{
    className:l.lv,style:{maxWidth:'24rem',minWidth:0},'data-flx':'user.advanced-settings-tab.screen-share-codec-controls',
    children:[
      (0,s.jsx)(eC.G,{value:au.A.getPreferredScreenShareCodec(),options,onChange:value=>ad.y({preferredScreenShareCodec:value}),density:'compact',isSearchable:false,wrapMenuText:true,'aria-label':i18n._(aA),'data-flx':'user.advanced-settings-tab.select.preferred-screen-share-codec'}),
      gpuReport?.gpuLabel?(0,s.jsx)('p',{className:l.jg,style:{overflowWrap:'anywhere'},'data-flx':'user.advanced-settings-tab.screen-share-codec-detected-gpu',children:messages.gpu.replace('{gpu}',()=>gpuReport.gpuLabel)}):null,
      gpuReport?.gpuLabel?(0,s.jsx)(d.$,{variant:'secondary',compact:true,onClick:()=>ad.y({preferredScreenShareCodec:'auto',screenShareEncoderMode:'hardware'}),'data-flx':'user.advanced-settings-tab.screen-share-codec-use-gpu-recommendation',children:messages.recommended}):null
    ]
  });
})`;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function patchRendererGpu(rendererDir) {
  const version = JSON.parse(fs.readFileSync(path.join(rendererDir, 'version.json'), 'utf8'));
  assert.equal(version.version, '2026.1106.11354', 'Unsupported renderer version');
  const mapPath = path.join(rendererDir, 'module-map.json');
  const mapText = fs.readFileSync(mapPath, 'utf8');
  const moduleMap = JSON.parse(mapText);
  assert.equal(moduleMap.build?.version, '2026.1106.11354', 'Unsupported module-map version');
  assert.equal(moduleMap.build?.channel, 'canary', 'Unsupported renderer channel');
  assert.equal(moduleMap.build?.desktopRenderer, true, 'Expected the desktop renderer');
  assert.equal(moduleMap.modules?.[COMPONENT_MODULE]?.concatenatedInto, 759066, 'Unexpected component module');

  const assetPath = path.join(rendererDir, ASSET);
  const source = fs.readFileSync(assetPath, 'utf8');
  const inputHash = sha256(source);
  assert.equal(moduleMap.assets?.[ASSET], inputHash, 'Renderer asset does not match module-map SHA256');
  if (inputHash === PATCHED_SHA256) return {changed: false, asset: ASSET, sha256: inputHash};
  assert.equal(inputHash, BASELINE_SHA256, 'Unsupported renderer asset SHA256');

  const start = source.indexOf(COMPONENT_START);
  assert.ok(start >= 0 && source.indexOf(COMPONENT_START, start + 1) === -1, 'Expected exactly one codec component');
  const end = source.indexOf(COMPONENT_END, start);
  assert.ok(end > start && source.indexOf(COMPONENT_END, end + 1) === -1, 'Unexpected codec component boundary');
  const transformed = source.slice(0, start) + GPU_CODEC_COMPONENT + source.slice(end + 2);
  assert.equal(sha256(transformed), PATCHED_SHA256, 'Unexpected transformed renderer SHA256');

  const oldEntry = JSON.stringify(ASSET) + ':' + JSON.stringify(BASELINE_SHA256);
  assert.equal(mapText.split(oldEntry).length, 2, 'Expected one compact module-map asset entry');
  const updatedMap = mapText.replace(oldEntry, JSON.stringify(ASSET) + ':' + JSON.stringify(PATCHED_SHA256));
  fs.writeFileSync(assetPath, transformed);
  fs.writeFileSync(mapPath, updatedMap);
  return {changed: true, asset: ASSET, sha256: PATCHED_SHA256};
}

module.exports = {patchRendererGpu, GPU_CODEC_COMPONENT};

if (require.main === module) {
  assert.ok(process.argv[2], 'Pass the prepared renderer directory');
  console.log(JSON.stringify(patchRendererGpu(path.resolve(process.argv[2]))));
}
