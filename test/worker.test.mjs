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
    const asText = /\.(html|svg)$/.test(url), asData = /\.png$/.test(url), asJson = /\.json$/.test(url), isWorker = url.endsWith("/src/worker.js");
    if (!asText && !asData && !asJson && !isWorker) return next(url, context);
    const file = new URL(url);
    const source = isWorker ? readFileSync(file, "utf8")
      : asJson ? "export default " + readFileSync(file, "utf8")
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

// upstream stand-ins; calls are counted when made, before the (optional) delay.
// a test can answer a host itself through `upstreams[host] = url => Response`.
let calls, upstreamDelay, githubStatus, upstreams;
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  calls.signals.push(init.signal);
  const host = u.hostname;
  calls[host] = (calls[host] || 0) + 1;
  await new Promise(r => setTimeout(r, upstreamDelay));
  if (upstreams[host]) return upstreams[host](u);
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
  upstreams = {};
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

// ---- /api/sky: the waterfront's live data ----

const zoned = (ms, opts) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", ...opts }).format(new Date(ms));
// utc ms for a toronto wall-clock time, worked out independently of the worker's own helper
const torontoAt = (date, hhmm) => {
  const off = new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", timeZoneName: "longOffset" })
    .formatToParts(new Date(Date.parse(`${date}T12:00:00Z`))).find(p => p.type === "timeZoneName").value.replace("GMT", "");
  return Date.parse(`${date}T${hhmm}:00${off}`);
};

