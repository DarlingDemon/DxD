import {readFileSync, renameSync, writeFileSync} from 'node:fs';

const ROOM_GRACE_MS = 15_000;
const VOICE = 2;
const isId = (value) => typeof value === 'string' && /^\d{16,22}$/u.test(value);
const connectionKey = (state) => state.connection_id ?? state.user_id;
const channelName = (value) => Array.from(String(value).replace(/[\p{Cc}\s]+/gu, ' ').trim()).slice(0, 100).join('');

export class TemporaryRooms {
  constructor({rest, guildId, creatorId, stateFile, isReady, onError = console.error, graceMs = ROOM_GRACE_MS}) {
    Object.assign(this, {rest, guildId, creatorId, stateFile, isReady, onError, graceMs});
    this.rooms = new Map();
    this.connections = new Map();
    this.pending = new Set();
    this.deletions = new Map();
    this.hasSnapshot = false;
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (state.guildId !== guildId) throw new Error('Room state belongs to a different community');
      for (const room of state.rooms) {
        if (isId(room.id) && isId(room.owner) && room.id !== creatorId) this.rooms.set(room.id, room);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  save() {
    const temporary = `${this.stateFile}.next`;
    writeFileSync(temporary, JSON.stringify({guildId: this.guildId, rooms: [...this.rooms.values()]}), {mode: 0o600});
    renameSync(temporary, this.stateFile);
  }

  replaceVoiceSnapshot(states) {
    this.connections.clear();
    for (const state of states) {
      if (state.user_id && state.channel_id) this.connections.set(connectionKey(state), state);
    }
    this.hasSnapshot = true;
    for (const id of this.rooms.keys()) this.scheduleCleanup(id);
  }

  invalidateVoiceSnapshot() {
    this.connections.clear();
    this.hasSnapshot = false;
    for (const timer of this.deletions.values()) clearTimeout(timer);
    this.deletions.clear();
  }

  async onVoiceState(state, isBot = false) {
    if (state.guild_id !== this.guildId || !isId(state.user_id)) return;
    const key = connectionKey(state);
    const previous = this.connections.get(key)?.channel_id;
    if (state.channel_id) this.connections.set(key, state);
    else this.connections.delete(key);

    if (previous && previous !== state.channel_id) this.scheduleCleanup(previous);
    if (state.channel_id !== this.creatorId || previous === this.creatorId || isBot || state.member?.user?.bot) return;
    if (this.pending.has(state.user_id) || !this.hasSnapshot || !this.isReady()) return;
    this.pending.add(state.user_id);
    try {
      await this.enterRoom(state, key);
    } finally {
      this.pending.delete(state.user_id);
    }
  }

  async enterRoom(state, key) {
    const stillInCreator = () => this.isReady() && this.connections.get(key)?.channel_id === this.creatorId;
    let room = [...this.rooms.values()].find((room) => room.owner === state.user_id);
    if (!room) {
      const creator = await this.rest.get(`/channels/${this.creatorId}`);
      if (creator.type !== VOICE || creator.guild_id !== this.guildId || !creator.parent_id || !stillInCreator()) return;
      const username = state.member?.nick ?? state.member?.user?.global_name ?? state.member?.user?.username ?? 'Участник';
      const channel = await this.rest.post(`/guilds/${this.guildId}/channels`, {
        body: {type: VOICE, parent_id: creator.parent_id, name: channelName(`Комната · ${username}`)},
      });
      room = {id: channel.id, owner: state.user_id};
      this.rooms.set(room.id, room);
      this.scheduleCleanup(room.id);
      this.save();
    }
    if (!stillInCreator()) return;
    const body = {channel_id: room.id};
    if (state.connection_id) body.connection_id = state.connection_id;
    await this.rest.patch(`/guilds/${this.guildId}/members/${state.user_id}`, {body});
  }

  scheduleCleanup(id) {
    if (!this.rooms.has(id) || this.deletions.has(id)) return;
    const timer = setTimeout(() => {
      this.deletions.delete(id);
      if (!this.hasSnapshot || !this.isReady() || this.occupants(id).length) return;
      if (this.pending.has(this.rooms.get(id)?.owner)) {
        this.scheduleCleanup(id);
        return;
      }
      void this.removeRoom(id).catch(this.onError);
    }, this.graceMs);
    timer.unref?.();
    this.deletions.set(id, timer);
  }

  occupants(id) {
    return [...this.connections.values()].filter((state) => state.channel_id === id);
  }

  async removeRoom(id) {
    if (!this.rooms.has(id) || id === this.creatorId) return;
    try {
      await this.rest.delete(`/channels/${id}`);
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
    this.forgetRoom(id);
  }

  forgetRoom(id) {
    clearTimeout(this.deletions.get(id));
    this.deletions.delete(id);
    if (this.rooms.delete(id)) this.save();
  }

  async command(userId, action, value) {
    if (!this.hasSnapshot || !this.isReady()) return 'Подожди, бот ещё загружает список голосовых подключений.';
    const state = [...this.connections.values()].find((state) => state.user_id === userId && this.rooms.has(state.channel_id));
    if (!state) return 'Сначала войди во временную комнату.';
    const room = this.rooms.get(state.channel_id);
    if (action === 'claim') {
      if (this.occupants(room.id).some((state) => state.user_id === room.owner)) return 'Владелец сейчас в комнате.';
      room.owner = userId;
      this.save();
      return 'Теперь ты владелец комнаты.';
    }
    if (room.owner !== userId) return 'Эту команду может использовать владелец комнаты.';
    const name = channelName(value);
    const limit = /^\d{1,2}$/u.test(value) ? Number(value) : null;
    if (action === 'name' && name) {
      await this.rest.patch(`/channels/${room.id}`, {body: {name}});
      return 'Название комнаты изменено.';
    }
    if (action === 'limit' && limit !== null) {
      await this.rest.patch(`/channels/${room.id}`, {body: {user_limit: limit}});
      return limit ? `Лимит комнаты — ${limit}.` : 'Лимит комнаты снят.';
    }
    return 'Команды комнаты — `!room name Название`, `!room limit 0–99`, `!room claim`.';
  }
}
