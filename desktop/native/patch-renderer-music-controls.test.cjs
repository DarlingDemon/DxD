// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {createMusicPlayerControls, MUSIC_PLAYER_CONTROLS_FACTORY_SOURCE} = require('./music-player-controls-runtime.cjs');
const {patchRendererMusicControls, COMPONENT, ADD_CHILD, INSERT_BEFORE, COMPONENT_BOUNDARY, ASSET, BASELINE_SHA256} = require('./patch-renderer-music-controls.cjs');

const panelId = '12345678-1234-4234-8234-123456789abc';
const channel = {id: '1562471889513742337', guildId: '1562471889513742338'};
const panelUrl = (query = '', host = 'darkdck.duckdns.org') => `https://${host}/channels/${channel.guildId}/${channel.id}?dxd_player=v1.${panelId}&paused=0&loop=off&closed=0${query}`;
const message = extra => ({id: '1562471889513742339', channelId: channel.id, author: {id: '1562471889513742336', bot: true}, embeds: [{url: panelUrl()}], ...extra});
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const element = (type, props, key) => ({type, props, key});

function mount({post = async () => ({status: 200, body: {ok: true}}), locale = 'en-US', initialProps = {message: message(), channel}} = {}) {
  const slots = [], effects = [], cleanups = [], calls = [];
  let cursor = 0, unmounted = false, lateWrites = 0, props = initialProps;
  const React = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => {if (unmounted) lateWrites++; slots[index] = value;}];
    },
    useRef(initial) {const index = cursor++; if (!(index in slots)) slots[index] = {current: initial}; return slots[index];},
    useEffect(effect, dependencies) {
      const index = cursor++;
      if (!slots[index] || dependencies.some((value, i) => value !== slots[index][i])) {
        slots[index] = dependencies;
        effects.push(() => {cleanups[index]?.(); cleanups[index] = effect();});
      }
    },
  };
  // The exact serialized factory is shipped in both renderers.
  const factory = vm.runInNewContext(MUSIC_PLAYER_CONTROLS_FACTORY_SOURCE, {URL, crypto: crypto.webcrypto});
  const component = factory({React, jsx: element, jsxs: element, Button: 'button', http: {post: (...args) => {calls.push(args); return post(...args);}}, getLocale: () => locale});
  return {
    calls,
    render(nextProps = props) {props = nextProps; cursor = 0; const tree = component(props); while (effects.length) effects.shift()(); return tree;},
    unmount() {unmounted = true; for (const cleanup of cleanups) cleanup?.();},
    lateWrites: () => lateWrites,
  };
}
const parsePanel = createMusicPlayerControls({}).parsePanel;
const buttons = tree => tree.props.children.slice(0, 3).flatMap(row => row.props.children);
const button = (tree, action) => buttons(tree).find(item => item.props['data-flx'] === `channel.music-player-controls.${action}`);
const role = (tree, value) => tree.props.children.find(item => item?.props.role === value);
const click = item => item.props.onClick({preventDefault() {}, stopPropagation() {}});

test('parses the scoped panel and its state on each configured host', () => {
  for (const host of ['darkdck.duckdns.org', 'darkdc.pp.ua']) {
    assert.deepEqual(parsePanel(message({embeds: [{url: panelUrl('', host).replace('paused=0', 'paused=1').replace('loop=off', 'loop=queue')}]}), channel, false), {id: panelId, paused: true, loop: 'queue', closed: false});
  }
});

