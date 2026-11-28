// heyalex.dev: one worker serves the page, the live status api, and the link-preview media.
import HTML from "./index.html";
import FAST from "./fast.json";
import FAVICON_SVG from "./icons/favicon.svg";
import FAVICON_32 from "./icons/favicon-32.png";
import TOUCH_ICON from "./icons/apple-touch-icon.png";

// every inline script on a page is allowed by its hash, so editing index.html never needs a manual csp update
async function cspFor(html) {
  const hashes = await Promise.all([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(async ([, script]) => {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
    return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(d)))}'`;
  }));
  return [
    "default-src 'none'",
    `script-src ${hashes.join(" ")} https://static.cloudflareinsights.com`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' https://api.open-meteo.com https://cloudflareinsights.com",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}
let CSP_PROMISE, OG_CSP_PROMISE;
const csp = () => (CSP_PROMISE ||= cspFor(HTML));
const ogCsp = () => (OG_CSP_PROMISE ||= cspFor(OG_HTML));

const SEC = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "cross-origin-opener-policy": "same-origin",
};
const UA = { "user-agent": "heyalex.dev (+https://heyalex.dev)" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });

async function same(a, b) {
  const e = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", e.encode(a)), crypto.subtle.digest("SHA-256", e.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}
const authed = async (req, env) => !!env.STATUS_TOKEN && same(req.headers.get("authorization") || "", "Bearer " + env.STATUS_TOKEN);
// media uploads also accept a short-lived token written straight into kv (key "uploadtoken", ttl ≤ 1h),
// so a scheduled re-record never needs the long-lived STATUS_TOKEN
const authedUpload = async (req, env) => {
  if (await authed(req, env)) return true;
  const t = await env.STATUS.get("uploadtoken");
  return !!t && t.length >= 32 && same(req.headers.get("authorization") || "", "Bearer " + t);
};

// upstreams are refreshed about once per ttl per edge location, however much traffic the site gets:
// a fresh value comes straight from the cache, a stale one is served while one background refresh runs,
// and requests that miss at the same time share a single in-flight upstream call instead of each making one.
// stale values are kept for one extra ttl, so steady traffic never falls back to a cold miss.
const inflight = new Map();
async function cached(ctx, key, ttl, fn) {
  const cache = caches.default, req = new Request("https://cache.heyalex.dev/v2/" + key);
  const hit = await cache.match(req);
  if (hit) {
    const { v, exp } = await hit.json();
    if (Date.now() >= exp) ctx.waitUntil(refresh(ctx, cache, req, key, ttl, fn));
    return v;
  }
  return refresh(ctx, cache, req, key, ttl, fn);
}
function refresh(ctx, cache, req, key, ttl, fn) {
  let p = inflight.get(key);
  if (!p) {
    p = (async () => { try { return await fn(); } catch (e) { return null; } })();
    inflight.set(key, p);
    // keep the entry until the new value is stored, so nothing slips in between the fetch and the put
    ctx.waitUntil(p.then(v => {
      const fresh = v === null ? Math.min(ttl, 60) : ttl;
      return cache.put(req, new Response(JSON.stringify({ v, exp: Date.now() + fresh * 1000 }), { headers: { "cache-control": `max-age=${fresh + ttl}` } }));
    }).catch(() => {}).finally(() => inflight.delete(key)));
  }
  return p;
}
// writes a known-new value into this location's cache, so whoever just changed it sees it at once
// (other locations catch up within their ttl)
function prime(ctx, key, ttl, v) {
  const req = new Request("https://cache.heyalex.dev/v2/" + key);
  ctx.waitUntil(caches.default.put(req, new Response(JSON.stringify({ v, exp: Date.now() + ttl * 1000 }), { headers: { "cache-control": `max-age=${2 * ttl}` } })).catch(() => {}));
}
// a slow upstream must not hold requests (or the shared refresh) open
const UPSTREAM_TIMEOUT = 5000;

async function lastfm(env) {
  const q = new URLSearchParams({ method: "user.getrecenttracks", user: env.LASTFM_USER, api_key: env.LASTFM_KEY, format: "json", limit: "1" });
  const r = await fetch("https://ws.audioscrobbler.com/2.0/?" + q, { headers: UA, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT) });
  if (!r.ok) return null;
  const t = (await r.json())?.recenttracks?.track?.[0];
  if (!t || t["@attr"]?.nowplaying !== "true") return null;
  return { kind: "music", track: String(t.name).slice(0, 120), artist: String(t.artist?.["#text"] ?? "").slice(0, 120) };
}

async function lastPush(env) {
  const r = await fetch(`https://api.github.com/users/${env.GH_USER}/events/public?per_page=30`, { headers: { ...UA, accept: "application/vnd.github+json", ...(env.GH_TOKEN ? { authorization: "Bearer " + env.GH_TOKEN } : {}) }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT) });
  if (!r.ok) return null;
  const e = (await r.json()).find(x => x.type === "PushEvent");
  return e ? { repo: e.repo.name.split("/")[1], at: Date.parse(e.created_at) } : null;
}

// ---- the waterfront's live data: game nights, cn tower lights, island flights, snow and harbour ice ----

const TZ = "America/Toronto";
const torontoDate = ms => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(ms));
// utc ms for a toronto wall-clock time: read a utc guess back in toronto and shift by the difference
function torontoMs(date, hh = 0, mm = 0) {
  const guess = Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(guess)).map(x => [x.type, x.value]));
  return 2 * guess - Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
}
const upstream = async (url, headers = UA) => {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT) });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r;
};
const getJSON = async (url, headers) => (await upstream(url, headers)).json();
const getText = async url => (await upstream(url)).text();
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ndash: "–", mdash: "—" };
const decode = s => String(s).replace(/<[^>]+>/g, "")
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] !== "#" ? ENT[e.toLowerCase()] ?? m : String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : +e.slice(1)))
  .replace(/\s+/g, " ").trim();

