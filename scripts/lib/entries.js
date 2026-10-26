// How a card's summary entry is updated from Cardmarket listings, eBay items and PriceCharting (the scraper extension,
// through scripts/ingest-server.js), and how the headline and history are derived (also by the hourly collector).
//
// Every price observation is also filed under one market of the print (src/prices.js: language × variant × quality):
//   sales/<set>/<card>.json     the sales ledger: every sale ever seen, deduplicated, never dropped (PRICES.SALE rows)
//   summary m                   the print's markets now: asks, sales of the last 90 days, sales counts, last sale
//   markets/<set>.json.gz       one point per market per day: [day, asks, lowest ask, median ask, sales 90 d, median sale 90 d]
const P = require('../../src/prices.js');
const { SCHEMA, addPoint } = require('./store.js');
const EBQ = require('./ebay.js');

// products: [{ cm, label, articles: PRICES.ARTICLE rows }]
function applyCardmarket(store, entry, card, products, at, source, fx) {
  store.write(store.listingFile('cardmarket', card[1], card[0]), { v: SCHEMA, id: card[0], at, source: source || 'api', products }, 'cmListing');
  const all = products.flatMap(p => p.articles);
  // the condition matrix and listing average: the standard print's products only (shadowless or 1st edition products
  // of the same card are separate markets); a card that only has variant products uses them
  const variantOf = p => P.variantOf((card[6].find(x => x[0] === p.cm) || [])[1] || p.label || '');
  const std = products.filter(p => variantOf(p) === 'std');
  const l = P.aggregateArticles((std.length ? std : products).flatMap(p => p.articles));
  if (Object.keys(l).length) entry.l = l; else delete entry.l;
  entry.lt = at; entry.ln = all.length;
  // how complete the listings are: share of loaded views that reached the last offer (the API always does)
  const views = products.flatMap(p => p.coverage || []);
  if (views.length) entry.lc = Math.round(views.filter(v => v[3]).length / views.length * 100) / 100; else delete entry.lc;
  updateMarkets(store, entry, card, at, fx);
}

// active / sold: eBay item rows (scripts/lib/ebay.js). ea / es: EUR stats of raw copies in the card's own language
// (the headline); b: everything, split by for sale / sold, language and grade
function applyEbay(store, entry, card, active, sold, queries, fx, at, source) {
  const dedupe = rows => [...new Map(rows.map(r => [r[0], r])).values()];
  const a = dedupe(active), s = dedupe(sold).sort((x, y) => (y[6] > x[6] ? 1 : -1));
  store.write(store.listingFile('ebay', card[1], card[0]), { v: SCHEMA, id: card[0], at, source: source || 'api', queries, active: a, sold: s }, 'ebayListing');
  const def = (mp, title) => EBQ.defaultLang(card, mp, (queries || {})[mp], title), own = card[5] === 'ja' ? 7 : 1;
  // headline eBay figures: single raw copies of the standard print in the card's own language
  const plainOwn = r => !P.isJunk(r[1]) && !P.grade(r[1], r[4]) && P.variantOf(r[1]) === 'std' && (P.titleLang(r[1]) || def(r[5], r[1])) === own;
  const eur = rows => P.stats(rows.filter(plainOwn).map(r => P.toEur(r[2], r[3], fx)));
  const ea = eur(a), es = eur(s);
  if (ea) entry.ea = ea; else delete entry.ea;
  if (es) { entry.es = es; entry.esl = (s.find(plainOwn) || s[0])[6]; } else { delete entry.es; delete entry.esl; }
  entry.en = [a.length, s.length]; entry.et = at;
  mergeSales(store, card, P.salesFromEbay(s, fx, def), at);
  updateMarkets(store, entry, card, at, fx);
}

// PriceCharting card page: graded prices and its sales (all in the print's language and the page's variant)
const PC_KEYS = ['ungraded', 'grade7', 'grade8', 'grade9', 'grade9_5', 'psa10'];
function applyPricecharting(store, entry, card, d, fx, at, source) {
  const g = PC_KEYS.map(k => d.prices[k] == null ? null : +d.prices[k]);
  store.write(store.listingFile('pricecharting', card[1], card[0]), { v: SCHEMA, id: card[0], at, source: source || 'scraper', url: d.url, g, sold: d.sold }, 'pcListing');
  entry.pc = { u: d.url, g, at, n: d.sold.length };
  const pageVariant = P.variantOf(String(d.url || '').split('/').pop().replace(/-/g, ' '));
  mergeSales(store, card, P.salesFromPricecharting(d.sold, card[5] === 'ja' ? 7 : 1, pageVariant, fx), at);
  updateMarkets(store, entry, card, at, fx);
  return g;
}