test("/api/sky: tonight's games, tower lights, island flights, snow and ice from their upstreams", async () => {
  const now = Date.now(), day = zoned(now - 4 * 3600e3), today = zoned(now), tomorrow = zoned(now + 864e5), iso = new Date(now - 3 * 3600e3).toISOString();
  upstreams["api-web.nhle.com"] = u => {
    assert.ok(u.pathname.endsWith("/week/" + day), "asks for tonight's week");
    return Response.json({ games: [
      { gameDate: day, startTimeUTC: iso, gameState: "OFF", gameScheduleState: "OK", homeTeam: { abbrev: "TOR", score: 4 }, awayTeam: { abbrev: "MTL", score: 2 } },
      { gameDate: "1999-01-01", startTimeUTC: iso, gameState: "FUT", homeTeam: { abbrev: "BOS" }, awayTeam: { abbrev: "TOR" } },
    ] });
  };
  upstreams["cdn.nba.com"] = () => Response.json({ scoreboard: { gameDate: day, games: [
    { gameStatus: 2, gameStatusText: "Q3 4:12", gameTimeUTC: iso, homeTeam: { teamTricode: "BOS", score: 80 }, awayTeam: { teamTricode: "TOR", score: 77 } },
    { gameStatus: 1, gameStatusText: "7:30 pm ET", gameTimeUTC: iso, homeTeam: { teamTricode: "LAL" }, awayTeam: { teamTricode: "GSW" } },
  ] } });
  upstreams["statsapi.mlb.com"] = u => {
    assert.equal(u.searchParams.get("date"), day);
    const g = detailedState => ({ gameDate: iso, status: { abstractGameState: "Preview", detailedState }, teams: { home: { team: { id: 141 } }, away: { team: { id: 116 } } }, weather: { condition: "Roof Closed", temp: "68" } });
    return Response.json({ dates: [{ games: [g("Scheduled"), g("Postponed")] }] });
  };
  const mon = new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", month: "short" }).format(new Date(now)), dd = +today.slice(8, 10);
  const later = new Date(now + 20 * 864e5), laterMon = new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", month: "short" }).format(later), laterDay = +zoned(later).slice(8, 10);
  const lighting = (m, d, title, name, fills) => `<article class="node node--type-lighting-event node--view-mode-teaser"><div class="date"> <span class="month">${m}</span> <span class="day">${d}</span> <span class="color-content">${name}</span></div><h3> <span class="field field--name-title field--type-string field--label-hidden">${title}</span></h3><div class="colour-bar"><svg>${fills.map(f => `<rect id="testing" fill="${f}" width="100%" height="50" x="0" y="0" />`).join("")}<rect id="grey-border" fill="#D0D2D9" width="15px" height="50" x="0" y="50" /></svg></div></article>`;
  upstreams["www.cntower.ca"] = () => new Response(`<h2>Tonight</h2>${lighting(mon, dd, "Radon Action Month", "Purple", ["#8C35DE"])}${lighting(mon, dd, "Pride &amp; Remembrance", "Red and White", ["#ff0000", "#ffffff"])}${lighting(mon, dd, "Radon Action Month", "Purple", ["#8C35DE"])}<h2>Upcoming</h2>${lighting(laterMon, laterDay, "Far away", "Blue", ["#0000ff"])}`);
  const row = (d, time, flight, place, status) => `<tr class='item ${d}' data-flightNo='${flight}'><td class='d-none d-lg-table-cell'>${d}</td><td>${time}</td><td class='d-none d-lg-table-cell'><svg class='icon porter-logo'><use xlink:href='#porter-logo'></use></svg></td><td>${flight}</td><td>${place}</td><td>${status}</td></tr>`;
  upstreams["www.billybishopairport.com"] = u => new Response(u.pathname.includes("arrivals")
    ? `<table id="flightsTable">${row("Today", "07:54", "PD2682", "Sault Ste Marie, ON", "Arrived")}${row("Today", "07:54", "TS7900", "Sault Ste Marie, ON", "Arrived")}${row("Today", "13:20", "PD2454", "Montreal-Trudeau, QC", "Cancelled")}${row("Tomorrow", "09:45", "PD2528", "Montreal-MET, QC", "On Time")}</table>`
    : `<table id="flightsTable">${row("Today", "06:45", "PD2529", "New York-Newark, NJ", "Departed")}</table>`);
  const h = k => Math.floor((now + k * 3600e3) / 1000);
  upstreams["api.open-meteo.com"] = u => {
    assert.equal(u.searchParams.get("timeformat"), "unixtime");
    return Response.json({
      hourly: { time: [h(-5), h(-4), h(-3), h(-2), h(-1), h(1)], snowfall: [0, 0.05, 0.3, 0.2, 0, 2], snow_depth: [0, 0, 0.01, 0.025, 0.03, 0.5] },
      daily: { time: [h(-72), h(-48), h(-24), h(24)], temperature_2m_mean: [-20, -30, -25, -40] },
    });
  };

  const sky = await (await call("/api/sky")).json();
  assert.deepEqual(sky.games, [
    { team: "leafs", home: true, start: Date.parse(iso), state: "final", won: true },
    { team: "raptors", home: false, start: Date.parse(iso), state: "live", won: null },
    { team: "jays", home: true, start: Date.parse(iso), state: "pre", won: null, roof: "closed" },
  ]);
  assert.deepEqual(sky.tower, { items: [
    { md: `${+today.slice(5, 7)}-${dd}`, title: "Radon Action Month", name: "Purple", colors: ["#8c35de"] },
    { md: `${+today.slice(5, 7)}-${dd}`, title: "Pride & Remembrance", name: "Red and White", colors: ["#ff0000", "#ffffff"] },
  ] }, "tonight's lightings only, entities decoded, the grey border and duplicates dropped");
  assert.deepEqual(sky.flights, {
    arr: [{ t: torontoAt(today, "07:54"), place: "Sault Ste Marie" }, { t: torontoAt(tomorrow, "09:45"), place: "Montreal" }],
    dep: [{ t: torontoAt(today, "06:45"), place: "New York" }],
  }, "codeshares folded, cancelled flights dropped, toronto times");
  assert.deepEqual(sky.lake, { firstSnow: h(-3) * 1000, snow: 3, ice: 0.5 }, "first measurable snow, depth now, ice from 75 freezing degree-days");

  // one shared fetch per source, however many requests come in
  await Promise.all(Array.from({ length: 5 }, () => call("/api/sky")));
  for (const host of ["api-web.nhle.com", "www.cntower.ca", "api.open-meteo.com"]) assert.equal(calls[host], 1, host);
  assert.equal(calls["www.billybishopairport.com"], 2, "arrivals and departures, once each");
  // the old endpoint shares the games cache and keeps its old field for pages cached before /api/sky
  const old = await (await call("/api/game")).json();
  assert.equal(old.game, "leafs");
  assert.equal(calls["api-web.nhle.com"], 1);
});

test("/api/sky: upstreams that fail or change shape leave nulls, never an error", async () => {
  upstreams["www.cntower.ca"] = () => new Response("<html>redesigned</html>");
  upstreams["www.billybishopairport.com"] = () => new Response("down", { status: 503 });
  upstreams["api.open-meteo.com"] = () => Response.json({ error: true, reason: "nope" });
  const res = await call("/api/sky");
  assert.equal(res.status, 200);
  const sky = await res.json();
  assert.deepEqual(sky.games, []);
  assert.equal(sky.tower, null);
  assert.equal(sky.flights, null);
  assert.deepEqual(sky.lake, { firstSnow: null, snow: 0, ice: 0 });
});

