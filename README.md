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
  - github: repos i pushed to in the last 30 days and my recent commit subject lines. when it rains, the rain is those words; the labelled fish in the lake dive are those repos
- `/resume` résumé mode: one fast, printable page for people hiring, built from the `resume-data` block and the project list in `src/index.html`
- `/fast` things people in toronto and the rest of canada did fast, fastest first, from `src/fast.json` (see below)
- `/api/pets` the cats' shared pet counter (kv key `pets`, batched so kv sees a write every few minutes at most)
- `/api/photos`, `/photo/<id>.jpg` the photo contact sheet (see below)
- `/api/push` last push; `/api/game` the old games endpoint, kept for cached pages
- `/og.mp4`, `/og.jpg` link previews, picked by where the sun is over toronto right now

the page also knows the ward's island ferry timetable (city of toronto, winter 2026-27, plus the spring and summer evening trips), new year's eve (dec 27 to jan 1, with a countdown and a show at midnight), and the geminid and perseid meteor showers on clear nights.

## on the page

- the header is just the name, a link to résumé mode, and the live status line
- click a cat to pet it: it purrs and a `<3` floats up with the shared count
- "pause the animation" is in the footer (remembered, and on by default with reduced motion)
- the "open to work" sign on the seawall goes to résumé mode
- other art styles (pixel, dots, life) are in the hidden preview controls in the footer, next to weather, season and events
- a pixel alex sits on the seawall to match the status line: coding (laptop light), listening (headphones), up early (coffee). away or asleep, the spot is empty

## photos

```bash
STATUS_TOKEN=... python3 tools/photos.py ~/Pictures/for-the-site
```

turns each photo upright, resizes it to 1600 px and re-encodes it with no metadata at all (no gps), keeps one line of camera settings, uploads the set and replaces the list. needs pillow (`pip3 install --user Pillow`). the photos section stays hidden until there's at least one photo.

## fast

`/fast` is built from `src/fast.json`, after patrickcollison.com/fast and tetraslam.com/fast. to add an entry, add an object to `list` (or to `mine` for my own):

```json
{ "n": "Maple Leaf Gardens", "took": "5½ months", "p": "What happened, with dates.", "src": [["Parks Canada", "https://..."]] }
```

`took` is plain words: a number (decimals and ½ are fine) and seconds, minutes, hours, days, weeks, months or years, or a mix like "4 years 7 months". the page sorts by it and draws every bar on one log scale, so a new fastest or slowest entry rescales the rest. anything else in `took` stops the worker from starting, so a typo can't ship. `[text](https://...)` in `p`, `intro` or `ask` becomes a link. every entry in `list` needs a source.

## ascii-glaze

`packages/ascii-glaze` is the renderer behind the skyline as a tiny mit library (the photo sheet inlines the same code). to publish it: `cd packages/ascii-glaze && npm publish`.

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