// ---------- markets ----------
const ledgerFile = (store, card) => `sales/${store.listingFile('x', card[1], card[0]).split('/').slice(2).join('/')}`;
const marketsFile = (store, card) => store.historyFile(card[1]).replace(/^history\//, 'markets/');
const KEEP_SALES_DAYS = 3 * 365, KEEP_POINTS_DAYS = 2 * 365;
// adds sales to the print's ledger; a sale seen again (same source and reference) is kept once
function mergeSales(store, card, rows, at) {
  if (!rows.length) return 0;
  const rel = ledgerFile(store, card), old = store.read(rel, null) || { sales: [] };
  const byRef = new Map(old.sales.map(r => [r[8], r])); let added = 0;
  for (const r of rows) if (!byRef.has(r[8])) { byRef.set(r[8], r); added++; }
  const since = new Date(Date.parse(at) - KEEP_SALES_DAYS * 864e5).toISOString().slice(0, 10);
  const sales = [...byRef.values()].filter(r => r[0] >= since).sort((x, y) => (x[0] < y[0] ? 1 : x[0] > y[0] ? -1 : 0));
  if (added || sales.length !== old.sales.length) store.write(rel, { v: SCHEMA, id: card[0], at, sales }, 'sales');
  return added;
}
// recomputes the print's markets from its stored listings and ledger, and adds today's point to the market history
function updateMarkets(store, entry, card, at, fx) {
  const now = Date.parse(at), asks = [];
  const cm = store.read(store.listingFile('cardmarket', card[1], card[0]), null);
  if (cm) for (const p of cm.products) {
    const label = (card[6].find(x => x[0] === p.cm) || [])[1] || p.label || '';
    asks.push(...P.asksFromArticles('cm', p.articles, P.variantOf(label)));
  }
  const eb = store.read(store.listingFile('ebay', card[1], card[0]), null);
  if (eb) asks.push(...P.asksFromEbay(eb.active, fx || null, (mp, title) => EBQ.defaultLang(card, mp, (eb.queries || {})[mp], title)));
  const ledger = store.read(ledgerFile(store, card), { sales: [] });
  const m = P.buildMarkets(asks, ledger.sales, now);
  delete entry.b; // the older breakdown, replaced by markets
  if (Object.keys(m).length) { entry.m = m; entry.mt = at; } else { delete entry.m; delete entry.mt; }
  // market history: one point per market per day (a later update the same day replaces it)
  const rel = marketsFile(store, card), hist = store.read(rel, {}), day = at.slice(0, 10), since = new Date(now - KEEP_POINTS_DAYS * 864e5).toISOString().slice(0, 10);
  const h = hist[card[0]] || (hist[card[0]] = {});
  for (const [k, x] of Object.entries(m)) {
    const pts = (h[k] || []).filter(p => p[0] !== day && p[0] >= since);
    pts.push([day, x.a ? x.a[0] : 0, x.a ? x.a[1] : null, x.a ? x.a[3] : null, x.n90 || 0, x.s ? x.s[3] : null]);
    h[k] = pts;
  }
  store.write(rel, hist, 'mhist');
}

// headline (EUR) for every entry in `ids` (default: all) and one history point per card; writes changed history files
function finalize(store, entries, cards, cfg, fx, now, ids) {
  const hour = new Date(now).toISOString().slice(0, 13), histories = new Map(), changed = new Set();
  for (const id of ids || Object.keys(entries)) {
    const e = entries[id], c = cards.get(id); if (!e || !c) continue;
    const lang = c[5] === 'ja' ? 7 : 1;
    const trend = e.g ? (e.g.find(r => r[1] != null) || [])[1] || null : null;
    const la = P.listingAvg(e.l, lang, cfg.listingCondition) || P.listingAvg(e.c, lang, cfg.listingCondition), tcgUsd = e.t ? (e.t.find(r => r[2] != null) || [])[2] || null : null;
    const tcgEur = tcgUsd != null ? P.r2(P.toEur(tcgUsd, 'USD', fx)) : null, sold = e.es ? e.es[2] : null;
    const order = cfg.headline === 'listings' ? [['listings', la && la.avg], ['trend', trend]] : [['trend', trend], ['listings', la && la.avg]];
    order.push(['tcg', tcgEur], ['sold', sold]);
    const h = order.find(x => x[1] != null);
    if (h) { e.h = h[1]; e.hs = h[0]; } else { delete e.h; delete e.hs; }
    if (!Object.keys(e).length) { delete entries[id]; continue; }
    if (!histories.has(c[1])) histories.set(c[1], store.read(store.historyFile(c[1]), {}));
    const hist = histories.get(c[1]), before = JSON.stringify(hist[id] || []);
    hist[id] = addPoint(hist[id] || [], [hour, e.h == null ? null : e.h, trend, la ? la.avg : null, tcgEur, sold], cfg.history, now);
    if (JSON.stringify(hist[id]) !== before) changed.add(c[1]);
  }
  for (const setId of changed) store.write(store.historyFile(setId), histories.get(setId), 'history');
  return changed.size;
}

module.exports = { applyCardmarket, applyEbay, applyPricecharting, mergeSales, updateMarkets, ledgerFile, marketsFile, finalize };