// tonight's leafs, raptors and jays games: when, home or away, live state, and the result once it's final.
// a game night runs until 4 am so a late final still counts. the jays' roof comes from mlb's game weather
// ("Roof Closed") once it's posted; until then the page guesses from the weather.
async function games(now = Date.now()) {
  const day = torontoDate(now - 4 * 3600e3), out = [];
  const [nhl, nba, mlb] = await Promise.allSettled([
    getJSON(`https://api-web.nhle.com/v1/club-schedule/TOR/week/${day}`),
    getJSON("https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json"),
    getJSON(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=141&date=${day}&hydrate=weather`),
  ]);
  const result = (state, us, them) => state === "final" && us != null && them != null ? us > them : null;
  if (nhl.status === "fulfilled") for (const g of nhl.value?.games || []) {
    if (g.gameDate !== day || (g.gameScheduleState && g.gameScheduleState !== "OK")) continue;
    const home = g.homeTeam?.abbrev === "TOR", state = /^(FINAL|OFF)$/.test(g.gameState) ? "final" : /^(LIVE|CRIT)$/.test(g.gameState) ? "live" : "pre";
    const [us, them] = home ? [g.homeTeam?.score, g.awayTeam?.score] : [g.awayTeam?.score, g.homeTeam?.score];
    out.push({ team: "leafs", home, start: Date.parse(g.startTimeUTC) || null, state, won: result(state, us, them) });
  }
  const sb = nba.status === "fulfilled" ? nba.value?.scoreboard : null;
  if (sb?.gameDate === day) for (const g of sb.games || []) {
    const home = g.homeTeam?.teamTricode === "TOR";
    if ((!home && g.awayTeam?.teamTricode !== "TOR") || /ppd|postp|cancel/i.test(g.gameStatusText || "")) continue;
    const state = g.gameStatus === 3 ? "final" : g.gameStatus === 2 ? "live" : "pre";
    const [us, them] = home ? [g.homeTeam?.score, g.awayTeam?.score] : [g.awayTeam?.score, g.homeTeam?.score];
    out.push({ team: "raptors", home, start: Date.parse(g.gameTimeUTC) || null, state, won: result(state, us, them) });
  }
  if (mlb.status === "fulfilled") for (const d of mlb.value?.dates || []) for (const g of d.games || []) {
    if (/postponed|cancel|suspended/i.test(g.status?.detailedState || "")) continue;
    const home = g.teams?.home?.team?.id === 141, ab = g.status?.abstractGameState;
    const state = ab === "Final" ? "final" : ab === "Live" ? "live" : "pre", cond = String(g.weather?.condition || "");
    out.push({ team: "jays", home, start: Date.parse(g.gameDate) || null, state,
      won: state === "final" ? !!(home ? g.teams.home : g.teams.away)?.isWinner : null,
      roof: home && cond ? (/roof closed|dome/i.test(cond) ? "closed" : "open") : null });
  }
  // `game` keeps the old shape for pages cached before /api/sky existed
  const first = out.find(g => g.team !== "jays");
  return { game: first ? first.team : null, games: out };
}

// the cn tower's lighting schedule page lists previous, tonight's and upcoming lightings. items carry the
// night they belong to ("11-25"); the page shows tonight's (a night lasts until 6 am) and rotates through them.
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Sept: 9, Oct: 10, Nov: 11, Dec: 12 };
async function towerLights(now = Date.now()) {
  const h = await getText("https://www.cntower.ca/lighting-schedule");
  const near = new Set([-1, 0, 1, 2].map(k => { const d = torontoDate(now + k * 864e5); return `${+d.slice(5, 7)}-${+d.slice(8, 10)}`; }));
  const items = [], seen = new Set();
  for (const [art] of h.matchAll(/<article[^>]*node--type-lighting-event[\s\S]*?<\/article>/g)) {
    const mon = MONTHS[/class="month">\s*([A-Za-z]+)/.exec(art)?.[1]], day = +(/class="day">\s*(\d+)/.exec(art)?.[1]);
    const md = `${mon}-${day}`, title = decode(/field--name-title[^>]*>([\s\S]*?)<\/span>/.exec(art)?.[1] || "");
    const colors = [...art.matchAll(/<rect(?![^>]*grey-border)[^>]*fill="(#(?:[0-9a-f]{6}|[0-9a-f]{3}))"/gi)].map(m => m[1].toLowerCase());
    if (!mon || !day || !near.has(md) || !colors.length || seen.has(md + title)) continue;
    seen.add(md + title);
    items.push({ md, title: title.slice(0, 120), name: decode(/class="color-content">([\s\S]*?)<\/span>/.exec(art)?.[1] || "").slice(0, 60), colors: colors.slice(0, 6) });
  }
  return items.length ? { items } : null;
}

// billy bishop's arrivals and departures boards (today and tomorrow) as utc ms. the same flight sold under
// porter and air transat numbers is folded into one; cancelled flights are dropped.
async function ytzFlights(now = Date.now()) {
  const [arr, dep] = await Promise.all(["arrivals", "departures"].map(k => getText(`https://www.billybishopairport.com/flights/${k}/`)));
  const days = { Today: torontoDate(now), Tomorrow: torontoDate(now + 864e5) };
  const board = html => {
    const out = [], seen = new Set();
    for (const [, day, row] of html.matchAll(/<tr class=['"]item (Today|Tomorrow)['"][^>]*>([\s\S]*?)<\/tr>/g)) {
      // cells: day, time, airline logo, flight, city, status
      const td = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => decode(m[1]));
      // "Montreal-Trudeau, QC" -> "Montreal", "New York-Newark, NJ" -> "New York"
      const tm = /^(\d{1,2}):(\d{2})$/.exec(td[1] || ""), place = (td[4] || "").replace(/,\s*[A-Z]{2}$/, "").replace(/\s*-.*$/, "").slice(0, 40);
      if (!tm || !place || /cancel/i.test(td[5] || "") || seen.has(day + td[1] + place)) continue;
      seen.add(day + td[1] + place);
      out.push({ t: torontoMs(days[day], +tm[1], +tm[2]), place });
    }
    return out.sort((a, b) => a.t - b.t);
  };
  return { arr: board(arr), dep: board(dep) };
}

// the commit rain and the repo fish: public repos pushed to in the last 30 days (newest first) and the
// subject lines of my recent commits in the top three. github's events feed stopped carrying commit
// messages, so those come from each repo's commit list. only public repos ever show up here.
async function github(env) {
  const headers = { ...UA, accept: "application/vnd.github+json", ...(env.GH_TOKEN ? { authorization: "Bearer " + env.GH_TOKEN } : {}) };
  const since = Date.now() - 30 * 864e5, repos = [];
  for (const e of await getJSON(`https://api.github.com/users/${env.GH_USER}/events/public?per_page=100`, headers))
    if (e.type === "PushEvent" && Date.parse(e.created_at) >= since && !repos.includes(e.repo?.name)) repos.push(e.repo.name);
  const lists = await Promise.allSettled(repos.slice(0, 3).map(r =>
    getJSON(`https://api.github.com/repos/${r}/commits?per_page=12&author=${encodeURIComponent(env.GH_USER)}&since=${new Date(since).toISOString()}`, headers)));
  const messages = [];
  for (const l of lists) if (l.status === "fulfilled" && Array.isArray(l.value))
    for (const c of l.value) { const m = String(c?.commit?.message || "").split("\n")[0].trim(); if (m) messages.push(m.slice(0, 80)); }
  return { repos: repos.slice(0, 8).map(r => r.split("/")[1]), messages: messages.slice(0, 36) };
}

// snow and harbour ice from open-meteo's last 92 days over the waterfront. firstSnow is the first hour this
// winter (since sept 1) with measurable snowfall, snow is the depth on the ground now in cm, and ice (0..1)
// grows with freezing degree-days and melts twice as fast on mild days. a winter whose first snow fell more
// than 92 days ago reads as its earliest snow in the window, which is fine: the page only cares about today.
async function lake(now = Date.now()) {
  const j = await getJSON("https://api.open-meteo.com/v1/forecast?latitude=43.64&longitude=-79.38&hourly=snowfall,snow_depth&daily=temperature_2m_mean&past_days=92&forecast_days=1&timezone=America%2FToronto&timeformat=unixtime");
  const d = torontoDate(now), y = +d.slice(0, 4), winter = torontoMs(`${+d.slice(5, 7) >= 9 ? y : y - 1}-09-01`);
  const ht = j?.hourly?.time || [], sf = j?.hourly?.snowfall || [], sd = j?.hourly?.snow_depth || [];
  let firstSnow = null, depth = 0, fdd = 0;
  for (let i = 0; i < ht.length && ht[i] * 1000 <= now; i++) {
    if (firstSnow === null && ht[i] * 1000 >= winter && sf[i] >= 0.1) firstSnow = ht[i] * 1000;
    if (typeof sd[i] === "number") depth = sd[i];
  }
  const dt = j?.daily?.time || [], mean = j?.daily?.temperature_2m_mean || [];
  for (let i = 0; i < dt.length && dt[i] * 1000 <= now; i++) if (typeof mean[i] === "number") fdd = Math.max(0, fdd - (mean[i] < 0 ? mean[i] : 2 * mean[i]));
  return { firstSnow, snow: Math.round(depth * 1000) / 10, ice: Math.round(Math.min(1, Math.max(0, (fdd - 25) / 100)) * 100) / 100 };
}

// sun altitude over toronto -> which pre-rendered preview to serve
function sunAlt(ms) {
  const B = Math.PI / 180, d = ms / 864e5 + 2440587.5 - 2451545;
  const g = (357.529 + .98560028 * d) * B, q = (280.459 + .98564736 * d + 1.915 * Math.sin(g) + .02 * Math.sin(2 * g)) * B;
  const e = (23.439 - 36e-8 * d) * B, ra = Math.atan2(Math.cos(e) * Math.sin(q), Math.cos(q)), dec = Math.asin(Math.sin(e) * Math.sin(q));
  const gm = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24, ha = (gm * 15 - 79.3832) * B - ra, lat = 43.6532 * B;
  return Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha)) / B;
}
function skyPhase(ms) {
  const a = sunAlt(ms), rising = sunAlt(ms + 6e5) > a;
  if (a > 14) return "noon";
  if (a > -1) return rising ? "rise" : "set";
  if (a > -10) return rising ? "rise" : "dusk";
  return "night";
}

// project data lives once, as json inside index.html. the server renders it into the html so search engines
// (and anyone without js) get the full text; the page's own script then takes over.
const PDATA = JSON.parse(HTML.match(/<script type="application\/json" id="projects-data">([\s\S]*?)<\/script>/)[1]);
const PROJECTS = PDATA.map(p => ({ id: p.id, name: p.n, desc: p.d }));
const esc = v => String(v).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const LIST = PDATA.map(p => `<li data-id="${esc(p.id)}"><div class="row"><a class="n" href="/work/${esc(p.id)}">${esc(p.n)}</a><span class="lead"></span><span class="y">${esc(p.y)}</span></div><p class="desc">${esc(p.d)}</p></li>`).join("");
const detailBody = p => `<h2>What it is</h2><p>${esc(p.what)}</p>${p.built ? `<p class="dim">Built at the ${esc(p.built)}.</p>` : ""}` +
  (p.how ? `<h2>How it works</h2><ol>${p.how.map(r => `<li>${esc(r)}</li>`).join("")}</ol>` : "") +
  (p.broke ? `<h2>What broke</h2><p>${esc(p.broke)}</p>` : "") +
  (p.next ? `<h2>What's next</h2><p>${esc(p.next)}</p>` : "") +
  (p.links && p.links.length ? `<h2>Links</h2><p>${p.links.map(l => `<a href="${esc(l[1])}">${esc(l[0])} ↗</a>`).join(" · ")}</p>` : "");
const PGDATA = JSON.parse(HTML.match(/<script type="application\/json" id="pages-data">([\s\S]*?)<\/script>/)[1]);
const RDATA = JSON.parse(HTML.match(/<script type="application\/json" id="resume-data">([\s\S]*?)<\/script>/)[1]);
// school: the home page's School section and the résumé's Education part both come from resume-data's
// "education" block. until it has one, the home page keeps its hidden placeholder.
const EDU = RDATA.education && (RDATA.education.level || RDATA.education.where) ? RDATA.education : null;
const eduName = e => [e.level, e.where].filter(Boolean).join(", ");
const eduLine = e => esc(eduName(e)) + (e.years ? ` · ${esc(e.years)}` : "");
const SCHOOL = EDU && `<section id="school">\n<h2>School</h2>\n<p>${eduLine(EDU)}</p>\n` +
  (EDU.items && EDU.items.length ? `<dl class="pairs" style="margin-top:14px">${EDU.items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>\n` : "") + `</section>`;
// replacements are functions so a "$&", "$`" or "$'" in the data can never splice other parts of the page in
const HOME = HTML.replace('<ul class="list" id="proj"></ul>', () => `<ul class="list" id="proj">${LIST}</ul>`)
  .replace('<ul class="list" id="pages"></ul>', () => `<ul class="list" id="pages">${PGLIST()}<li><div class="row"><a class="n" href="/fast">Fast</a><span class="lead"></span><span class="y">Toronto</span></div><p class="desc">Things people in Toronto and the rest of Canada did fast, with a bar for how long each one took.</p></li></ul>`)
  .replace(/<section id="school" hidden data-off>[\s\S]*?<\/section>/, m => SCHOOL || m);
// llms.txt (llmstxt.org): the site in plain markdown for language models, built from the same data blocks as the
// résumé so it never drifts. school stays out on purpose.
const LLMS = (() => {
  const r = RDATA, site = "https://heyalex.dev";
  const work = PDATA.map(p => `- [${p.n}](${site}/work/${p.id}): ${p.d} (${p.y}; ${p.stack})` +
    (p.links && p.links.length ? ` Links: ${p.links.map(l => `[${l[0]}](${l[1]})`).join(", ")}.` : ""));
  return [
    `# ${r.name}`, "",
    `> ${r.role}. Based in ${r.place}. ${r.looking}.`, "",
    r.summary, "",
    ...r.facts.map(([k, v]) => `- ${k}: ${v}`), "",
    "## Work", "", ...work, "",
    "## Pages", "",
    `- [Résumé](${site}/resume): one printable page for people hiring`,
    ...PGDATA.map(g => `- [${g.n}](${site}/${g.id}): ${g.d}`),
    `- [Fast](${site}/fast): things people in Toronto and the rest of Canada did fast`, "",
    "## Contact", "",
    ...r.links.map(([k, href, label]) => `- ${k}: [${label}](${href})`), "",
    "## Optional", "",
    `- [ascii-glaze](https://github.com/thegreatalxx/heyalex.dev/tree/main/packages/ascii-glaze): the MIT library that draws the site's ASCII skyline`,
    "",
  ].join("\n");
})();
function PGLIST() { return PGDATA.map(p => `<li><div class="row"><a class="n" href="/${esc(p.id)}" data-page>${esc(p.n)}</a><span class="lead"></span><span class="y">${esc(p.tag)}</span></div><p class="desc">${esc(p.d)}</p></li>`).join(""); }
function projectHTML(pr) {
  const p = PDATA.find(x => x.id === pr.id), url = "https://heyalex.dev/work/" + pr.id, title = `${pr.name} · Alexander Wondwossen`;
  let h = HOME
    .replace(/<title>[^<]*<\/title>/, () => `<title>${esc(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${esc(pr.desc)}">`)
    .replace(/<link rel="canonical" href="[^"]*">/, () => `<link rel="canonical" href="${url}">`)
    .replace(/<meta property="og:url" content="[^"]*">/, () => `<meta property="og:url" content="${url}">`)
    .replace(/<meta property="og:title" content="[^"]*">/, () => `<meta property="og:title" content="${esc(title)}">`)
    .replace(/<meta property="og:description" content="[^"]*">/, () => `<meta property="og:description" content="${esc(pr.desc)}">`);
  // show the project, hide the rest of main (same as the client router does)
  const a = h.indexOf("<main>"), b = h.indexOf("</main>");
  let main = h.slice(a, b).replace(/<section(?![^>]*id="detail")([^>]*?)( hidden)?>/g, "<section$1 hidden>");
  main = main.replace('<section id="detail" hidden>', '<section id="detail">')
    .replace('<h1 id="dtitle"></h1>', () => `<h1 id="dtitle">${esc(p.n)}</h1>`)
    .replace('<p class="sub" id="dsub"></p>', () => `<p class="sub" id="dsub">${esc(p.y)} · ${esc(p.stack)}</p>`)
    .replace('<div id="dbody"></div>', () => `<div id="dbody">${detailBody(p)}</div>`);
  return h.slice(0, a) + main + h.slice(b);
}

// standalone pages (business) live as json in index.html too. same shell as project pages;
// the client router animates their ascii scene in #dprev.
const pageBody = p => p.sections.map(r => `<h2>${esc(r.h)}</h2><p>${esc(r.p)}</p>` + (r.links ? `<p>${r.links.map(l => `<a href="${esc(l[1])}">${esc(l[0])} →</a>`).join(" · ")}</p>` : "")).join("");
function pageHTML(pg) {
  const url = "https://heyalex.dev/" + pg.id, title = `${pg.n} · Alexander Wondwossen`;
  let h = HOME
    .replace(/<title>[^<]*<\/title>/, () => `<title>${esc(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${esc(pg.desc)}">`)
    .replace(/<link rel="canonical" href="[^"]*">/, () => `<link rel="canonical" href="${url}">`)
    .replace(/<meta property="og:url" content="[^"]*">/, () => `<meta property="og:url" content="${url}">`)
    .replace(/<meta property="og:title" content="[^"]*">/, () => `<meta property="og:title" content="${esc(title)}">`)
    .replace(/<meta property="og:description" content="[^"]*">/, () => `<meta property="og:description" content="${esc(pg.desc)}">`);
  const a = h.indexOf("<main>"), b = h.indexOf("</main>");
  let main = h.slice(a, b).replace(/<section(?![^>]*id="detail")([^>]*?)( hidden)?>/g, "<section$1 hidden>");
  main = main.replace('<section id="detail" hidden>', '<section id="detail">')
    .replace('<a class="back" href="/#work">← All work</a>', '<a class="back" href="/#more">← Home</a>')
    .replace('<h1 id="dtitle"></h1>', () => `<h1 id="dtitle">${esc(pg.n)}</h1>`)
    .replace('<p class="sub" id="dsub"></p>', () => `<p class="sub" id="dsub">${esc(pg.sub)}</p>`)
    .replace('<div id="dbody"></div>', () => `<div id="dbody">${pageBody(pg)}</div>`);
  return h.slice(0, a) + main + h.slice(b);
}

// résumé mode: one fast page for people hiring, built from the same data as the site (the resume-data block
// and the project list in index.html), so it never drifts from what the home page says
const RESUME_CSS = ':root{--bg:#07080e;--fg:#ecebe6;--dim:#8a8a96;--line:#22232c;--accent:#7dff9a;color-scheme:dark}*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--fg);font:14px/1.7 "JetBrains Mono",ui-monospace,"SF Mono",Menlo,monospace}main{max-width:720px;margin:0 auto;padding:56px 20px 64px}h1{font-size:22px;font-weight:500;margin:0}h2{font-size:14px;font-weight:500;margin:36px 0 10px}h2:before{content:"## ";color:var(--dim)}h3{font-size:14px;font-weight:500;margin:0;display:flex;gap:10px;align-items:baseline}h3 span{flex:1;border-bottom:1px dotted var(--line);transform:translateY(-4px)}h3 small{color:var(--dim);font-size:14px}p{margin:0}.dim,.role{color:var(--dim)}.open{margin-top:14px;display:inline-flex;gap:10px;align-items:center;border:1px solid var(--line);padding:4px 10px}.dot{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px var(--accent)}.lead{margin-top:18px;max-width:62ch}dl{display:grid;grid-template-columns:12ch minmax(0,1fr);gap:4px 16px;margin:24px 0 0}dt{color:var(--dim)}dd{margin:0}article{padding:10px 0;border-bottom:1px dashed var(--line)}article p{margin-top:2px}a{color:inherit;text-decoration:none;border-bottom:1px solid #3a3b48}a:hover{border-color:var(--fg)}:focus-visible{outline:1px solid var(--fg);outline-offset:3px}footer{margin-top:40px;display:flex;gap:18px;flex-wrap:wrap;align-items:center;color:var(--dim)}button{font:inherit;color:var(--dim);background:none;border:1px solid #3a3b48;padding:4px 10px;cursor:pointer}button:hover{color:var(--fg);border-color:var(--fg)}@media (max-width:560px){dl{grid-template-columns:minmax(0,1fr)}dt{margin-top:8px}}@media print{:root{--bg:#fff;--fg:#000;--dim:#444;--line:#bbb;--accent:#0a0}body{font-size:11px}main{padding:0}footer{display:none}a{border:0}.open{border-color:#bbb}}';
function resumeHTML() {
  const r = RDATA, work = r.work.map(id => PDATA.find(p => p.id === id)).filter(Boolean);
  // the ventures from the business page, word for word
  const biz = PGDATA.find(g => g.id === "business");
  const also = biz ? `<h2>Also running</h2>${biz.sections.map(s => `<article><h3>${s.links && s.links[0] ? `<a href="${esc(s.links[0][1])}">${esc(s.h)}</a>` : esc(s.h)}</h3><p>${esc(s.p)}</p></article>`).join("")}` : "";
  const edu = EDU ? `<h2>Education</h2><article><h3>${esc(eduName(EDU))}<span></span><small>${esc(EDU.years || "")}</small></h3>${(EDU.items || []).map(([k, v]) => `<p class="dim">${esc(k)}: ${esc(v)}</p>`).join("")}</article>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Résumé · ${esc(r.name)}</title><meta name="description" content="${esc(r.summary)}"><link rel="canonical" href="https://heyalex.dev/resume"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap"><style>${RESUME_CSS}</style></head><body><main>` +
    `<h1>${esc(r.name)}</h1><p class="role">${esc(r.role)} · ${esc(r.place)}</p><p class="open"><span class="dot" aria-hidden="true"></span>${esc(r.looking)}</p>` +
    `<p class="lead">${esc(r.summary)}</p>` +
    `<dl>${r.facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}${r.links.map(([k, href, label]) => `<dt>${esc(k)}</dt><dd><a href="${esc(href)}">${esc(label)}</a></dd>`).join("")}</dl>` +
    edu +
    `<h2>Selected work</h2>${work.map(p => `<article><h3><a href="/work/${esc(p.id)}">${esc(p.n)}</a><span></span><small>${esc(p.y)}</small></h3><p>${esc(p.d)}</p><p class="dim">${esc(p.stack)}${p.built ? ` · Built at the ${esc(p.built)}` : ""}</p></article>`).join("")}` +
    also +
    `<footer><a href="/">← The waterfront</a><button type="button" id="print">Save as PDF</button><span>${esc(r.replies)}</span></footer>` +
    `</main><script>document.getElementById("print").addEventListener("click",()=>print())</script></body></html>`;
}
const RESUME_HTML = resumeHTML();
let RESUME_CSP_PROMISE;

// /fast: things people in toronto and the rest of canada did fast, fastest first (after patrickcollison.com/fast).
// the entries live in fast.json. each "took" is written in plain words ("5½ months", "4 years 7 months"), and the
// bar under it is drawn from that on one log scale for the whole page, so any two bars can be compared.
const UNITS = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2629800, year: 31557600 };
function took(s) {
  const parts = [...String(s).matchAll(/(\d+(?:\.\d+)?)?(½)?\s*(second|minute|hour|day|week|month|year)s?\b/g)].filter(m => m[1] || m[2]);
  if (!parts.length) throw new Error(`fast.json: "${s}" isn't a length of time like "6 days" or "4 years 7 months"`);
  return parts.reduce((t, [, n, half, u]) => t + ((n ? parseFloat(n) : 0) + (half ? 0.5 : 0)) * UNITS[u], 0);
}
// [text](url) in fast.json becomes a link; everything else is escaped
const inline = s => esc(s || "").replace(/\[([^\]]+)\]\(((?:https:\/\/|mailto:|\/)[^)\s]*)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);
const slug = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const FAST_SECS = new Map([...FAST.list, ...(FAST.mine || [])].map(e => [e, took(e.took)]));
const FAST_BY_TIME = [...FAST_SECS].sort((a, b) => a[1] - b[1]);
const FAST_LO = Math.log(FAST_BY_TIME[0][1]), FAST_HI = Math.log(FAST_BY_TIME.at(-1)[1]);
// how many characters of a `w`-wide bar an entry fills: the fastest thing on the page gets one, the slowest all of them
const barFill = (s, w) => 1 + Math.round((w - 1) * (Math.log(s) - FAST_LO) / (FAST_HI - FAST_LO || 1));
const sources = src => src && src.length ? `<p class="src">${src.length > 1 ? "Sources" : "Source"}: ${src.map(([t, u]) => `<a href="${esc(u)}">${esc(t)}</a>`).join(", ")}</p>` : "";
// bars are 32 characters on phones and 60 on wider screens; the track is drawn in dots and the fill laid over it
const fastList = (list, cls) => `<ol${cls ? ` class="${cls}"` : ""}>` + list.map((e, i) => [e, i])
  .sort(([a, i], [b, j]) => FAST_SECS.get(a) - FAST_SECS.get(b) || i - j)
  .map(([e]) => {
    const id = slug(e.n), s = FAST_SECS.get(e);
    return `<li id="${id}"><h3><a href="#${id}">${esc(e.n)}</a><span></span><small>${esc(e.took)}</small></h3>` +
      `<p class="bar" aria-hidden="true">${"·".repeat(60)}<b style="--n:${barFill(s, 32)};--m:${barFill(s, 60)}">${"=".repeat(60)}</b></p>` +
      `<p>${inline(e.p)}</p>${sources(e.src)}</li>`;
  }).join("") + "</ol>";
