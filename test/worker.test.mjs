// offline tests for src/worker.js: plain `node --test`, no install, no network.
// the worker's wrangler imports (.html/.svg as text, .png as data) are loaded by a tiny module hook, and
// the cloudflare globals it uses (caches.default, KV, crypto.subtle.timingSafeEqual, fetch) are stubbed.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";

nodeModule.registerHooks({
  load(url, context, next) {
    const asText = /\.(html|svg)$/.test(url), asData = /\.png$/.test(url), isWorker = url.endsWith("/src/worker.js");
    if (!asText && !asData && !isWorker) return next(url, context);
    const file = new URL(url);
    const source = isWorker ? readFileSync(file, "utf8")
      : asText ? "export default " + JSON.stringify(readFileSync(file, "utf8"))
      : `export default new Uint8Array(${JSON.stringify([...readFileSync(file)])}).buffer`;
    return { format: "module", source, shortCircuit: true };
  },
});

// cloudflare's subtle.timingSafeEqual is not in node's webcrypto
globalThis.crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

// a controllable clock: the worker, the fake cache and the fake upstreams all read Date.now()
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;

// caches.default stand-in that honors max-age like the Cache API does
function makeCache() {
  const store = new Map();
  return {
    store,
    async match(req) {
      const e = store.get(new Request(req).url);
      if (!e) return undefined;
      if (Date.now() >= e.exp) { store.delete(new Request(req).url); return undefined; }
      return new Response(e.body, { headers: e.headers });
    },
    async put(req, res) {
      const age = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") || "")?.[1] || 0);
      store.set(new Request(req).url, { body: await res.text(), headers: [...res.headers], exp: Date.now() + age * 1000 });
    },
  };
}

// workers KV stand-in
function makeKV(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    async get(k, type) {
      if (!m.has(k)) return null;
      const v = m.get(k);
      if (type === "json") return JSON.parse(v);
      if (type === "arrayBuffer") return v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : new TextEncoder().encode(v).buffer;
      return v;
    },
    async put(k, v, opts) { m.set(k, v instanceof ArrayBuffer ? new Uint8Array(v) : v); m.set("ttl:" + k, opts?.expirationTtl); },
    async delete(k) { m.delete(k); },
  };
}

// upstream stand-ins; calls are counted when made, before the (optional) delay
let calls, upstreamDelay, githubStatus;
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  calls.signals.push(init.signal);
  const host = u.hostname;
  calls[host] = (calls[host] || 0) + 1;
  await new Promise(r => setTimeout(r, upstreamDelay));
  if (host === "api.github.com") return githubStatus === 200
    ? Response.json([{ type: "PushEvent", repo: { name: "thegreatalxx/heyalex.dev" }, created_at: new Date(Date.now() - 60e3).toISOString() }])
    : new Response("rate limited", { status: githubStatus });
  if (host === "ws.audioscrobbler.com") return Response.json({ recenttracks: { track: [{ name: "a song", artist: { "#text": "an artist" } }] } });
  if (host === "api-web.nhle.com") return Response.json({ games: [] });
  if (host === "cdn.nba.com") return Response.json({ scoreboard: { games: [] } });
  throw new Error("unexpected upstream " + host);
};

const STATUS_TOKEN = "s".repeat(40);
let env, worker;
const { default: w } = await import("../src/worker.js");
worker = w;
const HTML = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
const PROJECTS = JSON.parse(/<script type="application\/json" id="projects-data">([\s\S]*?)<\/script>/.exec(HTML)[1]);
const PAGES = JSON.parse(/<script type="application\/json" id="pages-data">([\s\S]*?)<\/script>/.exec(HTML)[1]);

beforeEach(() => {
  skew = 0;
  upstreamDelay = 0;
  githubStatus = 200;
  calls = { signals: [] };
  globalThis.caches = { default: makeCache() };
  env = { STATUS: makeKV(), LASTFM_USER: "u", GH_USER: "u", LASTFM_KEY: "k", GH_TOKEN: "g", STATUS_TOKEN };
});

