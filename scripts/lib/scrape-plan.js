// What the scraper extension (scraper-extension/) should visit next, and when each site was last scraped.
// Used by the local helper (scripts/ingest-server.js): the extension asks it for a queue, opens the pages in your own
// Chrome, reads them with scraper-extension/parsers.js and sends the result back to /ingest.
const EBQ = require('./ebay.js');
const ebaySearchUrl = EBQ.searchUrl;

const SITES = ['cardmarket', 'ebay', 'pricecharting'];
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const slug = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const cardNo = c => String(c[3]).replace(/^0+(?=\d)/, '');
const isJa = c => c[5] === 'ja';
const enName = c => (isJa(c) ? c[9] || c[2] : c[2]);
const label = c => `${c[2]}${isJa(c) && c[9] ? ' (' + c[9] + ')' : ''} · ${c[11]} ${c[3]}${c[4] ? '/' + c[4] : ''}`;

const H = 3600e3;
function ages(cfg) {
  const sc = cfg.scrape || {};
  return { watch: (sc.watchStaleHours || 1) * H, catalog: (sc.staleHours || 168) * H, miss: (sc.missRecheckHours || 168) * H,
    watchMiss: (sc.watchMissRecheckHours || 24) * H, fail: (sc.failRecheckHours || 12) * H };
}
const stampsOf = (state, site) => Object.assign({}, (state.scrape || {})[site], (state.capture || {})[site]);

// per site: when it was last scraped, how many cards have browser-scraped prices (fresh: within staleHours), and how
// many watched cards are up to date (within watchStaleHours)
function siteStatus(state, cards, cfg = {}, watch = [], now = Date.now()) {
  const out = {}, A = ages(cfg);
  for (const site of SITES) {
    const stamps = stampsOf(state, site);
    let last = null, n = 0, fresh = 0, eligibleN = 0;
    for (const c of cards.values()) {
      if (!eligible(site, c)) continue; eligibleN++;
      const at = stamps[c[0]]; if (!at) continue;
      n++; if (!last || at > last) last = at; if (now - Date.parse(at) < A.catalog) fresh++;
    }
    const w = watch.filter(id => cards.has(id) && eligible(site, cards.get(id)));
    out[site] = { lastAt: last, cards: n, fresh, eligible: eligibleN,
      watch: { n: w.length, current: w.filter(id => stamps[id] && now - Date.parse(stamps[id]) < A.watch).length } };
  }
  return out;
}

function eligible(site, c) { return site === 'cardmarket' ? c[6].length > 0 : true; }

// "base1-4, sv3pt5" -> the listed cards plus every card of the listed sets (by set id or code)
function expandOnly(only, cards) {
  const want = String(only || '').split(/[\s,]+/).filter(Boolean).map(s => s.toLowerCase());
  if (!want.length) return null;
  const out = [];
  for (const c of cards.values()) if (want.includes(c[0].toLowerCase()) || want.includes(String(c[1]).toLowerCase()) || want.includes(String(c[10]).toLowerCase())) out.push(c);
  return out;
}

// the next n cards for a site, in the order "Scrape all" works through them:
//   1. watched cards (the To watch list, in the order added) not scraped on this site within watchStaleHours (1 h)
//   2. the rest of the catalog: cards never scraped on this site first, most valuable first; then the oldest
//      scrape first, once it is older than staleHours (a week)
// Held back: cards the site had no match for (rechecked after missRecheckHours, a week; watched cards after a day)
// and cards that failed (retried after failRecheckHours). `only` (card ids or sets) ignores all of that.
function pickCards(site, { cards, entries, state, cfg, n = 20, only, watch = [], now = Date.now() }) {
  const A = ages(cfg), stamps = stampsOf(state, site), misses = (state.misses || {})[site] || {}, fails = (state.fails || {})[site] || {};
  const recent = (at, age) => at && now - Date.parse(at) < age;
  // a miss or failure counts only when it is newer than the last capture
  const held = (c, watched) => { const at = stamps[c[0]] || '';
    return (recent(misses[c[0]], watched ? A.watchMiss : A.miss) && misses[c[0]] > at) || (recent(fails[c[0]], A.fail) && fails[c[0]] > at); };
  const listed = expandOnly(only, cards);
  if (listed) return listed.filter(c => eligible(site, c)).slice(0, n).map(c => [c, 'only']);
  const out = [], watched = new Set();
  for (const id of watch) {
    const c = cards.get(id); if (!c || watched.has(id)) continue; watched.add(id);
    if (eligible(site, c) && !recent(stamps[id], A.watch) && !held(c, true)) out.push([c, 'watch']);
    if (out.length >= n) return out;
  }
  const value = c => (entries[c[0]] && entries[c[0]].h) || 0;
  const rest = [...cards.values()].filter(c => !watched.has(c[0]) && eligible(site, c) && !recent(stamps[c[0]], A.catalog) && !held(c, false))
    .sort((a, b) => { const sa = stamps[a[0]] || '', sb = stamps[b[0]] || '';
      if (!sa !== !sb) return sa ? 1 : -1;                    // never scraped first
      if (!sa) return value(b) - value(a) || (a[0] < b[0] ? -1 : 1); // then by value
      return sa < sb ? -1 : sa > sb ? 1 : 0; });              // scraped: oldest first
  for (const c of rest) { if (out.length >= n) break; out.push([c, 'catalog']); }
  return out;
}

