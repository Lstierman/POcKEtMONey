// Browser scrapers for the price data the open APIs don't give: every Cardmarket listing (language, condition, price,
// seller…), eBay items for sale and sold, PriceCharting graded prices and sales. For personal use, run on your own PC:
// a visible Chrome window loads the pages at a human pace; if a site asks you to tick "I'm human" or to log in, the
// scraper waits until you have done it in that window.
//
//   npm run scrape -- [--sites=ebay] [--cards=base1-4,sv3pt5-199] [--set=sv3pt5] [--top=20]
//                     [--store=store] [--publish] [--rebuild]
//
// Results go into the price store in the same format as scripts/collect.js (listings/…, summary.json.gz, history/…);
// PriceCharting results go to data/pricecharting/scraped.jsonl (used by the build). --publish fetches the latest
// "prices" branch into the store first and pushes the result back; --rebuild re-assembles index.html afterwards.
const fs = require('fs'), path = require('path'), zlib = require('zlib'), cp = require('child_process');
const { Store, SCHEMA } = require('./lib/store.js');
const { applyCardmarket, applyEbay, finalize } = require('./lib/entries.js');
const src = require('./lib/sources.js');
const EBQ = require('./lib/ebay.js');
const { Browser } = require('./scrape/browser.js');
const root = path.join(__dirname, '..');
const arg = (n, d) => { const a = process.argv.find(x => x === '--' + n || x.startsWith('--' + n + '=')); return a ? (a.includes('=') ? a.split('=').slice(1).join('=') : true) : d; };
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'prices.config.json'), 'utf8')), sc = cfg.scrape || {};
const sites = String(arg('sites', (sc.sites || ['cardmarket', 'ebay', 'pricecharting']).join(','))).split(',');
const missing = sites.filter(x => !fs.existsSync(path.join(__dirname, 'scrape', x + '.js')));
if (missing.length) { console.error('no scraper for: ' + missing.join(', ') + ' (only eBay is built; Cardmarket and PriceCharting block automated browsers with a Cloudflare check)'); process.exit(1); }
const dir = path.resolve(root, String(arg('store', 'store')));
const git = (...a) => cp.execFileSync('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

function pullStore() { // the store dir becomes a worktree of the latest origin/prices
  git('fetch', '-q', 'origin', 'prices');
  if (!fs.existsSync(path.join(dir, '.git'))) git('worktree', 'add', '-q', '--detach', dir, 'FETCH_HEAD');
  else cp.execFileSync('git', ['checkout', '-q', '--detach', '-f', 'FETCH_HEAD'], { cwd: dir, stdio: 'inherit' });
}
function pushStore() { // same as the workflow: one commit, replacing the branch
  const g = (...a) => cp.execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
  g('add', '-A');
  if (!g('status', '--porcelain').trim()) return console.log('store unchanged, nothing to publish');
  g('checkout', '-q', '--orphan', 'snapshot-' + Date.now());
  g('-c', 'user.name=price-scraper', '-c', 'user.email=scraper@localhost', 'commit', '-q', '-m', 'Prices, scraped ' + new Date().toISOString().slice(0, 16) + 'Z');
  g('push', '-q', '-f', 'origin', 'HEAD:prices');
  console.log('published to the prices branch');
}

(async () => {
  if (arg('publish')) pullStore();
  const store = new Store(dir);
  const map = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'data/card-map.json.gz'))));
  const cards = new Map(map.cards.map(c => [c[0], c]));
  const sum = store.read('summary.json.gz', null), meta = store.read('meta.json', null);
  const state = store.read('state.json', { v: SCHEMA, cm: {}, eb: {} }); state.scrape = state.scrape || {};
  let fx = sum && sum.fx, fxDate = sum && sum.fxDate;
  try { const r = await src.fx(); fx = r.fx; fxDate = r.date; } catch (e) { if (!fx) throw new Error('no exchange rates (offline?)'); }
  const entries = (sum && sum.cards) || {};

  // which cards: explicit, a whole set, or the most valuable ones not scraped for staleHours
  let pick;
  if (arg('cards')) pick = String(arg('cards')).split(',').map(id => cards.get(id) || console.warn('unknown card', id)).filter(Boolean);
  else if (arg('set')) pick = map.cards.filter(c => c[1] === arg('set'));
  else {
    const stale = (sc.staleHours || 12) * 3600e3, n = +arg('top', sc.top || 20);
    pick = map.cards.filter(c => sites.some(s => !(state.scrape[s] || {})[c[0]] || Date.now() - Date.parse(state.scrape[s][c[0]]) > stale))
      .sort((a, b) => ((entries[b[0]] || {}).h || 0) - ((entries[a[0]] || {}).h || 0)).slice(0, n);
  }
  console.log(`scraping ${pick.length} cards on ${sites.join(', ')}; store ${dir}`);

  const browser = await new Browser({ gapMs: (sc.secondsBetweenPages || 7) * 1000 }).open();
  const touched = new Set(), report = { cardmarket: 0, ebay: 0, pricecharting: 0, failed: [] };
  const save = () => {
    finalize(store, entries, cards, cfg, fx, Date.now(), [...touched]); touched.clear();
    const at = new Date().toISOString();
    store.write('summary.json.gz', Object.assign({ v: SCHEMA, at: (sum && sum.at) || at, sources: {} }, sum || {}, { fx, fxDate, scrapedAt: at, cards: entries }), 'summary');
    store.write('state.json', state, 'state');
    store.write('meta.json', Object.assign({ v: SCHEMA, at: (meta && meta.at) || at, sources: {} }, meta || {}, { fx, fxDate, scrapedAt: at, cards: Object.keys(entries).length }), 'meta');
  };
  const stamp = (site, id) => { (state.scrape[site] = state.scrape[site] || {})[id] = new Date().toISOString(); };
  try {
    for (let k = 0; k < pick.length; k++) {
      const c = pick[k], E = entries[c[0]] || (entries[c[0]] = {}), at = new Date().toISOString();
      console.log(`[${k + 1}/${pick.length}] ${c[0]} ${c[2]}`);
      for (const site of sites) {
        try {
          if (site === 'ebay') {
            const S = require('./scrape/ebay.js'), active = [], sold = [], queries = {};
            for (const mp of sc.ebayMarketplaces || cfg.ebay.marketplaces) {
              const q = EBQ.query(c, mp); queries[mp] = q;
              active.push(...EBQ.relevant(c, await S.scrape(browser, mp, q, false)));
              if (sc.ebaySold !== false) sold.push(...EBQ.relevant(c, await S.scrape(browser, mp, q, true)));
            }
            applyEbay(store, E, c, active, sold, queries, fx, at, 'scrape'); report.ebay++;
          } else if (site === 'cardmarket') {
            const S = require('./scrape/cardmarket.js');
            const products = await S.scrape(browser, c, sc.cardmarketMaxPerProduct || 300);
            if (products) { applyCardmarket(store, E, c, products, at, 'scrape'); report.cardmarket++; }
          } else if (site === 'pricecharting') {
            const S = require('./scrape/pricecharting.js');
            if (await S.scrape(browser, c, root)) report.pricecharting++;
          }
          stamp(site, c[0]); touched.add(c[0]);
        } catch (e) {
          report.failed.push(c[0] + ' ' + site + ': ' + e.message);
          console.warn('  ' + site + ' failed: ' + e.message);
          if (e.human) throw e; // nobody completed the check: stop instead of hammering the site
        }
      }
      if (touched.size >= 5) save();
    }
  } finally {
    save(); await browser.close();
    const bad = store.verify();
    console.log(`done: Cardmarket ${report.cardmarket}, eBay ${report.ebay}, PriceCharting ${report.pricecharting} cards, ${browser.pages} pages loaded, ${report.failed.length} failures`);
    if (bad.length) { console.error('VERIFY FAILED\n' + bad.join('\n')); process.exitCode = 2; }
    else if (arg('publish')) pushStore();
    if (arg('rebuild') && report.pricecharting) {
      cp.execFileSync(process.execPath, [path.join(__dirname, 'merge-pricecharting.js'), path.join(root, 'data/pricecharting'), path.join(root, 'build/pc_data.json')], { stdio: 'inherit' });
      cp.execFileSync(process.execPath, [path.join(__dirname, 'assemble.js')], { stdio: 'inherit' });
    }
  }
})().catch(e => { console.error(e.message || e); process.exit(1); });
