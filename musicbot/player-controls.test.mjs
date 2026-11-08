// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerPlayerPanel, startPlayerControlServer, PlayerControlError } from "./overlay/src/ui/PlayerControls.mjs";

const goodToken = "a-valid-user-token";
const messageId = "123456789012345679";
const channelId = "123456789012345680";
const guildId = "123456789012345681";
const userId = "123456789012345682";

async function fixture(t, { dispatch = async () => {}, getUser, getMessage, getMember } = {}) {
  const id = randomUUID();
  const calls = [];
  const unregister = registerPlayerPanel({ id, messageId, channelId, guildId, dispatch });
  const server = await startPlayerControlServer({ config: { instanceUrl: "https://darkdck.duckdns.org/api/" } }, {
    port: 0, host: "127.0.0.1",
    fetchImpl: async (url, options) => {
      calls.push({ url, token: options.headers.Authorization, signal: options.signal });
      assert.equal(options.redirect, "error");
      if (options.headers.Authorization !== goodToken) return Response.json({}, { status: 401 });
      if (url.endsWith("/users/@me")) return getUser?.() ?? Response.json({ id: userId, username: "Listener" });
      if (url.endsWith("/members/@me")) {
        assert.equal(url, `https://darkdck.duckdns.org/api/v1/guilds/${guildId}/members/@me`);
        return getMember?.() ?? Response.json({ user: { id: userId }, communication_disabled_until: null });
      }
      assert.equal(url, `https://darkdck.duckdns.org/api/v1/channels/${channelId}/messages/${messageId}`);
      return getMessage?.() ?? Response.json({ id: messageId, channel_id: channelId });
    },
  });
  t.after(async () => {
    unregister();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/musicbot/panels/${id}/actions`;
  const send = (body = {}, headers = {}) => fetch(url, {
    method: "POST", headers: { Authorization: goodToken, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ action: "skip", message_id: messageId, channel_id: channelId, request_id: randomUUID(), ...body }),
  });
  return { id, server, url, send, unregister, calls };
}

test("a real button dispatches as the API-authenticated user after checking message access", async t => {
  let actor;
  const f = await fixture(t, { dispatch: async value => { actor = value; } });
  const res = await f.send();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(actor, { action: "skip", user: { id: userId, username: "Listener", bot: false } });
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(call => call.token === goodToken));
  assert.ok(f.calls[0].signal instanceof AbortSignal);
  assert.ok(f.calls.every(call => call.signal === f.calls[0].signal), "all verification reads share one deadline");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("unauthorized requests and bot tokens cannot change playback", async t => {
  let count = 0;
  const f = await fixture(t, { dispatch: async () => { count++; } });
  assert.equal((await f.send({}, { Authorization: "" })).status, 401);
  assert.equal((await f.send({}, { Authorization: "bad-account-token" })).status, 401);
  assert.equal(count, 0);
  const bot = await fixture(t, { getUser: () => Response.json({ id: userId, bot: true }), dispatch: async () => { count++; } });
  assert.equal((await bot.send()).status, 403);
  assert.equal(count, 0);
});

test("message and channel are bound to registration, and body identity cannot be spoofed", async t => {
  let count = 0;
  const f = await fixture(t, { dispatch: async () => { count++; } });
  assert.equal((await f.send({ message_id: "999" })).status, 403);
  assert.equal((await f.send({ channel_id: "999" })).status, 403);
  assert.equal((await f.send({ user_id: "999" })).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal(count, 0);
});

test("an account without access to the actual panel message is rejected", async t => {
  let count = 0;
  const f = await fixture(t, {
    getMessage: () => Response.json({}, { status: 403 }),
    dispatch: async () => { count++; },
  });
  assert.equal((await f.send()).status, 403);
  assert.equal(count, 0);
  const wrong = await fixture(t, {
    getMessage: () => Response.json({ id: "different", channel_id: channelId }),
    dispatch: async () => { count++; },
  });
  assert.equal((await wrong.send()).status, 403);
  assert.equal(count, 0);
});

test("limited accounts, timed-out members, and mismatched guild membership cannot dispatch", async t => {
  let count = 0;
  const dispatch = async () => { count++; };
  const limited = await fixture(t, {
    getUser: () => Response.json({ id: userId, account_limited: true }), dispatch,
  });
  assert.equal((await limited.send()).status, 403);
  const timedOut = await fixture(t, {
    getMember: () => Response.json({ user: { id: userId }, communication_disabled_until: new Date(Date.now() + 60_000).toISOString() }), dispatch,
  });
  assert.equal((await timedOut.send()).status, 403);
  const mismatch = await fixture(t, { getMember: () => Response.json({ user: { id: "999" } }), dispatch });
  assert.equal((await mismatch.send()).status, 403);
  assert.equal(count, 0);
  const expired = await fixture(t, {
    getMember: () => Response.json({ user: { id: userId }, communication_disabled_until: new Date(Date.now() - 60_000).toISOString() }), dispatch,
  });
  assert.equal((await expired.send()).status, 200);
  assert.equal(count, 1);
});

test("concurrent retries execute skip exactly once and conflicting reuse returns409", async t => {
  let count = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { dispatch: async () => { count++; await gate; } });
  const request_id = randomUUID();
  const a = f.send({ request_id });
  const b = f.send({ request_id });
  await new Promise(resolve => setTimeout(resolve, 40));
  release();
  assert.deepEqual(await Promise.all([a, b]).then(items => items.map(res => res.status)), [200, 200]);
  assert.equal(count, 1);
  assert.equal((await f.send({ request_id, action: "stop" })).status, 409);
  assert.equal(count, 1);
});

test("actions are serialized and unregister invalidates actions still in the queue", async t => {
  const actions = [];
  let release;
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { dispatch: async ({ action }) => { actions.push(action); started(); await gate; } });
  const first = f.send({ action: "toggle" });
  await began;
  const second = f.send({ action: "skip" });
  await new Promise(resolve => setTimeout(resolve, 40));
  f.unregister();
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 410);
  assert.deepEqual(actions, ["toggle"]);
  assert.equal((await f.send()).status, 410);
});

test("voice membership errors reach the client without exposing internal errors", async t => {
  const f = await fixture(t, { dispatch: async () => { throw new PlayerControlError(403, "Join the MusicBot voice channel first."); } });
  const response = await f.send();
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Join the MusicBot voice channel first." });
  const internal = await fixture(t, { dispatch: async () => { throw new Error("private diagnostic"); } });
  const failure = await internal.send();
  assert.equal(failure.status, 500);
  assert.equal(JSON.stringify(await failure.json()).includes("private diagnostic"), false);
});

test("CORS, malformed actions, and oversized bodies cannot dispatch", async t => {
  let count = 0;
  const f = await fixture(t, { dispatch: async () => { count++; } });
  assert.equal((await f.send({}, { Origin: "https://evil.example" })).status, 403);
  const options = await fetch(f.url, { method: "OPTIONS", headers: { Origin: "fluxer-app://app" } });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("access-control-allow-origin"), "fluxer-app://app");
  assert.equal((await f.send({ action: "delete-server" })).status, 400);
  assert.equal((await f.send({ request_id: "anything" })).status, 400);
  assert.equal((await f.send({ action: "x".repeat(5000) })).status, 413);
  assert.equal(count, 0);
});

test("expired panels and unknown routes return clear failures without API requests", async t => {
  const f = await fixture(t);
  f.unregister();
  const response = await f.send();
  assert.equal(response.status, 410);
  assert.match((await response.json()).error, /!player/);
  assert.equal(f.calls.length, 0);
  assert.equal((await fetch(f.url.replace(f.id, "not-a-uuid"))).status, 404);
});
