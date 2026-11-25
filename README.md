# heyalex.dev

my site. an ascii toronto waterfront that follows the real sun, moon, weather, seasons and game nights, with two black cats on the seawall.

one cloudflare worker serves everything:

- `/` the page (`src/index.html`, a single self-contained file)
- `/api/status` the "alex is ___" line: manual status > last.fm now playing > a recent github push > the clock
- `/api/sky` everything the scene takes from the real world, each source cached at the edge on its own:
  - tonight's leafs, raptors and jays games (nhl, nba and mlb apis): live state, the result, and the rogers centre roof. home games light the arena or stadium, a win sets off fireworks over it
  - the cn tower's lighting schedule (cntower.ca): tonight's colours and what they're for, rainbow at the bottom of each hour
  - billy bishop's arrivals and departures boards: planes land over the harbour and take off on the real times
  - snow and ice (open-meteo, last 92 days): the first snow of the winter, snow on the roofs and seawall, and harbour ice from freezing degree-days, which the lake dive sees from below
- `/api/push` last push; `/api/game` the old games endpoint, kept for cached pages
- `/og.mp4`, `/og.jpg` link previews, picked by where the sun is over toronto right now

the page also knows the ward's island ferry timetable (city of toronto, winter 2026-27, plus the spring and summer evening trips), new year's eve (dec 27 to jan 1, with a countdown and a show at midnight), and the geminid and perseid meteor showers on clear nights.

## run it

```bash
npm install
npx wrangler dev        # local, needs .dev.vars with LASTFM_KEY and STATUS_TOKEN
npx wrangler deploy     # ships to heyalex.dev
```

secrets live in cloudflare, never in this repo: `LASTFM_KEY`, `STATUS_TOKEN`, `GH_TOKEN`.

```bash
npm test                # offline worker tests, plain node (22.15+), no install needed
```

## set the status

```bash
printf 'authorization: Bearer %s\n' "$STATUS_TOKEN" | curl -X POST https://heyalex.dev/api/status \
  -H @- -d '{"kind":"custom","text":"alex is at the gym (lying)","minutes":60}'
```

`{"kind":"claude"}` → "alex is harassing claude again". `{"clear":true}` goes back to the clock.

## link previews

`tools/previews.sh` records the five 6-second loops (sunrise, noon, sunset, dusk, night) in headless chromium with a fake clock and uploads them. re-run when the season changes.

## security

strict csp (the inline script is allowed by its hash, computed at runtime), hsts, no third-party scripts except cloudflare web analytics (no cookies). keys stay server-side; upstream apis are cached so traffic can't burn quotas; writes need the bearer token.
