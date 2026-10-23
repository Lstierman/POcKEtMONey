// What the scraper extension (scraper-extension/) should visit next, and when each site was last scraped.
// Used by the local helper (scripts/ingest-server.js): the extension asks it for a queue, opens the pages in your own
// Chrome, reads them with extension/parsers.js and sends the result back to /ingest.
const EBQ = require('./ebay.js');
const { searchUrl: ebaySearchUrl } = require('../scrape/ebay.js');

const SITES = ['cardmarket', 'ebay', 'pricecharting'];
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const slug = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const cardNo = c => String(c[3]).replace(/^0+(?=\d)/, '');
const isJa = c => c[5] === 'ja';
const enName = c => (isJa(c) ? c[9] || c[2] : c[2]);
const label = c => `${c[2]}${isJa(c) && c[9] ? ' (' + c[9] + ')' : ''} · ${c[11]} ${c[3]}${c[4] ? '/' + c[4] : ''}`;

// when each site was last scraped by a browser (extension captures and the Node scraper), and for how many cards
function siteStatus(state, cards) {
  const out = {};
  for (const site of SITES) {
    const stamps = Object.assign({}, (state.scrape || {})[site], (state.capture || {})[site]);
    let last = null, n = 0;
    for (const [id, at] of Object.entries(stamps)) { if (!cards.has(id)) continue; n++; if (!last || at > last) last = at; }
    out[site] = { lastAt: last, cards: n, eligible: [...cards.values()].filter(c => eligible(site, c)).length };
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

// the next n cards for a site: explicit cards/sets first; otherwise the `always` list, then the most valuable cards.
// Skipped: cards scraped on that site within staleHours, and cards the site had no match for within missRecheckHours
// (a week by default: sites add products, and the card map gains cards, so they are tried again)
function pickCards(site, { cards, entries, state, cfg, n = 20, only, now = Date.now() }) {
  const sc = cfg.scrape || {}, stale = (sc.staleHours || 12) * 3600e3, missAge = (sc.missRecheckHours || 168) * 3600e3;
  const stamps = Object.assign({}, (state.scrape || {})[site], (state.capture || {})[site]), misses = (state.misses || {})[site] || {};
  const recent = (at, age) => at && now - Date.parse(at) < age;
  // a miss counts only when it is newer than the last capture
  const fresh = c => recent(stamps[c[0]], stale) || (recent(misses[c[0]], missAge) && !(stamps[c[0]] > misses[c[0]]));
  const listed = expandOnly(only, cards);
  if (listed) return listed.filter(c => eligible(site, c)).slice(0, n);
  const always = new Set((cfg.schedule && cfg.schedule.always) || []);
  const value = c => (always.has(c[0]) ? Infinity : (entries[c[0]] && entries[c[0]].h) || 0);
  return [...cards.values()].filter(c => eligible(site, c) && !fresh(c))
    .sort((a, b) => value(b) - value(a) || (a[0] < b[0] ? -1 : 1)).slice(0, n);
}

// one queue item: everything the extension needs to scrape this card on this site
function plan(site, c, { cfg, urls = {} }) {
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
    const products = c[6].slice(0, max).map(([cm, variant]) => ({ cm, variant, url: known[cm] || null }));
    return Object.assign(base, {
      products,
      // English prints: pokemontcg.io redirects to the card's Cardmarket product page
      redirect: isJa(c) ? null : 'https://prices.pokemontcg.io/cardmarket/' + encodeURIComponent(c[0]),
      search: 'https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=' + encodeURIComponent(enName(c))
    });
  }
  if (site === 'pricecharting') {
    const known = (urls.pricecharting || {})[c[0]] || null;
    const q = ['pokemon', isJa(c) ? 'japanese' : '', c[11], enName(c), cardNo(c)].filter(Boolean).join(' ');
    return Object.assign(base, { url: known, search: 'https://www.pricecharting.com/search-products?type=prices&q=' + encodeURIComponent(q) });
  }
  throw new Error('unknown site ' + site);
}

module.exports = { SITES, siteStatus, pickCards, plan, expandOnly, slug };
