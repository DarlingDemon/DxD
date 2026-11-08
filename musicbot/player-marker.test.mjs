// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {test} from 'node:test';

// Run from the patched Remix checkout with its production dependencies. The
// actual SDK serializes the actual producer's embed before the actual client
// parser reads it. Separate producer/consumer fixtures missed this regression.
const root = process.env.DXD_MUSICBOT_ROOT || process.cwd();
const requireFromBot = createRequire(path.join(root, 'package.json'));
const coreRoot = path.dirname(path.dirname(requireFromBot.resolve('@fluxerjs/core')));
const corePackage = JSON.parse(await readFile(path.join(coreRoot, 'package.json'), 'utf8'));
// Remix imports the ESM condition. Requiring the package root selects a
// different CJS class even though both implementations expose EmbedBuilder.
const coreEntry = corePackage.exports?.['.']?.import || corePackage.module || corePackage.main;
const {EmbedBuilder} = await import(pathToFileURL(path.resolve(coreRoot, coreEntry)));
const {Channel, Message} = await import(pathToFileURL(path.join(root, 'src/ui/Wrappers.mjs')));
const {STATES, PROGRESS} = await import(pathToFileURL(path.join(root, 'commands/player/consts.mjs')));
const runtimePath = process.env.DXD_MUSIC_RUNTIME || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../desktop/native/music-player-controls-runtime.cjs');
const {createMusicPlayerControls} = createRequire(import.meta.url)(runtimePath);
const parsePanel = createMusicPlayerControls({React: {}, jsx() {}, jsxs() {}, Button() {}, http: {}}).parsePanel;
const source = await readFile(path.join(root, 'commands/player/embed.mjs'), 'utf8');
const body = source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const Utils = {
  clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
  escapeMarkdown: value => value,
  truncate: (value, limit) => value.slice(0, limit),
  progressBar: () => 'progress',
  prettifyMS: value => String(value),
};
const buildPlayerEmbed = new Function('Utils', 'EmbedBuilder', 'getGlobalColor', 'STATES', 'PROGRESS',
  body + '\nreturn buildPlayerEmbed;')(Utils, EmbedBuilder, () => 0x00aaff, STATES, PROGRESS);
const rawChannel = {id: '567890123456789012', guildId: '123456789012345678'};
const command = new Message({
  id: '234567890123456789', channelId: rawChannel.id,
  author: {id: '456789012345678901', username: 'Owner', avatarURL: () => 'https://darkdck.duckdns.org/avatar.png'},
}, {getChannel: () => new Channel(rawChannel, {})});
const configurations = [
  {name: 'playing', paused: false, loop: 'off'},
  {name: 'paused', paused: true, loop: 'off', closed: false},
  {name: 'repeat track', paused: false, loop: 'song'},
  {name: 'repeat queue', paused: false, loop: 'queue'},
  {name: 'closed', paused: true, loop: 'off', closed: true},
];

for (const host of ['darkdck.duckdns.org', 'darkdc.pp.ua']) {
  for (const configuration of configurations) {
    test(`serialized ${configuration.name} panel is accepted by client on ${host}`, () => {
      const panelId = randomUUID();
      const current = {title: 'Track', artist: 'Artist'};
      const player = {
        _guildId: rawChannel.guildId, paused: configuration.paused, preferredVolume: 0.5,
        startedPlaying: Date.now() - 5000,
        queue: {
          getCurrent: () => current, size: () => 0, data: [],
          songLoop: configuration.loop === 'song', loop: configuration.loop === 'queue',
        },
        _getTrackDurationMs: () => 180_000,
        getQueueRemainingTime: () => '3:00',
      };
      const bot = {config: {instanceUrl: `https://${host}/api`}, t: (_msg, key) => key};
      const state = {panelId};
      if ('closed' in configuration) state.closed = configuration.closed;
      const sdkEmbed = buildPlayerEmbed(bot, command, player, 300_000, state);
      const serialized = JSON.parse(JSON.stringify(sdkEmbed.toJSON()));
      const marker = new URL(serialized.url);
      assert.equal(marker.pathname, `/channels/${rawChannel.guildId}/${rawChannel.id}`);
      assert.equal(marker.searchParams.get('closed'), configuration.closed ? '1' : '0');
      assert.equal([...marker.searchParams.keys()].length, 4);
      const clientMessage = {
        id: '345678901234567890', channelId: rawChannel.id, guildId: rawChannel.guildId,
        author: {id: '1562471889513742336'}, embeds: [serialized],
      };
      assert.deepEqual(parsePanel(clientMessage, rawChannel, false), {
        id: panelId, paused: configuration.paused, loop: configuration.loop,
        closed: Boolean(configuration.closed),
      });
    });
  }
}