// ---- résumé mode, the cats' pet counter, photos, and the commit rain ----

test("/resume: résumé mode is built from the site's own data, with a csp for its one script", async () => {
  const res = await call("/resume");
  assert.equal(res.status, 200);
  const body = await res.text(), csp = res.headers.get("content-security-policy");
  const R = JSON.parse(/id="resume-data">([\s\S]*?)<\/script>/.exec(HTML)[1]);
  assert.ok(body.includes(R.name) && body.includes(R.looking) && body.includes('href="mailto:hi@heyalex.dev"'));
  for (const s of PAGES.find(p => p.id === "business").sections) assert.ok(body.includes(s.p.replace(/&/g, "&amp;")),`the ${s.h} venture is listed word for word`);
  for (const id of R.work) {
    assert.ok(PROJECTS.some(p => p.id === id), `${id} is a real project`);
    assert.ok(body.includes(`href="/work/${id}"`), `${id} is listed`);
  }
  for (const h of scriptHashes(body)) assert.ok(csp.includes(h), "csp allows the print button script");
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.equal((await call("/resume/")).status, 200);
  assert.ok((await (await call("/sitemap.xml")).text()).includes("<loc>https://heyalex.dev/resume</loc>"));
});

test("/fast: every entry is on the page with its sources, fastest first, all on one log scale", async () => {
  const F = JSON.parse(readFileSync(new URL("../src/fast.json", import.meta.url), "utf8"));
  const enc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const res = await call("/fast");
  assert.equal(res.status, 200);
  const body = await res.text(), csp = res.headers.get("content-security-policy");
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.equal(scriptHashes(body).length, 0, "the page needs no script");
  for (const e of [...F.list, ...F.mine]) {
    assert.ok(body.includes(`>${enc(e.n)}</a>`) && body.includes(`<small>${enc(e.took)}</small>`), e.n);
    for (const [, u] of e.src || []) assert.ok(body.includes(`href="${enc(u)}"`), `${e.n} links ${u}`);
  }
  for (const e of F.list) assert.ok(e.src.some(([, u]) => u.startsWith("https://")), `${e.n} has a source`);
  // within each list the bars only ever grow, and the scale runs from one character to the full width
  const lists = body.split("<ol").slice(1).map(l => [...l.split("</ol>")[0].matchAll(/--n:(\d+);--m:(\d+)/g)].map(m => [+m[1], +m[2]]));
  assert.equal(lists.length, 2);
  assert.equal(lists[0].length, F.list.length);
  for (const bars of lists) for (let i = 1; i < bars.length; i++) assert.ok(bars[i][0] >= bars[i - 1][0] && bars[i][1] >= bars[i - 1][1], "fastest first");
  const all = lists.flat();
  assert.deepEqual([Math.min(...all.map(b => b[1])), Math.max(...all.map(b => b[1]))], [1, 60]);
  assert.deepEqual([Math.min(...all.map(b => b[0])), Math.max(...all.map(b => b[0]))], [1, 32]);
  assert.match(body, /<a href="mailto:hi@heyalex\.dev\?subject=fast">/, "the ask turns into a mail link");
  assert.equal((await call("/fast/")).status, 200);
  assert.ok((await (await call("/sitemap.xml")).text()).includes("<loc>https://heyalex.dev/fast</loc>"));
  assert.ok((await (await call("/")).text()).includes('<a class="n" href="/fast">'), "linked from the home page");
});

test("/api/pets: one shared counter, one pet a second per visitor, batched into kv", async () => {
  const pet = ip => call("/api/pets", { method: "POST", headers: { "cf-connecting-ip": ip } });
  const before = (await (await call("/api/pets")).json()).count;
  const first = await pet("198.51.100.1");
  assert.equal(first.status, 200);
  assert.equal((await first.json()).count, before + 1);
  assert.equal(env.STATUS.m.get("pets"), String(before + 1), "the first pet in a while is written straight away");
  assert.equal((await pet("198.51.100.1")).status, 429, "the same visitor again within a second isn't counted");
  assert.equal((await (await pet("198.51.100.2")).json()).count, before + 2);
  assert.equal(env.STATUS.m.get("pets"), String(before + 1), "the next pets wait for the batch");
  skew += 301e3;
  assert.equal((await (await pet("198.51.100.3")).json()).count, before + 3);
  assert.equal(env.STATUS.m.get("pets"), String(before + 3), "five minutes later the batch is written");
  assert.equal((await (await call("/api/pets")).json()).count, before + 3);
});

