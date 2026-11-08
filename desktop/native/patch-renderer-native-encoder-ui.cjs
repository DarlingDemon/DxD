// SPDX-License-Identifier: AGPL-3.0-or-later
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {GPU_CODEC_COMPONENT} = require('./patch-renderer-gpu.cjs');

const ASSET = 'assets/68382951b0e1f025.js';
const BASELINE_SHA256 = 'f69a906f506af1a616db0da0e01bc4888a0d97fa9d17238ceb7bc109c4d41304';
const PATCHED_SHA256 = 'c54ec851e639724179874e132e396ce1ac9151803b8452525ca98468cb0a4536';
const COMPONENT_MODULE = 'fluxer_app/src/features/user/components/modals/tabs/advanced_settings_tab/AdvancedVideoControls.tsx';

// React, Lingui, Combobox and styles are the verified aliases in module 759066.
// This calls the isolated preload bridge; codec preferences never select a GPU backend.
const NATIVE_ENCODER_COMPONENT = String.raw`const dxdNativeEncoderControl=()=>{
  const {i18n}=(0,S.uB)();
  const [bridge]=(0,N.useState)(()=>{
    const api=globalThis.dxdNativeEncoder;
    return api&&typeof api.getSettings==='function'&&typeof api.setBackend==='function'?api:null;
  });
  const [settings,setSettings]=(0,N.useState)(null);
  const [busy,setBusy]=(0,N.useState)(!!bridge);
  const [pending,setPending]=(0,N.useState)(null);
  const [error,setError]=(0,N.useState)('');
  const active=(0,N.useRef)(false);
  const request=(0,N.useRef)(!!bridge);
  (0,N.useEffect)(()=>{
    if(!bridge)return;
    let cancelled=false;
    active.current=true;
    void (async()=>{
      try{const result=await bridge.getSettings();if(!cancelled)setSettings(result);}
      catch(error){if(!cancelled)setError(error instanceof Error?error.message:String(error));}
      finally{if(!cancelled){request.current=false;setBusy(false);}}
    })();
    return()=>{cancelled=true;active.current=false;};
  },[bridge]);
  if(!bridge)return null;
  const translations={
    en:{label:'Screen share encoder',auto:'Auto (WebRTC)',description:'The first GPU encoder selection downloads required components and checks your GPU. Applies to the next screen share. Codec preferences apply to Auto (WebRTC); native encoders always use H.264.',loading:'Loading encoder settings…',saving:'Saving encoder selection…',preparing:'Downloading components and checking the GPU… This may take up to 3 minutes.',failure:'Could not select the screen share encoder'},
    ru:{label:'Кодировщик демонстрации',auto:'Авто (WebRTC)',description:'При первом выборе GPU-кодировщика загружаются необходимые компоненты и проверяется видеокарта. Применяется к следующей демонстрации. Настройки кодека действуют в режиме «Авто (WebRTC)»; нативные кодировщики всегда используют H.264.',loading:'Загрузка настроек кодировщика…',saving:'Сохранение кодировщика…',preparing:'Загрузка компонентов и проверка видеокарты… Это может занять до 3 минут.',failure:'Не удалось выбрать кодировщик демонстрации'},
    uk:{label:'Кодувальник демонстрації',auto:'Авто (WebRTC)',description:'Під час першого вибору GPU-кодувальника завантажуються необхідні компоненти та перевіряється відеокарта. Застосовується до наступної демонстрації. Налаштування кодека діють у режимі «Авто (WebRTC)»; нативні кодувальники завжди використовують H.264.',loading:'Завантаження налаштувань кодувальника…',saving:'Збереження кодувальника…',preparing:'Завантаження компонентів і перевірка відеокарти… Це може тривати до 3 хвилин.',failure:'Не вдалося вибрати кодувальник демонстрації'}
  };
  const messages=translations[String(i18n.locale||'en').toLowerCase().split('-')[0]]||translations.en;
  const options=[{value:'auto',label:messages.auto},{value:'nvenc',label:'NVIDIA NVENC (H.264)',isDisabled:!settings?.backends.nvenc},{value:'amf',label:'AMD AMF (H.264)',isDisabled:!settings?.backends.amf}];
  const onChange=async backend=>{
    if(!active.current||!settings||request.current||!['auto','nvenc','amf'].includes(backend)||backend===settings.backend||backend!=='auto'&&!settings.backends[backend])return;
    request.current=true;setBusy(true);setPending(backend);setError('');
    try{const result=await bridge.setBackend(backend);if(active.current)setSettings(result);}
    catch(error){if(active.current)setError(error instanceof Error?error.message:String(error));}
    finally{if(active.current){request.current=false;setBusy(false);setPending(null);}}
  };
  return (0,s.jsxs)('div',{className:l.lv,'aria-busy':busy,'data-flx':'user.advanced-settings-tab.native-encoder-controls',children:[
    (0,s.jsx)(eC.G,{label:messages.label,'aria-label':messages.label,value:settings?.backend||'auto',options,onChange,disabled:busy||!settings,isLoading:busy,density:'compact',isSearchable:false,wrapMenuText:true,'data-flx':'user.advanced-settings-tab.select.native-encoder'}),
    (0,s.jsx)('p',{className:l.jg,'data-flx':'user.advanced-settings-tab.native-encoder-description',children:messages.description}),
    busy?(0,s.jsx)('p',{className:l.jg,role:'status','aria-live':'polite','data-flx':'user.advanced-settings-tab.native-encoder-status',children:!settings?messages.loading:pending!=='auto'&&!settings.installed?messages.preparing:messages.saving}):null,
    error?(0,s.jsx)('p',{className:l.jg,role:'alert','data-flx':'user.advanced-settings-tab.native-encoder-error',children:messages.failure+': '+error}):null
  ]});
};`;

