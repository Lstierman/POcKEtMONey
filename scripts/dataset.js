// Exports the collected prices as a clean dataset for training a price model (one JSON object per line).
//
//   npm run dataset [-- --store=store --out=build/dataset]
//
// Writes, into --out:
//   cards.jsonl     one row per print: what is known about the card (set, release date, rarity, type, HP, artist, …)
//   markets.jsonl   one row per print × market × day: asks and sales of that day's snapshot (the time series to learn from)
//   sales.jsonl     one row per sale: date, price, market (the targets to predict and compare with)
//   guide.jsonl     one row per print × observation: Cardmarket trend, listing average, TCGplayer, sold median (EUR)
//   schema.json     every field, explained
// A market is language × variant × quality (src/prices.js): raw copies by condition and graded copies by company and
// grade are never mixed, nor languages, nor standard / reverse holo / 1st edition / shadowless prints.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const P = require('../src/prices.js');
const { Store } = require('./lib/store.js');

const root = path.join(__dirname, '..');
const arg = (n, d) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const storeDir = path.resolve(root, arg('store', 'store')), out = path.resolve(root, arg('out', 'build/dataset'));
const LANG_CODE = { 0: '', 1: 'en', 2: 'fr', 3: 'de', 4: 'es', 5: 'it', 6: 'zh-cn', 7: 'ja', 8: 'pt', 9: 'ru', 10: 'ko', 11: 'zh-tw', 12: 'nl', 13: 'pl' };

const SCHEMA = {
  cards: {
    id: 'print id (pokemontcg.io id; Japanese prints ja:<TCGdex id>)', lang: 'print language: en or ja', name: 'name as printed', name_en: 'English name',
    set: 'set id', set_name: 'set name', series: 'series', release: 'set release date (YYYY-MM-DD)', number: 'card number', printed_total: 'printed set size',
    rarity: 'rarity', supertype: 'Pokémon / Trainer / Energy', subtypes: 'subtypes', hp: 'HP (0 if none)', types: 'energy types', artist: 'illustrator',
    dex: 'National Pokédex numbers', regulation: 'regulation mark', formats: 'legal formats (S standard, E expanded, U unlimited)',
    bundle: 'id shared by the same card in other languages / same-art reprints (null if none)', cardmarket_products: 'Cardmarket product ids [id, variant]', watched: 'on the To watch list'
  },
  markets: {
    card: 'print id', market: 'market key "<language id>|<variant>|<quality>"', lang: 'language code of the copies (en, de, fr, ja, …; empty = not stated)',
    variant: 'std, reverse, 1st, shadowless', quality: '"RAW NM/EX/GD/LP/PL" or "RAW ?" (condition not stated), or a grade like "PSA 10"', graded: 'true for graded copies',
    day: 'snapshot day (YYYY-MM-DD)', asks: 'listings counted that day', ask_min: 'lowest ask, EUR', ask_median: 'median ask, EUR',
    sales_90d: 'sales in the 90 days before that day', sale_median_90d: 'median sale of those 90 days, EUR'
  },
  sales: {
    card: 'print id', date: 'sale date (YYYY-MM-DD)', eur: 'price in EUR (ECB rate when collected)', price: 'price as sold', currency: 'currency as sold',
    market: 'market key', lang: 'language code', variant: 'variant', quality: 'quality', graded: 'true for graded copies', source: 'eb eBay, pc PriceCharting', ref: 'unique reference of the sale'
  },
  guide: {
    card: 'print id', source: 'store (the price store, hourly) or snapshot (the build\'s daily history, about 6 weeks)', time: 'observation hour (YYYY-MM-DDTHH) or day (YYYY-MM-DD)',
    headline: 'the page\'s headline price, EUR', cm_trend: 'Cardmarket price guide trend (European languages pooled; Japanese prints: Japanese copies), EUR',
    listing_avg: 'Cardmarket listing average, print\'s language, NM or better, EUR', tcg_market: 'TCGplayer market (English), EUR', tcg_market_usd: 'TCGplayer market, USD (snapshot rows)',
    sold_median: 'eBay sold median, raw, print\'s language, EUR'
  }
};

function catalog() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const gz = /<script type="application\/octet-stream" id="catalog-gz">([^<]*)<\/script>/.exec(html);
  if (!gz) throw new Error('index.html has no embedded catalog; run npm run refresh once');
  return JSON.parse(zlib.gunzipSync(Buffer.from(gz[1], 'base64')));
}

