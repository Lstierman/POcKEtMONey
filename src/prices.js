/* Price data model shared by the hourly collector (Node) and the page: listing statistics, currency conversion,
   the headline price and the per-card data-coverage score. All money is stored in its native currency and
   converted with an `fx` table of "euro per one unit" (fx.EUR = 1, fx.USD ≈ 0.9). */
(function (root) {
  'use strict';

  // Cardmarket API language ids and conditions (best first)
  var LANGS = { 1: 'English', 2: 'French', 3: 'German', 4: 'Spanish', 5: 'Italian', 6: 'Chinese (S)', 7: 'Japanese', 8: 'Portuguese', 9: 'Russian', 10: 'Korean', 11: 'Chinese (T)', 12: 'Dutch', 13: 'Polish' };
  var CONDS = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];
  var COND_NAMES = { MT: 'Mint', NM: 'Near Mint', EX: 'Excellent', GD: 'Good', LP: 'Light Played', PL: 'Played', PO: 'Poor' };

  // the six price-data methods, in the order the coverage label lists them
  var METHODS = [
    ['guide', 'Cardmarket price guide'],
    ['listings', 'Cardmarket listings by language & condition'],
    ['tcg', 'TCGplayer market'],
    ['ebayActive', 'eBay listings for sale'],
    ['ebaySold', 'Sold listings (eBay / PriceCharting)'],
    ['graded', 'Graded prices (PriceCharting)']
  ];
  var TIERS = ['No data', 'Thin', 'Fair', 'Good', 'Strong', 'Rich', 'Complete'];

  function r2(x) { return x == null || isNaN(x) ? null : Math.round(x * 100) / 100; }

  // [n, min, median, avg, max]; avg is a trimmed mean (drops the outer 10% once there are 5+ prices) so one
  // silly asking price doesn't move it
  function stats(values) {
    var v = values.filter(function (x) { return typeof x === 'number' && x > 0 && isFinite(x); }).sort(function (a, b) { return a - b; });
    if (!v.length) return null;
    var n = v.length, cut = n >= 5 ? Math.floor(n * 0.1) : 0, core = v.slice(cut, n - cut), sum = 0;
    for (var i = 0; i < core.length; i++) sum += core[i];
    var med = n % 2 ? v[n >> 1] : (v[n / 2 - 1] + v[n / 2]) / 2;
    return [n, r2(v[0]), r2(med), r2(sum / core.length), r2(v[n - 1])];
  }

  // Cardmarket article rows (see ARTICLE fields) -> { "<lang>|<cond>|<flags>": stats }, flags: f foil (reverse holo),
  // 1 first edition, s signed, a altered. A seller's quantity counts up to 4 times.
  var ARTICLE = ['idArticle', 'lang', 'cond', 'price', 'count', 'foil', 'signed', 'firstEd', 'altered', 'country', 'seller', 'comments', 'idProduct'];
  function articleKey(a) { return a[1] + '|' + a[2] + '|' + (a[5] ? 'f' : '') + (a[7] ? '1' : '') + (a[6] ? 's' : '') + (a[8] ? 'a' : ''); }
  function aggregateArticles(articles) {
    var groups = {}, out = {};
    articles.forEach(function (a) {
      var k = articleKey(a), g = groups[k] || (groups[k] = []);
      for (var c = 0; c < Math.min(4, Math.max(1, a[4] || 1)); c++) g.push(a[3]);
    });
    Object.keys(groups).sort().forEach(function (k) { var s = stats(groups[k]); if (s) out[k] = s; });
    return out;
  }
  // stats for one language at a condition or better, plain copies only (no foil/1st/signed/altered)
  function listingAvg(groups, lang, cond) {
    if (!groups) return null;
    var upTo = CONDS.indexOf(cond || 'NM'), best = null, n = 0, sum = 0;
    for (var k in groups) {
      var p = k.split('|'); if (+p[0] !== lang || p[2] || CONDS.indexOf(p[1]) > upTo) continue;
      var s = groups[k]; n += s[0]; sum += s[3] * s[0]; if (!best || s[1] < best) best = s[1];
    }
    return n ? { n: n, avg: r2(sum / n), min: best } : null;
  }

  function toEur(v, cur, fx) { if (v == null) return null; if (!cur || cur === 'EUR') return v; var r = fx && fx[cur]; return r ? v * r : null; }
  function fromEur(v, cur, fx) { if (v == null) return null; if (!cur || cur === 'EUR') return v; var r = fx && fx[cur]; return r ? v / r : null; }

  // eBay relevance: a title naming a different card number ("4/102" style) is another card
  var GRADED_RE = /\b(PSA|BGS|CGC|SGC|ACE|TAG|BECKETT)\s*-?\s*(10|[1-9](\.5)?)\b/i;
  function isGraded(title) { return GRADED_RE.test(title || ''); }
  function sameCardNumber(title, number) {
    var m = /(?:#|\b)([A-Za-z]*\d+)\s*\/\s*[A-Za-z]*\d+/.exec(title || '');
    if (!m) return true;
    return m[1].replace(/^0+/, '').toLowerCase() === String(number || '').replace(/^0+/, '').toLowerCase();
  }

  // which methods a card has data for: 0..6 plus the flags
  function coverage(has) {
    var flags = METHODS.map(function (m) { return !!has[m[0]]; }), n = 0;
    flags.forEach(function (f) { if (f) n++; });
    return { n: n, flags: flags, tier: TIERS[n] };
  }

  var api = { LANGS: LANGS, CONDS: CONDS, COND_NAMES: COND_NAMES, METHODS: METHODS, TIERS: TIERS, ARTICLE: ARTICLE, stats: stats, aggregateArticles: aggregateArticles, listingAvg: listingAvg,
    toEur: toEur, fromEur: fromEur, isGraded: isGraded, sameCardNumber: sameCardNumber, coverage: coverage, r2: r2 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PRICES = api;
})(typeof window !== 'undefined' ? window : globalThis);