const CHILDREN_END = '\n    ]\n  });\n})';
assert.equal(GPU_CODEC_COMPONENT.split(CHILDREN_END).length, 2, 'Unexpected GPU controls structure');
const NATIVE_GPU_CODEC_COMPONENT = GPU_CODEC_COMPONENT.replace(CHILDREN_END,
  ',\n      (0,s.jsx)(dxdNativeEncoderControl,{\'data-flx\':\'user.advanced-settings-tab.native-encoder-control\'})' + CHILDREN_END);
const REPLACEMENT = NATIVE_ENCODER_COMPONENT + '\n' + NATIVE_GPU_CODEC_COMPONENT;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function patchRendererNativeEncoderUi(rendererDir) {
  const version = JSON.parse(fs.readFileSync(path.join(rendererDir, 'version.json'), 'utf8'));
  assert.equal(version.version, '2026.1106.11354', 'Unsupported renderer version');
  const mapPath = path.join(rendererDir, 'module-map.json');
  const mapText = fs.readFileSync(mapPath, 'utf8');
  const map = JSON.parse(mapText);
  assert.equal(map.build?.version, version.version, 'Unsupported module-map version');
  assert.equal(map.build?.channel, 'canary', 'Unsupported renderer channel');
  assert.equal(map.build?.desktopRenderer, true, 'Expected desktop renderer');
  assert.equal(map.modules?.[COMPONENT_MODULE]?.concatenatedInto, 759066, 'Unexpected settings module');
  const assetPath = path.join(rendererDir, ASSET);
  const source = fs.readFileSync(assetPath, 'utf8');
  const inputHash = sha256(source);
  assert.equal(map.assets?.[ASSET], inputHash, 'Settings asset integrity mismatch');
  if (inputHash === PATCHED_SHA256) return {changed: false, asset: ASSET, sha256: inputHash};
  assert.equal(inputHash, BASELINE_SHA256, 'Unsupported settings asset SHA256');
  assert.equal(source.split(GPU_CODEC_COMPONENT).length, 2, 'Expected exactly one GPU controls component');
  const transformed = source.replace(GPU_CODEC_COMPONENT, () => REPLACEMENT);
  assert.equal(sha256(transformed), PATCHED_SHA256, 'Unexpected transformed settings SHA256');
  new vm.Script(transformed);
  map.assets[ASSET] = PATCHED_SHA256;
  const updatedMap = JSON.stringify(map) + (mapText.endsWith('\n') ? '\n' : '');
  fs.writeFileSync(assetPath, transformed);
  fs.writeFileSync(mapPath, updatedMap);
  return {changed: true, asset: ASSET, sha256: PATCHED_SHA256};
}

module.exports = {patchRendererNativeEncoderUi, NATIVE_ENCODER_COMPONENT, NATIVE_GPU_CODEC_COMPONENT, REPLACEMENT, ASSET, BASELINE_SHA256, PATCHED_SHA256};
if (require.main === module) {
  assert.ok(process.argv[2], 'Pass the prepared renderer directory');
  console.log(JSON.stringify(patchRendererNativeEncoderUi(path.resolve(process.argv[2]))));
}