const FAST_CSS = ':root{--bg:#07080e;--fg:#ecebe6;--dim:#8a8a96;--line:#22232c;--bar:#7dff9a;--mine:#ffd060;color-scheme:dark}*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--fg);font:14px/1.7 "JetBrains Mono",ui-monospace,"SF Mono",Menlo,monospace}main{max-width:720px;margin:0 auto;padding:56px 20px 64px}h1{font-size:22px;font-weight:500;margin:0}h2{font-size:14px;font-weight:500;margin:52px 0 4px}h2:before{content:"## ";color:var(--dim)}p{margin:0}.lead{margin-top:14px;max-width:62ch}.dim{color:var(--dim)}.key{margin-top:8px}ol{list-style:none;margin:24px 0 0;padding:0;border-top:1px dashed var(--line)}li{padding:18px 0 16px;border-bottom:1px dashed var(--line);scroll-margin-top:24px}h3{font-size:14px;font-weight:500;margin:0;display:flex;gap:10px;align-items:baseline}h3 span{flex:1;border-bottom:1px dotted var(--line);transform:translateY(-4px)}h3 small{color:var(--dim);font-size:14px;white-space:nowrap}h3 a{border:0}h3 a:hover,li:target h3 a{color:var(--bar)}.bar{position:relative;width:32ch;overflow:hidden;white-space:pre;margin:2px 0 8px;line-height:1.4;color:#2c2f3d;user-select:none}.bar b{position:absolute;left:0;top:0;width:calc(var(--n)*1ch);overflow:hidden;font-weight:400;color:var(--bar);background:var(--bg)}.mine .bar b{color:var(--mine)}.mine li:target h3 a,.mine h3 a:hover{color:var(--mine)}.src{margin-top:6px;color:var(--dim)}.after{margin-top:28px;max-width:66ch}.ask{margin-top:36px}a{color:inherit;text-decoration:none;border-bottom:1px solid #3a3b48}a:hover{border-color:var(--fg)}:focus-visible{outline:1px solid var(--fg);outline-offset:3px}footer{margin-top:40px;display:flex;gap:18px;flex-wrap:wrap;color:var(--dim)}@keyframes grow{from{width:0}}@media (min-width:640px){.bar{width:60ch}.bar b{width:calc(var(--m)*1ch)}}@media (prefers-reduced-motion:no-preference){@supports (animation-timeline:view()){.bar b{animation:grow linear both;animation-timing-function:steps(var(--n),end);animation-timeline:view();animation-range:entry 10% cover 35%}@media (min-width:640px){.bar b{animation-timing-function:steps(var(--m),end)}}}}@media print{:root{--bg:#fff;--fg:#000;--dim:#444;--line:#bbb;--bar:#000;--mine:#000}body{font-size:11px}main{padding:0}footer{display:none}a{border:0}.bar{color:#ccc}}';
const FAST_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>fast · ${esc(RDATA.name)}</title><meta name="description" content="${esc(FAST.description)}"><link rel="canonical" href="https://heyalex.dev/fast"><meta property="og:type" content="website"><meta property="og:url" content="https://heyalex.dev/fast"><meta property="og:title" content="fast"><meta property="og:description" content="${esc(FAST.description)}"><meta property="og:image" content="https://heyalex.dev/og.jpg"><meta name="twitter:card" content="summary_large_image"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap"><style>${FAST_CSS}</style></head><body><main>` +
  `<h1>fast</h1><p class="lead">${inline(FAST.intro)}</p>` +
  `<p class="dim key">The bars use a log scale, so ${esc(FAST_BY_TIME[0][0].took)} and ${esc(FAST_BY_TIME.at(-1)[0].took)} fit on the same line.</p>` +
  fastList(FAST.list) +
  (FAST.after || []).map(a => `<div class="after"><p>${inline(a.p)}</p>${sources(a.src)}</div>`).join("") +
  (FAST.mine && FAST.mine.length ? `<h2>And mine</h2><p class="dim">${inline(FAST.mineIntro)}</p>${fastList(FAST.mine, "mine")}` : "") +
  (FAST.ask ? `<p class="ask">${inline(FAST.ask)}</p>` : "") +
  `<footer><a href="/">← The waterfront</a><a href="/resume">Résumé</a></footer></main></body></html>`;