// one queue item: everything the extension needs to scrape this card on this site
// Cardmarket search limited to the product's expansion (from Cardmarket's product catalog): a handful of results
// instead of every "Charizard" in every set
const CM_SEARCH = 'https://www.cardmarket.com/en/Pokemon/Products/Search';
function cmSearchUrl(name, idExpansion) {
  const q = new URLSearchParams({ searchString: name }); if (idExpansion) q.set('idExpansion', idExpansion); q.set('perSite', '50');
  return CM_SEARCH + '?' + q;
}

function plan(site, c, { cfg, urls = {}, cmInfo = null }) {
  const base = { site, card: c[0], label: label(c), match: { name: slug(enName(c)), num: cardNo(c), set: slug(c[11]), ja: isJa(c) } };
  if (site === 'ebay') {
    const sc = cfg.scrape || {}, pages = [];
    for (const mp of sc.ebayMarketplaces || cfg.ebay.marketplaces) {
      const q = EBQ.query(c, mp);
      pages.push({ mp, sold: false, url: ebaySearchUrl(mp, q, false) });
      if (sc.ebaySold !== false) pages.push({ mp, sold: true, url: ebaySearchUrl(mp, q, true) });
    }
    return Object.assign(base, { pages });
  }
  if (site === 'cardmarket') {
    const max = (cfg.cardmarket && cfg.cardmarket.maxProductsPerCard) || 3, known = urls.cardmarket || {};
    const products = c[6].slice(0, max).map(([cm, variant]) => {
      const info = cmInfo && cmInfo.get(cm);
      return { cm, variant, url: known[cm] || null, search: info ? cmSearchUrl(info.name, info.idExpansion) : null };
    });
    // every listing per language and condition: Cardmarket shows the cheapest offers first and loads more on request;
    // when a product has more offers than `maxLoadMore` clicks reveal, it is reloaded per language (?language=) and,
    // within a language, per condition threshold (?minCondition=1 Mint … 7 Poor, "this or better")
    const sc = (cfg.scrape && cfg.scrape.cardmarket) || {};
    const filters = { maxLoadMore: sc.maxLoadMore || 40, conditions: sc.conditions !== false,
      languages: (isJa(c) ? sc.jaLanguages || [7] : sc.languages || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]).slice() };
    return Object.assign(base, {
      products, filters,
      // English prints: pokemontcg.io redirects to the card's Cardmarket product page
      redirect: isJa(c) ? null : 'https://prices.pokemontcg.io/cardmarket/' + encodeURIComponent(c[0]),
      search: cmSearchUrl(enName(c))
    });
  }
  if (site === 'pricecharting') {
    const known = (urls.pricecharting || {})[c[0]] || null;
    const q = ['pokemon', isJa(c) ? 'japanese' : '', c[11], enName(c), cardNo(c)].filter(Boolean).join(' ');
    return Object.assign(base, { url: known, search: 'https://www.pricecharting.com/search-products?type=prices&q=' + encodeURIComponent(q) });
  }
  throw new Error('unknown site ' + site);
}

module.exports = { SITES, siteStatus, pickCards, plan, expandOnly, slug, cmSearchUrl, label };
