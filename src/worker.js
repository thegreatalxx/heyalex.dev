// heyalex.dev: one worker serves the page, the live status api, and the link-preview media.
import HTML from "./index.html";

// the page's inline script is allowed by hash, so editing index.html never needs a manual csp update
let CSP_PROMISE;
function csp() {
  return (CSP_PROMISE ||= (async () => {
    const script = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
    const sha = btoa(String.fromCharCode(...new Uint8Array(d)));
    return [
      "default-src 'none'",
      `script-src 'sha256-${sha}' https://static.cloudflareinsights.com`,
      "style-src 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self' https://api.open-meteo.com https://cloudflareinsights.com",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ].join("; ");
  })());
}

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

// upstreams are hit at most once per ttl per edge location, however much traffic the site gets
async function cached(ctx, key, ttl, fn) {
  const cache = caches.default, req = new Request("https://cache.heyalex.dev/" + key);
  const hit = await cache.match(req);
  if (hit) return hit.json();
  let val = null;
  try { val = await fn(); } catch (e) {}
  ctx.waitUntil(cache.put(req, new Response(JSON.stringify(val), { headers: { "cache-control": `max-age=${val === null ? Math.min(ttl, 60) : ttl}` } })));
  return val;
}

async function lastfm(env) {
  const q = new URLSearchParams({ method: "user.getrecenttracks", user: env.LASTFM_USER, api_key: env.LASTFM_KEY, format: "json", limit: "1" });
  const r = await fetch("https://ws.audioscrobbler.com/2.0/?" + q, { headers: UA });
  if (!r.ok) return null;
  const t = (await r.json())?.recenttracks?.track?.[0];
  if (!t || t["@attr"]?.nowplaying !== "true") return null;
  return { kind: "music", track: String(t.name).slice(0, 120), artist: String(t.artist?.["#text"] ?? "").slice(0, 120) };
}

async function lastPush(env) {
  const r = await fetch(`https://api.github.com/users/${env.GH_USER}/events/public?per_page=30`, { headers: { ...UA, accept: "application/vnd.github+json", ...(env.GH_TOKEN ? { authorization: "Bearer " + env.GH_TOKEN } : {}) } });
  if (!r.ok) return null;
  const e = (await r.json()).find(x => x.type === "PushEvent");
  return e ? { repo: e.repo.name.split("/")[1], at: Date.parse(e.created_at) } : null;
}

async function game() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
  try {
    const j = await (await fetch("https://api-web.nhle.com/v1/club-schedule/TOR/week/now", { headers: UA })).json();
    if ((j.games || []).some(g => g.gameDate === today)) return { game: "leafs" };
  } catch (e) {}
  try {
    const j = await (await fetch("https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json", { headers: UA })).json();
    if ((j?.scoreboard?.games || []).some(g => g.homeTeam?.teamTricode === "TOR" || g.awayTeam?.teamTricode === "TOR")) return { game: "raptors" };
  } catch (e) {}
  return { game: null };
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

