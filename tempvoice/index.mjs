import {readFileSync} from 'node:fs';
import {Client, Events} from '@fluxerjs/core';
import {TemporaryRooms} from './rooms.mjs';

const {FLUXER_API_URL: api, TEMPVOICE_GUILD_ID: guildId, TEMPVOICE_CREATOR_ID: creatorId} = process.env;
if (!api?.startsWith('https://') || !/^(?:\d{16,22})$/u.test(guildId ?? '') || !/^(?:\d{16,22})$/u.test(creatorId ?? '')) {
  throw new Error('Configure the HTTPS API URL, guild ID and creator voice channel ID');
}
const token = readFileSync('/run/secrets/bot-token', 'utf8').trim();
if (!token) throw new Error('The bot token file is empty');

const client = new Client({instance: {api}, waitForGuilds: true, gatewayDeferHandlers: false});
let connected = false;
const report = (error) => console.error('[TempVoice]', error.statusCode ?? error.code ?? error.name);
const rooms = new TemporaryRooms({rest: client.rest, guildId, creatorId, stateFile: '/app/data/rooms.json',
  isReady: () => connected && client.isReady(), onError: report});

function readGuildSnapshot({payload}) {
  if ((payload.t === 'GUILD_CREATE' || payload.t === 'GUILD_SYNC') && (payload.d.id ?? payload.d.guild_id) === guildId) {
    if (Array.isArray(payload.d.voice_states)) rooms.replaceVoiceSnapshot(payload.d.voice_states);
  }
}

client.once(Events.ShardReady, () => client.ws.on('dispatch', readGuildSnapshot));
client.on(Events.ShardReady, () => { connected = true; rooms.invalidateVoiceSnapshot(); });
client.on(Events.ShardDisconnect, () => { connected = false; });
client.on(Events.ShardResumed, () => {
  connected = true;
  for (const id of rooms.rooms.keys()) rooms.scheduleCleanup(id);
});
client.on(Events.GuildUnavailable, (guild) => { if (guild.id === guildId) rooms.invalidateVoiceSnapshot(); });
client.on(Events.GuildDelete, (guild) => { if (guild.id === guildId) rooms.invalidateVoiceSnapshot(); });
client.on(Events.ChannelDelete, (channel) => rooms.forgetRoom(channel.id));
client.on(Events.VoiceStateUpdate, (state) => {
  const isBot = state.user_id === client.user?.id || client.users.get(state.user_id)?.bot;
  void rooms.onVoiceState(state, isBot).catch(report);
});
client.on(Events.Ready, async () => {
  try {
    const creator = await client.rest.get(`/channels/${creatorId}`);
    if (creator.guild_id !== guildId || creator.type !== 2 || !creator.parent_id) throw new Error('Invalid creator channel');
    console.info('[TempVoice] Creator channel verified, gateway ready');
  } catch (error) {
    report(error);
    process.exitCode = 1;
    client.destroy();
  }
});
client.on(Events.MessageCreate, async (message) => {
  if (message.guildId !== guildId || message.author?.bot) return;
  const match = /^!room(?:\s+(name|limit|claim)(?:\s+(.+))?)?\s*$/iu.exec(message.content ?? '');
  if (!match) return;
  try {
    const result = await rooms.command(message.author.id, match[1]?.toLowerCase(), match[2]?.trim() ?? '');
    await message.reply(result, {ping: false});
  } catch (error) {
    report(error);
  }
});
client.on(Events.Error, report);

await client.login(token);