test("photos: the manifest and uploads need the token, the manifest is cleaned, photos are served", async () => {
  const put = (body, auth) => call("/api/photos", { method: "PUT", headers: auth ? { authorization: "Bearer " + STATUS_TOKEN } : {}, body });
  assert.equal((await put("[]")).status, 401);
  assert.equal((await put(JSON.stringify([{ id: "../etc" }]), true)).status, 400, "ids are slugs");
  assert.equal((await put("{}", true)).status, 400);
  const photo = { id: "harbour-1", title: "Harbour", date: "2026-06-01", exif: "Nikon D7200 · 35 mm · f/1.8", w: 1600, h: 1067 };
  assert.equal((await put(JSON.stringify([{ ...photo, gps: "43.64,-79.38", note: "x" }]), true)).status, 200);
  assert.deepEqual(JSON.parse(env.STATUS.m.get("photos")), [photo], "anything else, like gps, is dropped");
  assert.deepEqual(await (await call("/api/photos")).json(), [photo]);
  const fakeReq = (name, readBody) => ({ url: `https://heyalex.dev/api/asset/${name}`, method: "PUT", headers: new Headers({ authorization: "Bearer " + STATUS_TOKEN }), arrayBuffer: readBody });
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  assert.equal((await worker.fetch(fakeReq("photo-harbour-1.jpg", async () => jpg.buffer), env, { waitUntil() {} })).status, 200);
  assert.equal((await worker.fetch(fakeReq("photo-../x.jpg", async () => jpg.buffer), env, { waitUntil() {} })).status, 400);
  const got = await call("/photo/harbour-1.jpg");
  assert.equal(got.headers.get("content-type"), "image/jpeg");
  assert.deepEqual([...new Uint8Array(await got.arrayBuffer())], [...jpg]);
  assert.equal((await call("/photo/nope.jpg")).status, 404);
});

test("/api/sky github: repos pushed to this month and the subject lines of their commits", async () => {
  const day = 864e5, at = ms => new Date(Date.now() - ms).toISOString();
  upstreams["api.github.com"] = u => {
    if (u.pathname === "/users/u/events/public") return Response.json([
      { type: "PushEvent", created_at: at(3600e3), repo: { name: "u/kept" } },
      { type: "WatchEvent", created_at: at(3600e3), repo: { name: "u/starred" } },
      { type: "PushEvent", created_at: at(2 * day), repo: { name: "u/heyalex.dev" } },
      { type: "PushEvent", created_at: at(3 * day), repo: { name: "u/kept" } },
      { type: "PushEvent", created_at: at(40 * day), repo: { name: "u/old" } },
    ]);
    assert.equal(u.searchParams.get("author"), "u");
    if (u.pathname === "/repos/u/kept/commits") return Response.json([{ commit: { message: "Ship the menu bar app\n\nlong body" } }, { commit: { message: "Fix sync" } }]);
    return new Response("nope", { status: 500 });
  };
  const sky = await (await call("/api/sky")).json();
  assert.deepEqual(sky.github, { repos: ["kept", "heyalex.dev"], messages: ["Ship the menu bar app", "Fix sync"] }, "newest first, pushes only, last 30 days, a failing repo is skipped");
});

test("school: the home page and résumé show education once resume-data has it, and not before", async () => {
  const R = JSON.parse(/id="resume-data">([\s\S]*?)<\/script>/.exec(HTML)[1]);
  const home = await (await call("/")).text(), resume = await (await call("/resume")).text();
  const e = R.education, html = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  if (e && (e.where || e.level)) {
    const name = [e.level, e.where].filter(Boolean).join(", ");
    assert.ok(home.includes('<section id="school">') && !home.includes('<section id="school" hidden'), "the school section is shown");
    assert.ok(home.includes(html(name)) && resume.includes("<h2>Education</h2>") && resume.includes(html(name)));
    for (const [k, v] of e.items || []) assert.ok(home.includes(html(k)) && home.includes(html(v)) && resume.includes(html(k)), k);
    const page = await (await call(`/work/${PROJECTS[0].id}`)).text();
    assert.ok(page.includes('<section id="school" hidden>'), "project pages still hide it");
  } else {
    assert.ok(home.includes('<section id="school" hidden data-off>'), "the placeholder stays hidden");
    assert.ok(!resume.includes("<h2>Education</h2>"));
  }
});
