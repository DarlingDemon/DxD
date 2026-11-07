import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// Run from the patched Remix checkout to exercise its actual classes.
const { default: Player } = await import(pathToFileURL(path.resolve("src/music/player/Player.mjs")));
const { default: Remix } = await import(pathToFileURL(path.resolve("src/core/Bot.mjs")));

function setup(t, { paused = false, queued = true } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const player = Object.create(Player.prototype);
  EventEmitter.call(player);
  Object.assign(player, {
    _guildId: "123456789012345678",
    _channelId: "234567890123456789",
    _inactivityLimit: 180_000,
    _inactivityTimer: null,
    _stayInVoice: false,
    _paused: paused,
    _maxQueueSize: 100,
    connection: {},
    humans: false,
    mode: "off",
    queue: {
      data: [],
      getCurrent: () => queued ? { title: "Playing track" } : null,
      isEmpty: () => !queued,
      add(track) { this.data.push(track); },
    },
  });
  player._get247Mode = () => player.mode;
  player._hasHumansInChannel = () => player.humans;
  let departures = 0;
  player.on("autoleave", () => { departures += 1; });

  const bot = Object.create(Remix.prototype);
  Object.assign(bot, {
    players: { playerMap: new Map([[player._channelId, player]]) },
    client: { guilds: new Map() },
    voiceCache: { hasHumansInChannel: () => player.humans },
  });
  t.after(() => player._stopInactivityTimer());
  return { player, bot, departures: () => departures };
}

for (const paused of [false, true]) {
  test(`leaves an empty channel with queued music while paused=${paused}`, (t) => {
    const { player, bot, departures } = setup(t, { paused });
    bot._runAloneCheck();
    for (let check = 0; check < 5; check += 1) {
      t.mock.timers.tick(30_000);
      bot._runAloneCheck();
      // Queue changes must preserve the existing departure deadline too.
      player.addToQueue({ title: "Another track" });
    }
    assert.equal(departures(), 0);
    t.mock.timers.tick(30_000);
    assert.equal(departures(), 1);
    assert.equal(player._inactivityTimer, null);
  });
}

test("an idle empty channel uses the same grace period", (t) => {
  const { bot, departures } = setup(t, { queued: false });
  bot._runAloneCheck();
  t.mock.timers.tick(179_999);
  assert.equal(departures(), 0);
  t.mock.timers.tick(1);
  assert.equal(departures(), 1);
});

test("a returning listener cancels departure and the next absence gets a fresh wait", (t) => {
  const { player, bot, departures } = setup(t);
  bot._runAloneCheck();
  t.mock.timers.tick(90_000);
  player.humans = true;
  bot._runAloneCheck();
  t.mock.timers.tick(180_000);
  assert.equal(departures(), 0);
  player.humans = false;
  bot._runAloneCheck();
  t.mock.timers.tick(179_999);
  assert.equal(departures(), 0);
  t.mock.timers.tick(1);
  assert.equal(departures(), 1);
});

test("the final occupancy check protects a listener who joined before expiry", (t) => {
  const { player, bot, departures } = setup(t);
  bot._runAloneCheck();
  player.humans = true;
  t.mock.timers.tick(180_000);
  assert.equal(departures(), 0);
});

test("24/7, stay-in-voice and disabled timers prevent departure", (t) => {
  const { player, bot, departures } = setup(t);
  player.mode = "on";
  bot._runAloneCheck();
  t.mock.timers.tick(180_000);
  player.mode = "off";
  player._stayInVoice = true;
  bot._runAloneCheck();
  t.mock.timers.tick(180_000);
  player._stayInVoice = false;
  player._inactivityLimit = 0;
  bot._runAloneCheck();
  t.mock.timers.tick(180_000);
  assert.equal(departures(), 0);
});

test("24/7 enabled during the wait prevents departure", (t) => {
  const { player, bot, departures } = setup(t);
  bot._runAloneCheck();
  player.mode = "on";
  t.mock.timers.tick(180_000);
  assert.equal(departures(), 0);
});