let FAST_CSP_PROMISE;

// the cats' pet counter is shared by everyone. kv takes few writes, so each isolate batches pets in memory and
// writes them at most every five minutes (or every 50 pets); a visitor adds at most one pet a second.
const PETS = { base: null, at: 0, pending: 0, flushed: 0 }, PETTED = new Map();
async function petCount(env) {
  if (PETS.base === null || Date.now() - PETS.at > 60e3) {
    PETS.base = Number(await env.STATUS.get("pets")) || 0;
    PETS.at = Date.now();
  }
  return PETS.base + PETS.pending;
}
async function flushPets(env) {
  const add = PETS.pending;
  if (!add) return;
  PETS.pending = 0;
  PETS.flushed = Date.now();
  try {
    const now = (Number(await env.STATUS.get("pets")) || 0) + add;
    await env.STATUS.put("pets", String(now));
    PETS.base = now;
    PETS.at = Date.now();
  } catch (e) { PETS.pending += add; }
}

// the photo manifest the uploader sends: ids, titles, dates and a camera-settings line, nothing else
function photoManifest(b) {
  if (!Array.isArray(b) || b.length > 60) return null;
  const str = (v, n) => typeof v === "string" ? v.slice(0, n) : "";
  const out = [];
  for (const x of b) {
    if (!x || typeof x !== "object" || !/^[a-z0-9-]{1,40}$/.test(x.id)) return null;
    out.push({ id: x.id, title: str(x.title, 80), date: str(x.date, 20), exif: str(x.exif, 100), w: Math.max(0, Math.min(10000, Math.round(Number(x.w)) || 0)), h: Math.max(0, Math.min(10000, Math.round(Number(x.h)) || 0)) });
  }
  return out;
}

