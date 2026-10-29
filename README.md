# heyalex.dev

my site. an ascii toronto waterfront that follows the real sun, moon, weather, seasons and game nights, with two black cats on the seawall.

one cloudflare worker serves everything:

- `/` the page (`src/index.html`, a single self-contained file)
- `/api/status` the "alex is ___" line: manual status > last.fm now playing > a recent github push > the clock
- `/api/push`, `/api/game` last push and leafs/raptors game nights, cached at the edge
- `/og.mp4`, `/og.jpg` link previews, picked by where the sun is over toronto right now

## run it

```bash
npm install
npx wrangler dev        # local, needs .dev.vars with LASTFM_KEY and STATUS_TOKEN
npx wrangler deploy     # ships to heyalex.dev
```

secrets live in cloudflare, never in this repo: `LASTFM_KEY`, `STATUS_TOKEN`, `GH_TOKEN`.

## set the status

```bash
curl -X POST https://heyalex.dev/api/status \
  -H "authorization: Bearer $STATUS_TOKEN" \
  -d '{"kind":"custom","text":"alex is at the gym (lying)","minutes":60}'
```

`{"kind":"claude"}` → "alex is harassing claude again". `{"clear":true}` goes back to the clock.

## link previews

`tools/previews.sh` records the five 6-second loops (sunrise, noon, sunset, dusk, night) in headless chromium with a fake clock and uploads them. re-run when the season changes.

## security

strict csp (the inline script is allowed by its hash, computed at runtime), hsts, no third-party scripts except cloudflare web analytics (no cookies). keys stay server-side; upstream apis are cached so traffic can't burn quotas; writes need the bearer token.
