import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';

// Run from the patched Remix checkout. Load the real command/renderer bodies
// with I/O dependencies injected, so these lifecycle tests need no audio or DB.
const root = process.cwd();
const {CONTROLS} = await import(pathToFileURL(path.resolve(root, 'commands/player/consts.mjs')));
const source = await readFile(path.resolve(root, 'commands/player.mjs'), 'utf8');
const embedSource = await readFile(path.resolve(root, 'commands/player/embed.mjs'), 'utf8');
const stripModule = input => input.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
class PlayerControlError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
class Embed {
  setColor(color) { this.color = color; return this; }
  setTitle(title) { this.title = title; return this; }
  setDescription(description) { this.description = description; return this; }
  setFooter(footer) { this.footer = footer; return this; }
  setURL(url) { this.url = url; return this; }
  setTimestamp() { return this; }
  setThumbnail() { return this; }
}
const Utils = {
  clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
  escapeMarkdown: value => value,
  truncate: (value, limit) => value.slice(0, limit),
  progressBar: () => 'progress',
  prettifyMS: ms => String(ms),
};
const {buildPlayerEmbed, panelText} = new Function('Utils', 'EmbedBuilder', 'getGlobalColor', 'STATES', 'PROGRESS',
  stripModule(embedSource) + '\nreturn {buildPlayerEmbed, panelText};'
)(Utils, Embed, () => 0x00aaff, {playing:'playing', paused:'paused', stopped:'stopped'}, {start:'|',end:'|',empty:'.',filled:'#',indicator:'>'});
class CommandBuilder {
  setName() { return this; }
  setDescription() { return this; }
  setCategory() { return this; }
}
const settle = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
function fixture(t, {registrationError = false} = {}) {
  t.mock.timers.enable({apis:['setTimeout', 'setInterval']});
  const panels = new Map();
  let lastDescriptor;
  const registerPlayerPanel = descriptor => {
    if (registrationError) throw new Error('Registry unavailable');
    assert.ok(descriptor.messageId && descriptor.channelId && descriptor.guildId);
    panels.set(descriptor.id, descriptor);
    lastDescriptor = descriptor;
    return () => panels.delete(descriptor.id);
  };
  const {run, showPanelOnQueue} = new Function(
    'randomUUID', 'PlayerControlError', 'registerPlayerPanel', 'CommandBuilder', 'Utils', 'cleanId', 'getGlobalColor', 'logger', 'CONTROLS', 'buildPlayerEmbed', 'panelText',
    stripModule(source) + '\nreturn {run, showPanelOnQueue};'
  )(randomUUID, PlayerControlError, registerPlayerPanel, CommandBuilder, Utils, String, () => 0x00aaff, {warn(){}}, CONTROLS, buildPlayerEmbed, panelText);
  const player = new EventEmitter();
  const current = {title:'Track one', artist:'Artist'};
  Object.assign(player, {
    _guildId:'123456789012345678', _channelId:'234567890123456789',
    paused:false, preferredVolume:0.5, startedPlaying:Date.now(),
    queue:{
      data:[], loop:false, songLoop:false,
      getCurrent:()=>current, isEmpty:()=>true, size:()=>0,
      setSongLoop(value) { this.songLoop = value; },
      setLoop(value) { this.loop = value; },
    },
    _getTrackDurationMs:()=>180000,
    getQueueRemainingTime:()=> '0:00',
    pause() { this.paused = true; this.emit('playback', false); return 'Paused'; },
    resume() { this.paused = false; this.emit('playback', true); return 'Resumed'; },
    setVolume(value) { this.preferredVolume = value; this.emit('volume', value); return 'Volume changed'; },
  });
  let voiceChannel = player._channelId;
  let voiceCheck = async message => {
    assert.equal(message.channel.guildId, player._guildId);
    assert.equal(message.author.id, '456789012345678901');
    return {channelId:voiceChannel};
  };
  const bot = {
    config:{instanceUrl:'https://darkdck.duckdns.org/api', timers:{playerUpdateInterval:5000}},
    players:{checkVoiceChannels:message => voiceCheck(message)},
    getPlayer:async()=>player,
    t:(msg,key)=>key,
  };
  let replies = 0;
  const edits = [];
  const message = {
    id:'345678901234567890',
    // Deliberately no onReaction/react methods: any regression fails opening.
    message:{channelId:'567890123456789012'},
    edit:async data => { edits.push({messageId:message.id, ...data}); return message; },
  };
  const msg = {
    channel:{id:message.message.channelId},
    author:{username:'Owner'},
    reply:async data => { replies++; message.initial = data; return message; },
  };
  const user = {id:'456789012345678901', username:'Verified actor'};
  const dispatch = action => lastDescriptor.dispatch({action,user});
  t.after(async () => {
    if (panels.size) await dispatch('close');
  });
  return {run:()=>run.call(bot,msg), auto:()=>showPanelOnQueue(bot,msg,player), player, message, edits, panels,
    get descriptor() { return lastDescriptor; }, get replies() { return replies; }, dispatch,
    setVoice(value) { voiceChannel = value; }, setVoiceCheck(value) { voiceCheck = value; },
  };
}

