// render an og-card phase to PNG frames with a fake clock (deterministic, real-time pacing)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const [phase, outDir, seconds = '6', fps = '15'] = process.argv.slice(2);
const F = p => require.resolve('@fontsource/jetbrains-mono/files/' + p);
const fontCss = `@font-face{font-family:"JetBrains Mono";font-weight:400;src:url(data:font/woff2;base64,${fs.readFileSync(F('jetbrains-mono-latin-400-normal.woff2')).toString('base64')}) format("woff2")}
@font-face{font-family:"JetBrains Mono";font-weight:500;src:url(data:font/woff2;base64,${fs.readFileSync(F('jetbrains-mono-latin-500-normal.woff2')).toString('base64')}) format("woff2")}`;
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const html = fs.readFileSync(path.join(__dirname, `card-${phase}.html`), 'utf8');
  const api = JSON.parse(fs.readFileSync(path.join(__dirname, 'api.json'), 'utf8'));
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  const pg = await ctx.newPage();
  await pg.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith('https://heyalex.dev/og-card')) return r.fulfill({ contentType: 'text/html', body: html });
    if (u.includes('fonts.googleapis.com')) return r.fulfill({ contentType: 'text/css', body: fontCss });
    const m = u.match(/heyalex\.dev\/api\/(\w+)/); if (m) return r.fulfill({ contentType: 'application/json', body: JSON.stringify(api[m[1]] ?? null) });
    if (u.includes('open-meteo')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify(api.wx) });
    return r.abort();
  });
  // record two weeks into the season (no holiday tower colours, right leaves/snow). override with PREVIEW_DATE=YYYY-MM-DD
  const when = process.env.PREVIEW_DATE ? new Date(process.env.PREVIEW_DATE + 'T12:00:00-05:00') : new Date(Date.now() + 14 * 864e5);
  await pg.clock.install({ time: when.getTime() });
  // the halloween edition runs all october; keep it out of the season-long link previews
  await pg.addInitScript(() => { window.__hw = false; window.__xm = false; });
  await pg.goto(`https://heyalex.dev/og-card?p=${phase}`);
  await pg.evaluate(() => document.fonts.ready);
  await pg.clock.runFor(2500); // load handler clicks the preview, sky settles
  const n = Math.round(+seconds * +fps), step = 1000 / +fps;
  for (let i = 0; i < n; i++) {
    await pg.clock.runFor(step);
    await pg.screenshot({ path: path.join(outDir, `f${String(i).padStart(4, '0')}.png`) });
  }
  await b.close();
  console.log('frames', n);
})();