test('rejects spoofed authors, forwards, previews, suppressed panels, scope mismatches and ambiguous markers', () => {
  const invalidMessages = [
    {author: {id: '1'}}, {webhookId: '1'}, {webhook_id: '1'}, {messageSnapshots: [{}]}, {message_snapshots: [{}]},
    {suppressEmbeds: true}, {blocked: true}, {channelId: '1'}, {guildId: '1'}, {id: '../path'}, {embeds: []},
    {embeds: [{url: panelUrl()}, {url: panelUrl()}]},
    {embeds: [{url: panelUrl()}, {url: panelUrl('', 'attacker.example')}]},
  ];
  for (const changes of invalidMessages) assert.equal(parsePanel(message(changes), channel, false), null, JSON.stringify(changes));
  assert.equal(parsePanel(message(), channel, true), null);
  assert.equal(parsePanel(message(), {...channel, guildId: '1'}, false), null);
  assert.equal(parsePanel(message(), {...channel, id: '1'}, false), null);
  assert.equal(parsePanel(message(), {id: channel.id}, false), null);
});

test('requires one strict UUID marker, exact HTTPS origin/path and valid nonduplicate state parameters', () => {
  const invalidUrls = [
    panelUrl('', 'attacker.example'), panelUrl().replace('https:', 'http:'), panelUrl().replace('.org/', '.org:444/'),
    panelUrl().replace('https://', 'https://user@'), panelUrl() + '#fragment',
    panelUrl().replace(`/channels/${channel.guildId}/`, '/channels/123/'), panelUrl().replace('?dxd', '/?dxd'),
    panelUrl('&dxd_player=v1.' + panelId), panelUrl('&paused=0'), panelUrl('&extra=1'),
    panelUrl().replace('v1.', 'v2.'), panelUrl().replace(panelId, panelId.toUpperCase()),
    panelUrl().replace(panelId, '12345678-1234-4234-1234-123456789abc'), panelUrl().replace('paused=0', 'paused=true'),
    panelUrl().replace('closed=0', 'closed=2'), panelUrl().replace('loop=off', 'loop=all'), panelUrl().replace('&loop=off', ''),
  ];
  for (const url of invalidUrls) assert.equal(parsePanel(message({embeds: [{url}]}), channel, false), null, url);
});

test('renders three rows with eleven real buttons and truthful pause/repeat labels', () => {
  const control = mount({initialProps: {message: message({embeds: [{url: panelUrl().replace('paused=0', 'paused=1').replace('loop=off', 'loop=song')}]}), channel}});
  const tree = control.render();
  assert.equal(tree.props.role, 'group');
  assert.deepEqual(Array.from(tree.props.children.slice(0, 3), row => row.props.children.length), [5, 5, 1]);
  assert.equal(buttons(tree).length, 11);
  assert.equal(button(tree, 'toggle').props.variant, 'primary');
  assert.equal(button(tree, 'toggle').props.title, 'Resume');
  assert.equal(button(tree, 'stop').props.variant, 'danger');
  assert.equal(button(tree, 'loop').props.title, 'Repeat: Track');
  assert.equal(button(tree, 'back').props.title, '−20 sec');
  assert.equal(button(tree, 'forward').props.title, '+20 sec');
  assert.equal(buttons(tree).every(item => item.type === 'button' && item.props.type === 'button' && !item.props.disabled), true);
});

