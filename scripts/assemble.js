// Attaches PriceCharting sales to the catalog and inlines everything into index.html.
// PRICES_URL (env) points the page at the hourly price store; by default the "prices" branch of this repo's origin.
const fs = require('fs'), zlib = require('zlib'), path = require('path'), cp = require('child_process');
const root = path.join(__dirname, '..');

function pricesUrl() {
  if (process.env.PRICES_URL) return process.env.PRICES_URL;
  try {
    const m = /github\.com[/:]([^/]+\/[^/.]+?)(\.git)?$/.exec(cp.execSync('git remote get-url origin', { cwd: root }).toString().trim());
    if (m) return 'https://raw.githubusercontent.com/' + m[1] + '/prices/';
  } catch (e) {}
  return 'prices/';
}

(async () => {
  const cat = JSON.parse(fs.readFileSync(path.join(root, 'build/catalog.json')));
  const pc = JSON.parse(fs.readFileSync(path.join(root, 'build/pc_data.json')));
  let n = 0;
  for (const r of cat.records) for (const t of r.c) {
    const x = pc[t[0]]; if (!x) continue;
    while (t.length < 26) t.push(t.length === 22 ? (t[0].startsWith('ja:') ? 'ja' : 'en') : null);
    t[26] = x; n++;
  }
  // exchange rates at build time: the page's offline fallback until the hourly store or a live rate loads
  try {
    const d = await (await fetch('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD,GBP')).json();
    cat.meta.fx = { EUR: 1, USD: Math.round(1 / d.rates.USD * 1e6) / 1e6, GBP: Math.round(1 / d.rates.GBP * 1e6) / 1e6 }; cat.meta.fxDate = d.date;
  } catch (e) { console.warn('no build-time exchange rate:', e.message); }
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'prices.config.json'), 'utf8'));
  const raw = Buffer.from(JSON.stringify(cat));
  const gz = zlib.gzipSync(raw, { level: 9 }).toString('base64');
  const page = fs.readFileSync(path.join(root, 'src/page.html'), 'utf8')
    .replace('/*__CORE__*/', () => fs.readFileSync(path.join(root, 'src/core.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'src/prices.js'), 'utf8'))
    .replace('__COMMIT__', cat.commit).replace('__GZ__', gz)
    .replace('"__PRICES_URL__"', () => JSON.stringify(pricesUrl()))
    .replace('"__CONFIG__"', () => JSON.stringify({ intervalMinutes: cfg.intervalMinutes, displayCurrency: cfg.displayCurrency, headline: cfg.headline, listingCondition: cfg.listingCondition }));
  fs.writeFileSync(path.join(root, 'index.html'), page);
  console.log(`index.html written: ${(page.length / 1e6).toFixed(1)} MB, ${n} cards with sales data, prices store ${pricesUrl()}`);
})().catch(e => { console.error(e); process.exit(1); });