test('buttons operate the existing panel, preserve verified actor history and expire on close', async t => {
  const f = fixture(t);
  await f.run();
  assert.equal(f.replies,1);
  assert.equal(f.panels.size,1);
  const initialURL = new URL(f.message.initial.embeds[0].url);
  assert.equal(initialURL.pathname, '/channels/123456789012345678/567890123456789012');
  assert.equal(initialURL.searchParams.get('dxd_player'), `v1.${f.descriptor.id}`);
  await f.dispatch('toggle');
  assert.equal(f.player.paused,true);
  t.mock.timers.tick(100);
  await settle();
  assert.equal(new URL(f.edits.at(-1).embeds[0].url).searchParams.get('paused'),'1');
  assert.match(f.edits.at(-1).embeds[0].description,/Verified actor/);
  await f.dispatch('loop'); assert.equal(f.player.queue.songLoop,true);
  await f.dispatch('loop'); assert.equal(f.player.queue.songLoop,false); assert.equal(f.player.queue.loop,true);
  await f.dispatch('loop'); assert.equal(f.player.queue.loop,false);
  await f.dispatch('volup'); assert.equal(f.player.preferredVolume,0.6);
  await f.dispatch('close');
  assert.equal(f.panels.size,0);
  assert.equal(new URL(f.edits.at(-1).embeds[0].url).searchParams.get('closed'),'1');
  assert.ok(f.edits.every(edit => edit.messageId === f.message.id));
  assert.equal(f.player.listenerCount('startplay'),0);
  assert.equal(f.player._playerPanel,undefined);
  await assert.rejects(f.dispatch('toggle'),{status:410});
});

test('voice is resolved for the verified actor and actions reject outside MusicBot voice', async t => {
  const f = fixture(t);
  await f.run();
  f.setVoice('678901234567890123');
  await assert.rejects(f.dispatch('toggle'),{status:403});
  assert.equal(f.player.paused,false);
  await assert.rejects(f.dispatch('lyrics'),{status:400});
  f.setVoice(f.player._channelId);
});

test('closing during asynchronous voice resolution prevents delayed playback action', async t => {
  const f = fixture(t);
  await f.run();
  let finishVoice;
  f.setVoiceCheck(() => new Promise(resolve => { finishVoice = resolve; }));
  const pending = f.dispatch('toggle');
  f.player.emit('leave');
  await settle();
  finishVoice({channelId:f.player._channelId});
  await assert.rejects(pending,{status:410});
  assert.equal(f.player.paused,false);
  assert.equal(f.panels.size,0);
});

test('successful !play queue event opens one panel and track changes edit that message', async t => {
  const f = fixture(t);
  f.auto();
  f.player.emit('queue',{type:'add'});
  await f.player._playerPanel.opening;
  assert.equal(f.replies,1);
  f.player.emit('startplay',{title:'Track two'});
  t.mock.timers.tick(100);
  await settle();
  assert.ok(f.edits.length);
  assert.match(f.edits.at(-1).embeds[0].description,/Track two/);
  await f.run();
  assert.equal(f.replies,1);
  assert.ok(f.edits.every(edit => edit.messageId === f.message.id));
});


test('seek acknowledges initiation while the audio bridge continues and later controls remain usable', async t => {
  const f = fixture(t);
  await f.run();
  let seekPosition;
  f.player.seekToPosition = position => {
    seekPosition = position;
    return new Promise(() => {}); // Actual bridge play promise can last the whole track.
  };
  const completed = await Promise.race([
    f.dispatch('forward').then(() => true),
    new Promise(resolve => setImmediate(() => resolve(false))),
  ]);
  assert.equal(completed,true,'control request must not wait for audio stream completion');
  assert.ok(seekPosition >= 20000);
  await f.dispatch('toggle');
  assert.equal(f.player.paused,true,'the next queued control must remain executable');
});

for (const rejected of [false,true]) {
  test(`seek failure is handled asynchronously (rejected=${rejected})`, async t => {
    const f = fixture(t);
    await f.run();
    f.player.seekToPosition = () => rejected ? Promise.reject(new Error('Bridge failed')) : Promise.resolve(false);
    await f.dispatch('forward');
    await settle();
    t.mock.timers.tick(100);
    await settle();
    assert.match(f.edits.at(-1).embeds[0].description,/Could not seek this track/);
    assert.equal(f.panels.size,1);
  });
}


test('a stalled voice lookup expires without executing a late action', async t => {
  const f = fixture(t);
  await f.run();
  let finishVoice;
  f.setVoiceCheck(() => new Promise(resolve => { finishVoice = resolve; }));
  const rejected = assert.rejects(f.dispatch('toggle'),{status:409});
  t.mock.timers.tick(4000);
  await rejected;
  assert.equal(f.player.paused,false);
  finishVoice({channelId:f.player._channelId});
  await settle();
  assert.equal(f.player.paused,false,'late voice lookup must not resume the expired action');
  f.setVoiceCheck(async()=>({channelId:f.player._channelId}));
  await f.dispatch('toggle');
  assert.equal(f.player.paused,true,'later actions still work after the timed-out lookup');
});

test('registration failure closes the message and removes session listeners', async t => {
  const f = fixture(t,{registrationError:true});
  await f.run();
  assert.equal(f.panels.size,0);
  assert.equal(f.player._playerPanel,undefined);
  assert.equal(f.player.listenerCount('startplay'),0);
  assert.equal(new URL(f.edits.at(-1).embeds[0].url).searchParams.get('closed'),'1');
});