// one request through the worker; waits for its waitUntil work too, like the runtime would
async function call(path, init = {}, host = "heyalex.dev") {
  const pending = [];
  const res = await worker.fetch(new Request(`https://${host}${path}`, init), env, { waitUntil: p => pending.push(p) });
  await Promise.allSettled(pending);
  return res;
}
const scriptHashes = html => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`);

test("home page: server-rendered, hash-only csp that matches the page script, security headers", async () => {
  const res = await call("/");
  assert.equal(res.status, 200);
  const body = await res.text(), csp = res.headers.get("content-security-policy");
  for (const h of scriptHashes(body)) assert.ok(csp.includes(h), "csp allows the page script");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("strict-transport-security"), /max-age=31536000/);
  assert.ok(body.includes(`href="/work/${PROJECTS[0].id}"`), "project list is server-rendered");
  const head = await call("/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("project and standalone pages render their detail view on the server", async () => {
  const p = PROJECTS[0];
  const res = await call(`/work/${p.id}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('<section id="detail">'), "detail section is shown");
  assert.ok(body.includes(`<h1 id="dtitle">`), "title is filled in");
  assert.ok(body.includes(`<link rel="canonical" href="https://heyalex.dev/work/${p.id}">`));
  assert.ok(body.includes('<section id="work" hidden>'), "the rest of main is hidden");
  const pg = PAGES[0];
  const page = await (await call(`/${pg.id}`)).text();
  assert.ok(page.includes('<section id="detail">') && page.includes('href="/#more">← Home</a>'));
});

test("unknown paths are a real 404 instead of a permanent redirect", async () => {
  for (const path of ["/nope", "/work/not-a-project", "/school"]) {
    const res = await call(path);
    assert.equal(res.status, 404, path);
    assert.equal(res.headers.get("location"), null);
    assert.equal(res.headers.get("x-robots-tag"), "noindex");
    assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match(await res.text(), /href="\/"/);
  }
  assert.equal((await call("/api/nope")).status, 404);
});

test("redirects: /photography, www, and any *.workers.dev host go to heyalex.dev", async () => {
  let res = await call("/photography");
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "https://heyalex.dev/#side");
  res = await call("/work/x?y=1", {}, "www.heyalex.dev");
  assert.equal(res.headers.get("location"), "https://heyalex.dev/work/x?y=1");
  for (const host of ["heyalex.someone.workers.dev", "abc123-heyalex.someone.workers.dev"]) {
    res = await call("/api/push", {}, host);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "https://heyalex.dev/api/push");
  }
  assert.equal(calls["api.github.com"], undefined, "no upstream call is made for a workers.dev host");
});

test("read-only routes refuse other methods", async () => {
  for (const path of ["/og.mp4", "/og-card", "/favicon.svg", "/", "/nope"]) {
    const res = await call(path, { method: "POST" });
    assert.equal(res.status, 405, path);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
  }
});

test("/og-card: csp covers both inline scripts, framing is blocked, only known phases are clicked", async () => {
  const res = await call("/og-card?p=dusk");
  assert.equal(res.status, 200);
  const body = await res.text(), csp = res.headers.get("content-security-policy");
  const hashes = scriptHashes(body);
  assert.equal(hashes.length, 2, "page script plus the og click script");
  for (const h of hashes) assert.ok(csp.includes(h));
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.ok(body.includes('["rise","noon","set","dusk","night","live"].includes(p)'));
});

test("POST /api/status needs STATUS_TOKEN and rejects non-object bodies", async () => {
  const post = (body, auth) => call("/api/status", { method: "POST", headers: auth ? { authorization: auth } : {}, body });
  assert.equal((await post('{"kind":"claude"}')).status, 401);
  assert.equal((await post('{"kind":"claude"}', "Bearer wrong")).status, 401);
  env.STATUS.m.set("uploadtoken", "u".repeat(40));
  assert.equal((await post('{"kind":"claude"}', "Bearer " + "u".repeat(40))).status, 401, "the upload token cannot set the status");
  for (const bad of ["null", "[]", "3", '"x"', "{"]) assert.equal((await post(bad, "Bearer " + STATUS_TOKEN)).status, 400, bad);
  let res = await post('{"kind":"custom","text":"  at the gym  ","minutes":60}', "Bearer " + STATUS_TOKEN);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(env.STATUS.m.get("manual")), { kind: "custom", text: "at the gym" });
  assert.equal(env.STATUS.m.get("ttl:manual"), 3600);
  assert.deepEqual(await (await call("/api/status")).json(), { kind: "custom", text: "at the gym" });
  res = await post('{"clear":true}', "Bearer " + STATUS_TOKEN);
  assert.equal(res.status, 200);
  assert.equal(env.STATUS.m.has("manual"), false);
});