// the page with its header hidden and a name card on top, screenshotted/recorded for link previews
const OG_CSS = '<style>.top,.col,.open{display:none!important}body:after{content:"";position:fixed;left:0;right:0;bottom:0;height:62%;background:linear-gradient(rgba(0,0,0,0),rgba(0,0,0,.78));z-index:40}.ogc{position:fixed;left:64px;bottom:58px;z-index:50;font-family:"JetBrains Mono",ui-monospace,monospace;text-shadow:0 0 14px #000,0 0 28px #000}.ogc .n{font-size:58px;font-weight:500;color:#efede8;letter-spacing:-.5px}.ogc .d{font-size:23px;color:#d2cdc3;margin-top:10px}.ogc .u{font-size:23px;color:#ffb04d;margin-top:20px}</style>';
const OG_BODY = '<div class="ogc"><div class="n">Alexander Wondwossen</div><div class="d">AI tools · Apple apps · hardware that talks to AI agents</div><div class="u">heyalex.dev</div></div><script>addEventListener("load",()=>setTimeout(()=>{const p=new URLSearchParams(location.search).get("p")||"set",b=["rise","noon","set","dusk","night","live"].includes(p)&&document.querySelector(\'#preview [data-p="\'+p+\'"]\');b&&b.click()},200))</script>';
const OG_HTML = HTML.replace("</head>", () => OG_CSS + "</head>").replace("</body>", () => OG_BODY + "</body>");
const noindex = { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "no-store" };