test('each button posts only its authenticated action with a fresh request ID and no command/reaction fallback', async () => {
  const control = mount();
  let tree = control.render();
  const actions = ['previous', 'back', 'toggle', 'forward', 'skip', 'shuffle', 'stop', 'loop', 'voldown', 'volup', 'close'];
  for (const action of actions) {await click(button(tree, action)); tree = control.render();}
  assert.equal(control.calls.length, actions.length);
  const ids = new Set();
  control.calls.forEach(([endpoint, options], index) => {
    assert.equal(endpoint, `/musicbot/panels/${panelId}/actions`);
    assert.equal(options.retries, 0);
    assert.equal(options.timeoutMs, 15000);
    assert.deepEqual(Object.keys(options.body).sort(), ['action', 'channel_id', 'message_id', 'request_id']);
    assert.equal(options.body.action, actions[index]);
    assert.equal(options.body.channel_id, channel.id);
    assert.equal(options.body.message_id, message().id);
    assert.match(options.body.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    ids.add(options.body.request_id);
  });
  assert.equal(ids.size, actions.length);
  assert.equal(buttons(tree).every(item => item.props.disabled), true, 'Successful close disables the panel immediately');
});

test('pending actions disable every button and block concurrent clicks even before rendering', async () => {
  const operation = deferred();
  const control = mount({post: () => operation.promise});
  const original = control.render();
  const started = click(button(original, 'toggle'));
  await click(button(original, 'skip'));
  assert.equal(control.calls.length, 1);
  const pending = control.render();
  assert.equal(pending.props['aria-busy'], true);
  assert.equal(buttons(pending).every(item => item.props.disabled), true);
  assert.match(role(pending, 'status').props.children, /Applying/);
  operation.resolve({status: 200, body: {ok: true}});
  await started;
  assert.equal(buttons(control.render()).some(item => item.props.disabled), false);
});

test('shows API errors inline and allows a fresh retry after a permission failure', async () => {
  let reject = true;
  const control = mount({post: async () => {if (reject) throw {status: 403, body: {error: 'Join the same voice channel.'}}; return {body: {ok: true}};}});
  await click(button(control.render(), 'skip'));
  let tree = control.render();
  assert.equal(role(tree, 'alert').props.children, 'Join the same voice channel.');
  assert.equal(buttons(tree).some(item => item.props.disabled), false);
  reject = false;
  await click(button(tree, 'skip'));
  tree = control.render();
  assert.equal(role(tree, 'alert'), undefined);
  assert.notEqual(control.calls[0][1].body.request_id, control.calls[1][1].body.request_id);
});

test('HTTP 410 and closed markers disable all actions, including stale click handlers', async () => {
  const control = mount({post: async () => {throw {status: 410, body: {error: 'Panel expired.'}};}});
  const original = control.render();
  await click(button(original, 'skip'));
  await click(button(original, 'skip'));
  const tree = control.render();
  assert.equal(control.calls.length, 1);
  assert.equal(role(tree, 'alert').props.children, 'Panel expired.');
  assert.equal(buttons(tree).every(item => item.props.disabled), true);
  const closed = mount({initialProps: {message: message({embeds: [{url: panelUrl().replace('closed=0', 'closed=1')}]}), channel}});
  const closedTree = closed.render();
  await click(button(closedTree, 'toggle'));
  assert.equal(closed.calls.length, 0);
  assert.equal(buttons(closedTree).every(item => item.props.disabled), true);
});

test('unmount and panel replacement discard late responses without changing another panel', async () => {
  const operation = deferred();
  const control = mount({post: () => operation.promise});
  const original = control.render();
  const running = click(button(original, 'skip'));
  control.unmount();
  operation.reject({status: 403, body: {error: 'late failure'}});
  await running;
  assert.equal(control.lateWrites(), 0);

  const anotherOperation = deferred();
  const replacement = mount({post: () => anotherOperation.promise});
  const first = replacement.render();
  const firstRequest = click(button(first, 'skip'));
  replacement.render({message: message({id: '1562471889513742340'}), channel});
  await click(button(first, 'skip'));
  assert.equal(replacement.calls.length, 1, 'Stale handler cannot operate on the old message');
  anotherOperation.reject({status: 410, body: {error: 'old panel closed'}});
  await firstRequest;
  const current = replacement.render();
  assert.equal(role(current, 'alert'), undefined);
  assert.equal(buttons(current).some(item => item.props.disabled), false);
});

test('supports Russian and Ukrainian labels and hides invalid message panels', () => {
  assert.equal(button(mount({locale: 'ru'}).render(), 'toggle').props.title, 'Пауза');
  assert.equal(button(mount({locale: 'uk-UA'}).render(), 'shuffle').props.title, 'Перемішати');
  assert.equal(mount({initialProps: {message: message({author: {id: '1'}}), channel}}).render(), null);
});

const renderer = process.env.DXD_TEST_RENDERER_DIR || path.join(__dirname, 'payload/dist/renderer');
const baselineAvailable = fs.existsSync(path.join(renderer, ASSET));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
test('pinned renderer patch preserves existing code and unrelated hashes, is idempotent, and fails closed on drift', {skip: !baselineAvailable}, t => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const temporary = fs.mkdtempSync(path.join(temporaryRoot, 'dxd-music-controls-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(temporary)), temporaryRoot);
    assert.ok(path.basename(temporary).startsWith('dxd-music-controls-'));
    fs.rmSync(temporary, {recursive: true, force: true});
  });
  fs.mkdirSync(path.join(temporary, 'assets'));
  let original = fs.readFileSync(path.join(renderer, ASSET), 'utf8');
  if (original.includes(COMPONENT)) {
    original = original.replace(';' + COMPONENT + 'let ' + COMPONENT_BOUNDARY, ',' + COMPONENT_BOUNDARY).replace(ADD_CHILD, '');
  }
  assert.equal(sha256(original), BASELINE_SHA256);
  const originalMap = JSON.parse(fs.readFileSync(path.join(renderer, 'module-map.json'), 'utf8'));
  originalMap.assets[ASSET] = BASELINE_SHA256;
  originalMap.assets['preserved-other-patch.js'] = 'preserved hash';
  const mapText = JSON.stringify(originalMap) + '\n';
  const reset = () => {
    fs.writeFileSync(path.join(temporary, ASSET), original);
    fs.writeFileSync(path.join(temporary, 'module-map.json'), mapText);
    fs.copyFileSync(path.join(renderer, 'version.json'), path.join(temporary, 'version.json'));
  };
  reset();
  const result = patchRendererMusicControls(temporary);
  assert.equal(result.changed, true);
  const patched = fs.readFileSync(path.join(temporary, ASSET), 'utf8');
  assert.equal(sha256(patched), result.sha256);
  assert.equal(patched.replace(';' + COMPONENT + 'let ' + COMPONENT_BOUNDARY, ',' + COMPONENT_BOUNDARY).replace(ADD_CHILD, ''), original);
  assert.equal(patched.split(INSERT_BEFORE).length, 2);
  new vm.Script(patched);
  assert.equal(fs.readFileSync(path.join(temporary, 'module-map.json'), 'utf8'), mapText.replace(BASELINE_SHA256, result.sha256));
  assert.deepEqual(patchRendererMusicControls(temporary), {...result, changed: false});
  for (const failure of ['asset', 'coherent-drift', 'map', 'version', 'module', 'rest-export']) {
    reset();
    const badMap = JSON.parse(mapText);
    if (failure === 'asset') fs.appendFileSync(path.join(temporary, ASSET), '//drift');
    if (failure === 'coherent-drift') {
      fs.appendFileSync(path.join(temporary, ASSET), '//drift');
      badMap.assets[ASSET] = sha256(original + '//drift');
    }
    if (failure === 'map') badMap.assets[ASSET] = '0'.repeat(64);
    if (failure === 'module') badMap.modules['fluxer_app/src/features/channel/components/MessageAttachments.tsx'].id = 1;
    if (failure === 'rest-export') badMap.modules['fluxer_app/src/features/platform/transport/RestTransport.ts'].exportMap.http = 'wrong';
    if (failure === 'version') fs.writeFileSync(path.join(temporary, 'version.json'), '{"version":"unexpected"}');
    fs.writeFileSync(path.join(temporary, 'module-map.json'), JSON.stringify(badMap));
    const before = [ASSET, 'module-map.json'].map(file => fs.readFileSync(path.join(temporary, file)));
    assert.throws(() => patchRendererMusicControls(temporary));
    [ASSET, 'module-map.json'].forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(temporary, file)), before[i]));
  }
});
