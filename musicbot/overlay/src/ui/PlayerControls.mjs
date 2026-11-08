// SPDX-License-Identifier: AGPL-3.0-or-later
// DxD's player controls are authenticated application requests, not reactions.
import { createServer } from "node:http";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNOWFLAKE = /^\d{1,20}$/;
const ACTIONS = new Set(["previous", "back", "toggle", "forward", "skip", "shuffle", "stop", "loop", "voldown", "volup", "lyrics", "filter", "close"]);
const PANELS = new Map();
const MAX_BODY = 4096;
const MAX_PANELS = 1000;
const MAX_REQUESTS = 128;
const REQUEST_TTL = 5 * 60_000;

export class PlayerControlError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Register exactly one live message. Disposing immediately invalidates queued controls. */
export function registerPlayerPanel({ id, messageId, channelId, guildId, dispatch }) {
  if (!UUID.test(id) || ![messageId, channelId, guildId].every(value => SNOWFLAKE.test(String(value))) || typeof dispatch !== "function") {
    throw new TypeError("Invalid player panel registration");
  }
  const key = id.toLowerCase();
  if (PANELS.has(key)) throw new Error("Player panel is already registered");
  if (PANELS.size >= MAX_PANELS) throw new Error("Too many player panels");
  const panel = {
    messageId: String(messageId), channelId: String(channelId), guildId: String(guildId), dispatch,
    active: true, requests: new Map(), tail: Promise.resolve(), queued: 0,
  };
  PANELS.set(key, panel);
  return () => {
    panel.active = false;
    if (PANELS.get(key) === panel) PANELS.delete(key);
  };
}

function response(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function fail(status, message) {
  throw new PlayerControlError(status, message);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on("error", () => reject(new PlayerControlError(400, "Could not read request.")));
    req.on("end", () => {
      if (size > MAX_BODY) return reject(new PlayerControlError(413, "Request is too large."));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || Array.isArray(body) || typeof body !== "object") throw new Error();
        const fields = Object.keys(body);
        if (fields.length !== 4 || fields.some(key => !["action", "message_id", "channel_id", "request_id"].includes(key)) ||
            !ACTIONS.has(body.action) || typeof body.message_id !== "string" || typeof body.channel_id !== "string" ||
            typeof body.request_id !== "string" || !UUID.test(body.request_id)) throw new Error();
        resolve(body);
      } catch {
        reject(new PlayerControlError(400, "Invalid player control request."));
      }
    });
  });
}

function allowRate(buckets, key, limit, window = 60_000) {
  const now = Date.now();
  let item = buckets.get(key);
  if (!item || item.until <= now) {
    // Bounded even when many different accounts or proxy addresses are used.
    if (buckets.size >= 4096) {
      for (const [id, bucket] of buckets) if (bucket.until <= now) buckets.delete(id);
      if (buckets.size >= 4096) return false;
    }
    item = { count: 0, until: now + window };
    buckets.set(key, item);
  }
  return ++item.count <= limit;
}

async function apiJSON(fetchImpl, apiBase, path, token, signal) {
  let result;
  try {
    result = await fetchImpl(`${apiBase}/v1${path}`, {
      method: "GET", redirect: "error",
      headers: { Authorization: token, Accept: "application/json" },
      signal,
    });
  } catch {
    fail(502, "Could not verify your account. Please try again.");
  }
  if (result.status === 401) fail(401, "Please sign in again.");
  if (result.status === 403 || result.status === 404) fail(403, "You cannot access this player message.");
  if (result.status === 429) fail(429, "Too many requests. Please wait a moment.");
  if (!result.ok) fail(502, "Could not verify your account. Please try again.");
  try { return await result.json(); }
  catch { fail(502, "Could not verify your account. Please try again."); }
}

function normalizedError(error) {
  if (error instanceof PlayerControlError && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    return { status: error.status, body: { error: error.message } };
  }
  return { status: 500, body: { error: "Player control failed. Please try again." } };
}