// unknown paths get a real 404: a permanent redirect to / is cached by browsers forever and reads as a soft 404
const NOT_FOUND = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found · Alexander Wondwossen</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>:root{color-scheme:dark}body{margin:0;min-height:100svh;display:grid;place-items:center;background:#07080e;color:#ecebe6;font:14px/1.7 ui-monospace,"SF Mono",Menlo,monospace}main{padding:24px;max-width:560px}h1{font-size:14px;font-weight:500;margin:0 0 6px}h1:before{content:"## ";color:#8a8a96}p{margin:0;color:#8a8a96}a{color:#ecebe6;text-decoration:none;border-bottom:1px solid #3a3b48}a:hover{border-color:#ecebe6}:focus-visible{outline:1px solid #ecebe6;outline-offset:3px}</style></head><body><main><h1>404</h1><p>Nothing lives here. The cats probably knocked it into the lake. <a href="/">Back to heyalex.dev</a></p></main></body></html>';
const NOT_FOUND_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), p = url.pathname, m = req.method;
    if (p === "/photography") return new Response(null, { status: 301, headers: { location: "https://heyalex.dev/#side" } });
    if (url.hostname === "www.heyalex.dev") return new Response(null, { status: 301, headers: { location: "https://heyalex.dev" + p + url.search } });
    // the site only lives on heyalex.dev: workers.dev and version-preview hostnames bounce there, so nothing
    // (least of all the upstream-keyed apis) is served on a hostname the edge cache and zone rules may not cover
    if (url.hostname.endsWith(".workers.dev")) return new Response(null, { status: 301, headers: { location: "https://heyalex.dev" + p + url.search } });

    if (p === "/api/status" && m === "GET") {
      // manual (conduit / custom, auto-expires) > now playing > push in the last 3h > nothing (page uses the clock)
      const manual = await env.STATUS.get("manual", "json");
      if (manual) return json(manual);
      const music = await cached(ctx, "lastfm", 30, () => lastfm(env));
      if (music) return json(music);
      const push = await cached(ctx, "push", 300, () => lastPush(env));
      if (push && Date.now() - push.at < 3 * 3600e3) return json({ kind: "push", ...push });
      return json({ kind: null });
    }

    if (p === "/api/status" && m === "POST") {
      if (!(await authed(req, env))) return json({ error: "unauthorized" }, 401);
      let b; try { b = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
      if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: "bad json" }, 400);
      if (b.clear) { await env.STATUS.delete("manual"); return json({ ok: true, cleared: true }); }
      const mins = Math.min(Math.max(Math.round(Number(b.minutes)) || 30, 1), 1440);
      let v;
      if (b.kind === "claude") v = { kind: "claude" };
      else if (b.kind === "custom" && typeof b.text === "string" && b.text.trim()) v = { kind: "custom", text: b.text.trim().slice(0, 100) };
      else return json({ error: "kind must be claude or custom" }, 400);
      await env.STATUS.put("manual", JSON.stringify(v), { expirationTtl: Math.max(60, mins * 60) });
      return json({ ok: true, status: v, minutes: mins });
    }

    if (p === "/api/push" && m === "GET") return json(await cached(ctx, "push", 300, () => lastPush(env)));
    if (p === "/api/game" && m === "GET") return json(await cached(ctx, "games", 300, games));
    // everything the waterfront scene draws from the real world, in one request; each source caches on its own
    if (p === "/api/sky" && m === "GET") {
      const [g, tower, flights, lk, gh] = await Promise.all([
        cached(ctx, "games", 300, games), cached(ctx, "tower", 3 * 3600, towerLights),
        cached(ctx, "flights", 600, ytzFlights), cached(ctx, "lake", 1800, lake),
        cached(ctx, "github", 1800, () => github(env)),
      ]);
      return json({ games: g?.games || [], tower, flights, lake: lk, github: gh });
    }

    // the cats' shared pet counter
    if (p === "/api/pets" && m === "GET") return json({ count: await petCount(env) });
    if (p === "/api/pets" && m === "POST") {
      const ip = req.headers.get("cf-connecting-ip") || "anon", now = Date.now();
      if (now - (PETTED.get(ip) || 0) < 900) return json({ count: await petCount(env), counted: false }, 429);
      if (PETTED.size > 5000) PETTED.clear();
      PETTED.set(ip, now);
      PETS.pending++;
      const count = await petCount(env);
      if (now - PETS.flushed > 300e3 || PETS.pending >= 50) ctx.waitUntil(flushPets(env));
      return json({ count, counted: true });
    }

    // the photo contact sheet: a manifest and the photos themselves live in kv (tools/photos.py uploads them)
    if (p === "/api/photos" && m === "GET") return json(await cached(ctx, "photos", 300, async () => (await env.STATUS.get("photos", "json")) || []) || []);
    if (p === "/api/photos" && m === "PUT") {
      if (!(await authedUpload(req, env))) return json({ error: "unauthorized" }, 401);
      let b; try { b = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
      const list = photoManifest(b);
      if (!list) return json({ error: "bad manifest" }, 400);
      await env.STATUS.put("photos", JSON.stringify(list));
      prime(ctx, "photos", 300, list);
      return json({ ok: true, photos: list.length });
    }
    if (p.startsWith("/api/asset/") && m === "PUT") {
      if (!(await authedUpload(req, env))) return json({ error: "unauthorized" }, 401);
      const name = p.slice(11);
      if (!/^(og-(rise|noon|set|dusk|night)\.(mp4|jpg)|photo-[a-z0-9-]{1,40}\.jpg)$/.test(name)) return json({ error: "bad name" }, 400);
      // refuse a declared oversize body before buffering it; the length check after reading still covers chunked uploads
      if (Number(req.headers.get("content-length")) > 4e6) return json({ error: "too big" }, 413);
      const body = await req.arrayBuffer();
      if (body.byteLength > 4e6) return json({ error: "too big" }, 413);
      await env.STATUS.put("asset:" + name, body);
      return json({ ok: true, name, bytes: body.byteLength });
    }
    if (p.startsWith("/api/")) return json({ error: "not found" }, 404);

    // everything below only reads
    if (m !== "GET" && m !== "HEAD") return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    if (p === "/og-card") return new Response(m === "HEAD" ? null : OG_HTML, { headers: { ...noindex, "content-security-policy": await ogCsp(), ...SEC } });
    if (p === "/og.mp4") {
      const buf = await env.STATUS.get("asset:og-" + skyPhase(Date.now()) + ".mp4", "arrayBuffer");
      if (!buf) return new Response("not found", { status: 404 });
      const size = buf.byteLength, rg = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") || "");
      const base = { "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "public, max-age=600", "x-content-type-options": "nosniff" };
      if (rg) {
        let s = rg[1] === "" ? size - Number(rg[2]) : Number(rg[1]), e = rg[1] !== "" && rg[2] !== "" ? Number(rg[2]) : size - 1;
        s = Math.max(0, s); e = Math.min(size - 1, e);
        if (s > e) return new Response(null, { status: 416, headers: { "content-range": "bytes */" + size } });
        return new Response(m === "HEAD" ? null : buf.slice(s, e + 1), { status: 206, headers: { ...base, "content-range": `bytes ${s}-${e}/${size}`, "content-length": String(e - s + 1) } });
      }
      return new Response(m === "HEAD" ? null : buf, { headers: { ...base, "content-length": String(size) } });
    }
    // photos for the contact sheet, uploaded already resized and stripped of their metadata
    const photo = /^\/photo\/([a-z0-9-]{1,40})\.jpg$/.exec(p);
    if (photo) {
      const buf = await env.STATUS.get("asset:photo-" + photo[1] + ".jpg", "arrayBuffer");
      if (!buf) return new Response("not found", { status: 404 });
      return new Response(m === "HEAD" ? null : buf, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
    }
    // real project screenshots (from each repo's readme), drawn as ascii by the page
    const shot = /^\/p\/(mono|aether|exif)\.jpg$/.exec(p);
    if (shot) {
      const buf = await env.STATUS.get("shot:" + shot[1] + ".jpg", "arrayBuffer");
      if (!buf) return new Response("not found", { status: 404 });
      return new Response(m === "HEAD" ? null : buf, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
    }
    if (p === "/og.jpg") {
      let buf = await env.STATUS.get("asset:og-" + skyPhase(Date.now()) + ".jpg", "arrayBuffer");
      if (!buf) buf = await env.STATUS.get("asset:og.jpg", "arrayBuffer");
      if (!buf) return new Response("not found", { status: 404 });
      return new Response(m === "HEAD" ? null : buf, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=600", "x-content-type-options": "nosniff" } });
    }
    const icon = { "/favicon.svg": [FAVICON_SVG, "image/svg+xml"], "/favicon-32.png": [FAVICON_32, "image/png"], "/favicon.ico": [FAVICON_32, "image/png"], "/apple-touch-icon.png": [TOUCH_ICON, "image/png"], "/apple-touch-icon-precomposed.png": [TOUCH_ICON, "image/png"] }[p];
    if (icon) return new Response(m === "HEAD" ? null : icon[0], { headers: { "content-type": icon[1], "cache-control": "public, max-age=604800", "x-content-type-options": "nosniff" } });

    if (p === "/" || p === "/index.html")
      return new Response(m === "HEAD" ? null : HOME, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "content-security-policy": await csp(), ...SEC } });
    if (p === "/resume" || p === "/resume/")
      return new Response(m === "HEAD" ? null : RESUME_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "content-security-policy": await (RESUME_CSP_PROMISE ||= cspFor(RESUME_HTML)), ...SEC } });
    if (p === "/fast" || p === "/fast/")
      return new Response(m === "HEAD" ? null : FAST_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "content-security-policy": await (FAST_CSP_PROMISE ||= cspFor(FAST_HTML)), ...SEC } });
    const wk = /^\/work\/([a-z0-9-]+)\/?$/.exec(p), pr = wk && PROJECTS.find(x => x.id === wk[1]);
    if (pr) return new Response(m === "HEAD" ? null : projectHTML(pr), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "content-security-policy": await csp(), ...SEC } });
    const pgm = /^\/([a-z-]+)\/?$/.exec(p), pgd = pgm && PGDATA.find(x => x.id === pgm[1]);
    if (pgd) return new Response(m === "HEAD" ? null : pageHTML(pgd), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "content-security-policy": await csp(), ...SEC } });
    if (p === "/robots.txt") return new Response("User-agent: *\nAllow: /\nSitemap: https://heyalex.dev/sitemap.xml\n", { headers: { "content-type": "text/plain" } });
    if (p === "/llms.txt") return new Response(LLMS, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=3600" } });
    if (p === "/sitemap.xml") return new Response('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://heyalex.dev/</loc></url><url><loc>https://heyalex.dev/resume</loc></url><url><loc>https://heyalex.dev/fast</loc></url>' + PROJECTS.map(x => `<url><loc>https://heyalex.dev/work/${x.id}</loc></url>`).join("") + PGDATA.map(x => `<url><loc>https://heyalex.dev/${x.id}</loc></url>`).join("") + '</urlset>', { headers: { "content-type": "application/xml" } });
    if (p === "/.well-known/security.txt") return new Response("Contact: mailto:hi@heyalex.dev\nExpires: 2027-10-28T00:00:00Z\n", { headers: { "content-type": "text/plain" } });
    return new Response(m === "HEAD" ? null : NOT_FOUND, { status: 404, headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "public, max-age=300", "content-security-policy": NOT_FOUND_CSP, ...SEC } });
  },
};
