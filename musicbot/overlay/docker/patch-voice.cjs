const fs = require('node:fs');
const p = 'node_modules/@fluxerjs/voice/dist/index.mjs';
const original = fs.readFileSync(p,'utf8');
const start = original.indexOf('function buildLiveKitUrlForRtcSdk(endpoint) {');
const end = original.indexOf('\n}',start)+2;
if (start<0 || end<2) throw new Error('Voice URL helper changed; review patch');
const fixed = `function buildLiveKitUrlForRtcSdk(endpoint) {
  const raw = endpoint.trim();
  const url = new URL(raw.includes('://') ? raw : 'wss://' + raw);
  url.protocol = ['http:', 'ws:'].includes(url.protocol) ? 'ws:' : 'wss:';
  url.search = ''; url.hash = '';
  while (url.pathname.endsWith('/') && url.pathname.length > 1) url.pathname = url.pathname.slice(0,-1);
  if (url.pathname.endsWith('/rtc')) url.pathname = url.pathname.slice(0,-4);
  const result = url.toString();
  return result.endsWith('/') ? result.slice(0,-1) : result;
}`;
fs.writeFileSync(p,original.slice(0,start)+fixed+original.slice(end));
console.log('Patched voice SDK to retain LiveKit URL path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
for (const [input,expected] of [
 ['https://chat.example.com:443/livekit','wss://chat.example.com/livekit'],
 ['https://chat.example.com/livekit/','wss://chat.example.com/livekit'],
 ['wss://chat.example.com/livekit/rtc?access_token=test','wss://chat.example.com/livekit'],
 ['wss://voice.example.com','wss://voice.example.com'],
 ['http://localhost:7880','ws://localhost:7880']
]) assert.equal(vm.runInNewContext(fixed+';buildLiveKitUrlForRtcSdk(input)',{URL,input}),expected);
require('node:child_process').execFileSync(process.execPath,['--check',p]);
console.log('Voice URL regression checks passed');