async function runAction(panel, body, user) {
  const now = Date.now();
  for (const [key, item] of panel.requests) if (item.done && item.until <= now) panel.requests.delete(key);
  const requestKey = `${user.id}:${body.request_id.toLowerCase()}`;
  const previous = panel.requests.get(requestKey);
  if (previous) {
    if (previous.action !== body.action) fail(409, "This request ID was already used for another action.");
    return previous.promise;
  }
  if (panel.queued >= 16) fail(429, "The player is busy. Please wait a moment.");
  // Discard the oldest completed entry when a panel remains active for hours.
  if (panel.requests.size >= MAX_REQUESTS) {
    for (const [key, item] of panel.requests) {
      if (item.done) { panel.requests.delete(key); break; }
    }
  }
  if (panel.requests.size >= MAX_REQUESTS) fail(429, "The player is busy. Please wait a moment.");
  const entry = { action: body.action, until: now + REQUEST_TTL, done: false, promise: null };
  panel.queued++;
  entry.promise = panel.tail.then(async () => {
    if (!panel.active) return { status: 410, body: { error: "This player panel has closed. Use !player to open it again." } };
    try {
      await panel.dispatch({ action: body.action, user });
      return { status: 200, body: { ok: true } };
    } catch (error) {
      return normalizedError(error);
    }
  }).finally(() => {
    panel.queued--;
    entry.done = true;
  });
  // Keep the queue alive even if a future dispatcher has an unexpected failure.
  panel.tail = entry.promise.then(() => {}, () => {});
  panel.requests.set(requestKey, entry);
  return entry.promise;
}

/** Start only on the private container network; Caddy publishes the scoped API route. */
export async function startPlayerControlServer(bot, { port = 8787, host = "0.0.0.0", fetchImpl = globalThis.fetch } = {}) {
  const apiBase = String(bot.config.instanceUrl).replace(/\/+$/, "");
  const apiOrigin = new URL(apiBase).origin;
  const allowedOrigins = new Set([apiOrigin, "https://darkdc.pp.ua", "fluxer-app://app"]);
  const ipRate = new Map();
  const userRate = new Map();
  const server = createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      res.setHeader("Vary", "Origin");
      if (origin && !allowedOrigins.has(origin)) fail(403, "This origin cannot control the player.");
      if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
      if (!/^\/api\/v1\/musicbot\/panels\/([0-9a-f-]+)\/actions$/i.test(req.url ?? "")) fail(404, "Unknown player endpoint.");
      const id = req.url.split("/")[5];
      if (!UUID.test(id)) fail(404, "Unknown player endpoint.");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        res.setHeader("Access-Control-Max-Age", "600");
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method !== "POST") fail(405, "Use POST for player controls.");
      if (!allowRate(ipRate, req.socket.remoteAddress ?? "unknown", 1200)) fail(429, "Too many requests. Please wait a moment.");
      const token = req.headers.authorization;
      if (typeof token !== "string" || token.length < 8 || token.length > 8192) fail(401, "Sign in to control the player.");
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) fail(415, "Use a JSON request.");
      if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) fail(413, "Request is too large.");
      const body = await readBody(req);
      const panel = PANELS.get(id.toLowerCase());
      if (!panel?.active) fail(410, "This player panel has closed. Use !player to open it again.");
      if (body.message_id !== panel.messageId || body.channel_id !== panel.channelId) fail(403, "This request does not match the player message.");
      // One deadline covers the whole verification chain, below the client's
      // timeout; three independent fetch timeouts could otherwise total 24 s.
      const verificationSignal = AbortSignal.timeout(8_000);
      const account = await apiJSON(fetchImpl, apiBase, "/users/@me", token, verificationSignal);
      if (!SNOWFLAKE.test(String(account.id)) || account.bot) fail(403, "Only signed-in users can control the player.");
      if (account.account_limited) fail(403, "Your account cannot use player controls at the moment.");
      const user = { id: String(account.id), username: String(account.username ?? "User"), bot: false };
      if (!allowRate(userRate, user.id, 90)) fail(429, "Too many controls. Please wait a moment.");
      const message = await apiJSON(fetchImpl, apiBase, `/channels/${panel.channelId}/messages/${panel.messageId}`, token, verificationSignal);
      if (String(message.id) !== panel.messageId || String(message.channel_id) !== panel.channelId) fail(403, "You cannot access this player message.");
      // Reading a message remains allowed while timed out. Keep the moderation
      // restriction that the former reaction controls received from the API.
      const member = await apiJSON(fetchImpl, apiBase, `/guilds/${panel.guildId}/members/@me`, token, verificationSignal);
      if (String(member.user?.id) !== user.id) fail(403, "You are not a member of this player community.");
      if (member.communication_disabled_until != null) {
        const until = Date.parse(member.communication_disabled_until);
        if (!Number.isFinite(until)) fail(502, "Could not verify your community membership. Please try again.");
        if (until > Date.now()) fail(403, "Player controls are unavailable while you are timed out.");
      }
      // The dispatcher checks voice membership immediately before modifying playback.
      const result = await runAction(panel, body, user);
      response(res, result.status, result.body);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof PlayerControlError) response(res, error.status, { error: error.message });
      else response(res, 500, { error: "Player control failed. Please try again." });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  await new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => { server.off("error", onError); resolve(); });
  });
  return server;
}