(function main() {
  if (!fs.existsSync(storeDir)) throw new Error('no price store at ' + storeDir + ' (run npm run helper first, or pass --store=)');
  const store = new Store(storeDir), cat = catalog();
  const map = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'data/card-map.json.gz'))));
  const cmOf = new Map(map.cards.map(c => [c[0], c[6]]));
  const watch = new Set(((store.read('watchlist.json', null) || {}).cards || []).map(w => w[0]));
  const bundleOf = new Map(); (cat.bundles || []).forEach((ids, b) => ids.forEach(id => bundleOf.set(typeof id === 'string' ? id : null, b)));
  fs.mkdirSync(out, { recursive: true });
  const files = {}, counts = {};
  const w = (name, row) => { (files[name] = files[name] || fs.openSync(path.join(out, name + '.jsonl'), 'w')); fs.writeSync(files[name], JSON.stringify(row) + '\n'); counts[name] = (counts[name] || 0) + 1; };

  // cards
  const sets = new Map(cat.setList.map(s => [s.id, s])), setOf = new Map();
  for (const r of cat.records) for (const t of r.c) {
    const s = sets.get(r.id) || {}; setOf.set(t[0], r.id);
    w('cards', { id: t[0], lang: t[22] === 'ja' ? 'ja' : 'en', name: t[1], name_en: t[22] === 'ja' ? t[24] || '' : t[1], set: r.id, set_name: s.n || '', series: s.se || '',
      release: s.d || '', number: t[8] || '', printed_total: s.pt || null, rarity: t[6] || '', supertype: t[2] || '', subtypes: t[3] || [], hp: t[4] || 0, types: t[5] || [],
      artist: t[7] || '', dex: t[9] || [], regulation: t[10] || '', formats: t[20] || '', bundle: bundleOf.has(t[0]) ? bundleOf.get(t[0]) : null,
      cardmarket_products: cmOf.get(t[0]) || [], watched: watch.has(t[0]) });
  }
  const mk = key => { const m = P.parseMarket(key); return { market: key, lang: LANG_CODE[m.lang] || '', variant: m.variant, quality: m.quality, graded: m.graded }; };

  // markets: daily points
  const dir = d => (fs.existsSync(path.join(storeDir, d)) ? fs.readdirSync(path.join(storeDir, d)) : []);
  for (const f of dir('markets')) {
    const h = store.read('markets/' + f, {});
    for (const [card, markets] of Object.entries(h)) for (const [key, pts] of Object.entries(markets)) for (const p of pts)
      w('markets', Object.assign({ card }, mk(key), { day: p[0], asks: p[1], ask_min: p[2], ask_median: p[3], sales_90d: p[4], sale_median_90d: p[5] }));
  }
  // sales ledger
  for (const s of dir('sales')) for (const f of dir('sales/' + s)) {
    const l = store.read('sales/' + s + '/' + f, null); if (!l) continue;
    for (const r of l.sales) w('sales', Object.assign({ card: l.id, date: r[0], eur: r[1], price: r[2], currency: r[3] }, mk(P.marketKey(r[4], r[5], r[6])), { source: r[7], ref: r[8] }));
  }
  // price guide / headline history
  for (const f of dir('history')) {
    const h = store.read('history/' + f, {});
    for (const [card, pts] of Object.entries(h)) for (const p of pts)
      w('guide', { card, source: 'store', time: p[0], headline: p[1], cm_trend: p[2], listing_avg: p[3], tcg_market: p[4], sold_median: p[5] });
  }
  // the build's daily snapshot history: Cardmarket trend (EUR) and TCGplayer market (USD)
  const eAx = cat.meta.eurAxis || [], uAx = cat.meta.usdAxis || [];
  for (const r of cat.records) for (const t of r.c) {
    const h = t[25]; if (!h) continue;
    const days = new Map();
    const add = (arr, axis, field) => { if (!arr) return; for (let i = 1; i < arr.length; i++) { if (arr[i] == null) continue; const d = axis[arr[0] + i - 1]; if (!d) continue; (days.get(d) || days.set(d, {}).get(d))[field] = arr[i]; } };
    add(h.e, eAx, 'cm_trend'); add(h.u, uAx, 'tcg_market_usd');
    for (const d of [...days.keys()].sort()) w('guide', Object.assign({ card: t[0], source: 'snapshot', time: d }, days.get(d)));
  }
  for (const fd of Object.values(files)) fs.closeSync(fd);
  fs.writeFileSync(path.join(out, 'schema.json'), JSON.stringify(SCHEMA, null, 2));
  console.log('dataset in ' + out + ': ' + Object.entries(counts).map(([k, n]) => n.toLocaleString('en-US') + ' ' + k).join(', '));
})();