test("PUT /api/asset: auth, name allowlist, and an oversize body is refused before it is read", async () => {
  const fakeReq = (name, headers, readBody) => ({
    url: `https://heyalex.dev/api/asset/${name}`, method: "PUT", headers: new Headers(headers),
    arrayBuffer: readBody || (async () => { throw new Error("body must not be read"); }),
  });
  const send = req => worker.fetch(req, env, { waitUntil() {} });
  assert.equal((await send(fakeReq("og-rise.jpg", {}))).status, 401);
  assert.equal((await send(fakeReq("og-rise.jpg", { authorization: "Bearer " + "x".repeat(40) }))).status, 401);
  assert.equal((await send(fakeReq("manual", { authorization: "Bearer " + STATUS_TOKEN }))).status, 400);
  assert.equal((await send(fakeReq("og-rise.jpg.bak", { authorization: "Bearer " + STATUS_TOKEN }))).status, 400);
  assert.equal((await send(fakeReq("og-rise.jpg", { authorization: "Bearer " + STATUS_TOKEN, "content-length": "5000000" }))).status, 413);
  env.STATUS.m.set("uploadtoken", "short");
  assert.equal((await send(fakeReq("og-rise.jpg", { authorization: "Bearer short" }))).status, 401, "tokens under 32 chars are ignored");
  env.STATUS.m.set("uploadtoken", "u".repeat(40));
  const ok = await send(fakeReq("og-rise.jpg", { authorization: "Bearer " + "u".repeat(40) }, async () => new Uint8Array([1, 2, 3]).buffer));
  assert.equal(ok.status, 200);
  assert.deepEqual([...env.STATUS.m.get("asset:og-rise.jpg")], [1, 2, 3]);
});

test("/og.mp4 byte ranges", async () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (const ph of ["rise", "noon", "set", "dusk", "night"]) env.STATUS.m.set(`asset:og-${ph}.mp4`, bytes);
  const get = range => call("/og.mp4", { headers: range ? { range } : {} });
  let res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await res.arrayBuffer()).byteLength, 10);
  res = await get("bytes=2-4");
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 2-4/10");
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [2, 3, 4]);
  res = await get("bytes=-3");
  assert.equal(res.headers.get("content-range"), "bytes 7-9/10");
  res = await get("bytes=8-100");
  assert.equal(res.headers.get("content-range"), "bytes 8-9/10");
  for (const r of ["bytes=5-2", "bytes=10-", "bytes=-0", "bytes=-"]) assert.equal((await get(r)).status, 416, r);
});

test("cached(): concurrent misses share one upstream call", async () => {
  upstreamDelay = 30;
  const res = await Promise.all(Array.from({ length: 25 }, () => call("/api/push")));
  assert.equal(calls["api.github.com"], 1, "25 concurrent cold requests make one GitHub call");
  for (const r of res) assert.equal((await r.json()).repo, "heyalex.dev");
  await Promise.all(Array.from({ length: 10 }, () => call("/api/push")));
  assert.equal(calls["api.github.com"], 1, "fresh hits make no call");
});

test("cached(): stale values are served while exactly one refresh runs, then it goes cold", async () => {
  await call("/api/push");
  assert.equal(calls["api.github.com"], 1);
  skew += 301e3; // past the 300 s ttl, inside the stale window
  upstreamDelay = 30;
  const res = await Promise.all(Array.from({ length: 20 }, () => call("/api/push")));
  for (const r of res) assert.equal((await r.json()).repo, "heyalex.dev", "stale value served");
  assert.equal(calls["api.github.com"], 2, "one background refresh for 20 stale requests");
  skew += 10e3;
  await call("/api/push");
  assert.equal(calls["api.github.com"], 2, "refreshed value is fresh again");
  skew += 700e3; // past ttl + stale window: a cold miss
  await Promise.all(Array.from({ length: 5 }, () => call("/api/push")));
  assert.equal(calls["api.github.com"], 3, "cold misses are coalesced too");
});

test("cached(): failures are cached briefly, /api/status falls through music to push", async () => {
  githubStatus = 403;
  assert.equal(await (await call("/api/push")).json(), null);
  await call("/api/push");
  assert.equal(calls["api.github.com"], 1, "a failed upstream answer is cached, not retried per request");
  githubStatus = 200;
  skew += 61e3; // the 60 s failure ttl has passed
  await call("/api/push");
  assert.equal(calls["api.github.com"], 2);
  const status = await (await call("/api/status")).json();
  assert.equal(status.kind, "push", "nothing playing on last.fm, a recent push wins");
  assert.equal(calls["ws.audioscrobbler.com"], 1);
});

test("every upstream fetch carries a timeout signal", async () => {
  await call("/api/status");
  await call("/api/game");
  assert.ok(calls.signals.length >= 4);
  for (const s of calls.signals) assert.ok(s instanceof AbortSignal, "fetch has an AbortSignal");
});