// the page with its header hidden and a name card on top, screenshotted/recorded for link previews
const OG_CSS = '<style>.top,.col{display:none!important}body:after{content:"";position:fixed;left:0;right:0;bottom:0;height:62%;background:linear-gradient(rgba(0,0,0,0),rgba(0,0,0,.78));z-index:40}.ogc{position:fixed;left:64px;bottom:58px;z-index:50;font-family:"JetBrains Mono",ui-monospace,monospace;text-shadow:0 0 14px #000,0 0 28px #000}.ogc .n{font-size:58px;font-weight:500;color:#efede8;letter-spacing:-.5px}.ogc .d{font-size:23px;color:#d2cdc3;margin-top:10px}.ogc .u{font-size:23px;color:#ffb04d;margin-top:20px}</style>';
const OG_BODY = '<div class="ogc"><div class="n">alexander wondwossen</div><div class="d">ai tools · apple apps · hardware that talks to agents</div><div class="u">heyalex.dev</div></div><script>addEventListener("load",()=>setTimeout(()=>{const b=document.querySelector(\'#preview [data-p="\'+(new URLSearchParams(location.search).get("p")||"set")+\'"]\');b&&b.click()},200))</script>';
const OG_ICON = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500&display=block"><style>html,body{margin:0;width:180px;height:180px;background:#07080e;display:grid;place-items:center;font-family:"JetBrains Mono",monospace}b{font-size:112px;font-weight:500;color:#ffb04d;line-height:1;transform:translateY(-6px)}</style></head><body><b>a</b></body></html>';
const noindex = { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "no-store" };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), p = url.pathname, m = req.method;
    if (url.hostname === "www.heyalex.dev") return new Response(null, { status: 301, headers: { location: "https://heyalex.dev" + p + url.search } });

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
    if (p === "/api/game" && m === "GET") return json(await cached(ctx, "game", 3600, game));
    if (p.startsWith("/api/asset/") && m === "PUT") {
      if (!(await authed(req, env))) return json({ error: "unauthorized" }, 401);
      const name = p.slice(11);
      if (!/^og-(rise|noon|set|dusk|night)\.(mp4|jpg)$/.test(name)) return json({ error: "bad name" }, 400);
      const body = await req.arrayBuffer();
      if (body.byteLength > 4e6) return json({ error: "too big" }, 413);
      await env.STATUS.put("asset:" + name, body);
      return json({ ok: true, name, bytes: body.byteLength });
    }
    if (p.startsWith("/api/")) return json({ error: "not found" }, 404);

    if (p === "/og-card") return new Response(HTML.replace("</head>", OG_CSS + "</head>").replace("</body>", OG_BODY + "</body>"), { headers: noindex });
    if (p === "/og-icon") return new Response(OG_ICON, { headers: noindex });
    if (p === "/og.mp4") {
      const buf = await env.STATUS.get("asset:og-" + skyPhase(Date.now()) + ".mp4", "arrayBuffer");
      if (!buf) return new Response("not found", { status: 404 });
      const size = buf.byteLength, rg = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") || "");
      const base = { "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "public, max-age=600" };
      if (rg) {
        let s = rg[1] === "" ? size - Number(rg[2]) : Number(rg[1]), e = rg[1] !== "" && rg[2] !== "" ? Number(rg[2]) : size - 1;
        s = Math.max(0, s); e = Math.min(size - 1, e);
        if (s > e) return new Response(null, { status: 416, headers: { "content-range": "bytes */" + size } });
        return new Response(m === "HEAD" ? null : buf.slice(s, e + 1), { status: 206, headers: { ...base, "content-range": `bytes ${s}-${e}/${size}`, "content-length": String(e - s + 1) } });
      }
      return new Response(m === "HEAD" ? null : buf, { headers: { ...base, "content-length": String(size) } });
    }
    // real project screenshots (from each repo's readme), drawn as ascii by the page
    const shot = /^\/p\/(mono|aether|exif)\.jpg$/.exec(p);
    if (shot) {
      const buf = await env.STATUS.get("shot:" + shot[1] + ".jpg", "arrayBuffer");
      if (!buf) return new Response("not found", { status: 404 });
      return new Response(m === "HEAD" ? null : buf, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" } });
    }
    if (p === "/og.jpg" || p === "/apple-touch-icon.png") {
      const isOg = p === "/og.jpg";
      let buf = isOg ? await env.STATUS.get("asset:og-" + skyPhase(Date.now()) + ".jpg", "arrayBuffer") : null;
      if (!buf) buf = await env.STATUS.get(isOg ? "asset:og.jpg" : "asset:icon.png", "arrayBuffer");
      if (!buf) return new Response("not found", { status: 404 });
      return new Response(m === "HEAD" ? null : buf, { headers: { "content-type": isOg ? "image/jpeg" : "image/png", "cache-control": isOg ? "public, max-age=600" : "public, max-age=86400" } });
    }

    if (m !== "GET" && m !== "HEAD") return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    if (p === "/" || p === "/index.html")
      return new Response(m === "HEAD" ? null : HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "content-security-policy": await csp(), ...SEC } });
    if (p === "/robots.txt") return new Response("User-agent: *\nAllow: /\nSitemap: https://heyalex.dev/sitemap.xml\n", { headers: { "content-type": "text/plain" } });
    if (p === "/sitemap.xml") return new Response('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://heyalex.dev/</loc></url></urlset>', { headers: { "content-type": "application/xml" } });
    if (p === "/.well-known/security.txt") return new Response("Contact: mailto:hi@heyalex.dev\nExpires: 2027-10-28T00:00:00Z\n", { headers: { "content-type": "text/plain" } });
    return new Response(null, { status: 301, headers: { location: "/" } });
  },
};
