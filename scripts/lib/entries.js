// How a card's summary entry is updated from Cardmarket listings and eBay items (the scraper extension, through
// scripts/ingest-server.js), and how the headline and history are derived (also by the hourly collector).
const P = require('../../src/prices.js');
const { SCHEMA, addPoint } = require('./store.js');
const EBQ = require('./ebay.js');

// products: [{ cm, label, articles: PRICES.ARTICLE rows }]
function applyCardmarket(store, entry, card, products, at, source) {
  store.write(store.listingFile('cardmarket', card[1], card[0]), { v: SCHEMA, id: card[0], at, source: source || 'api', products }, 'cmListing');
  const all = products.flatMap(p => p.articles);
  const l = P.aggregateArticles(all);
  if (Object.keys(l).length) entry.l = l; else delete entry.l;
  entry.lt = at; entry.ln = all.length;
  // how complete the listings are: share of loaded views that reached the last offer (the API always does)
  const views = products.flatMap(p => p.coverage || []);
  if (views.length) entry.lc = Math.round(views.filter(v => v[3]).length / views.length * 100) / 100; else delete entry.lc;
  P.setSegments(entry, 'cm', P.obsArticles('cm', all));
}

// active / sold: eBay item rows (scripts/lib/ebay.js). ea / es: EUR stats of raw copies in the card's own language
// (the headline); b: everything, split by for sale / sold, language and grade
function applyEbay(store, entry, card, active, sold, queries, fx, at, source) {
  const dedupe = rows => [...new Map(rows.map(r => [r[0], r])).values()];
  const a = dedupe(active), s = dedupe(sold).sort((x, y) => (y[6] > x[6] ? 1 : -1));
  store.write(store.listingFile('ebay', card[1], card[0]), { v: SCHEMA, id: card[0], at, source: source || 'api', queries, active: a, sold: s }, 'ebayListing');
  const def = (mp, title) => EBQ.defaultLang(card, mp, (queries || {})[mp], title), own = card[5] === 'ja' ? 7 : 1;
  const plainOwn = r => !P.grade(r[1], r[4]) && (P.titleLang(r[1]) || def(r[5], r[1])) === own;
  const eur = rows => P.stats(rows.filter(plainOwn).map(r => P.toEur(r[2], r[3], fx)));
  const ea = eur(a), es = eur(s);
  if (ea) entry.ea = ea; else delete entry.ea;
  if (es) { entry.es = es; entry.esl = (s.find(plainOwn) || s[0])[6]; } else { delete entry.es; delete entry.esl; }
  entry.en = [a.length, s.length]; entry.et = at;
  P.setSegments(entry, 'eb', P.obsEbay(a, s, fx, def));
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

module.exports = { applyCardmarket, applyEbay, finalize };
