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
      if (grade(a[11])) return; // a graded copy (the comment names its grade): only in the breakdown, never in raw stats
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

  // ---- grading: which company and which grade a listing or sale is, from its title (and eBay's condition field) ----
  // "PSA 10", "BGS 9.5", "BGS 10 Black Label", "CGC 10 Pristine", "Graded 9" (grade without a named company),
  // "PSA ?" (company without a grade); '' for a raw (ungraded) copy.
  var GRADERS = ['PSA', 'BGS', 'CGC', 'SGC', 'ACE', 'TAG', 'PCA', 'AGS', 'ARS', 'MNT', 'GMA', 'HGA'];
  // short company names that are also ordinary words ("Ace Trainer", "Tag Team") count only in capitals (upperOnly)
  var FILLER = '(?:[\\s\\-:#|/]|gem\\s*(?:mint|mt)|mint|mt|pristine|black\\s*label|grade[ds]?|nm-mt|nm)*';
  var GRADE_NUM = '(10|[1-9](?:[.,]5)?)(?![\\d.,]*\\d)';
  var CO_THEN = new RegExp('\\b(PSA|BGS|BECKETT|CGC|SGC|PCA|ACE|TAG|AGS|ARS|MNT|GMA|HGA)\\b' + FILLER + GRADE_NUM, 'g');
  var NUM_THEN = new RegExp('\\b' + GRADE_NUM + '\\s*(?:gem\\s*mint\\s*)?(PSA|BGS|BECKETT|CGC|SGC|PCA|ACE|TAG|AGS|ARS|MNT|GMA|HGA)\\b', 'g');
  // "PSA 10 candidate", "ready to grade", "not graded": a raw card that mentions grading
  var RAW_HINT = /candidate|kandidat|\bready\b|worthy|potential|possible|to grade|for grading|grading\s*(?:candidate|ready)|ungraded|not graded|non[- ]?grad|nicht\s*gegradet|ungegradet|pre-?grad|\braw\b/i;
  var COND_GRADED = /^(graded|gradiert|gegradet|grad[ée]e?|gradata|calificad|beoordeeld)/i, COND_RAW = /ungraded|nicht\s*gegradet|non\s*grad|ungegradet|no\s*gradad|non\s*classificat/i;
  function upperOnly(co) { return ['ACE', 'TAG', 'AGS', 'ARS', 'MNT', 'GMA', 'HGA'].indexOf(co.toUpperCase()) >= 0; }
  function grade(title, condition) {
    var t = String(title || ''), cond = String(condition || '');
    if (COND_RAW.test(cond)) return '';
    var m, co = '', g = '';
    CO_THEN.lastIndex = 0;
    while ((m = CO_THEN.exec(t.toUpperCase()))) { // upper-cased for matching; capital-only names checked on the original
      var orig = t.substr(m.index, m[1].length);
      if (upperOnly(m[1]) && orig !== m[1]) continue;
      if (m[1] === 'TAG' && /^\s*TEAM/i.test(t.slice(m.index + 3))) continue;
      co = m[1]; g = m[2]; break;
    }
    if (!co) {
      NUM_THEN.lastIndex = 0;
      while ((m = NUM_THEN.exec(t.toUpperCase()))) {
        var o2 = t.substr(m.index + m[0].length - m[2].length, m[2].length);
        if (upperOnly(m[2]) && o2 !== m[2]) continue;
        co = m[2]; g = m[1]; break;
      }
    }
    if (co && RAW_HINT.test(t) && !COND_GRADED.test(cond)) return '';
    if (!co) {
      if (!COND_GRADED.test(cond)) return '';
      var bare = /\b(?:grade|graded|gem\s*mint|mint)\s*(10|[1-9](?:[.,]5)?)\b/i.exec(t);
      return 'Graded ' + (bare ? bare[1].replace(',', '.') : '?');
    }
    if (co === 'BECKETT') co = 'BGS';
    g = g.replace(',', '.');
    var extra = co === 'BGS' && g === '10' && /black\s*label/i.test(t) ? ' Black Label' : co === 'CGC' && g === '10' && /pristine/i.test(t) ? ' Pristine' : '';
    return co + ' ' + g + extra;
  }
  function isGraded(title, condition) { return grade(title, condition) !== ''; }
  // grade label of a PriceCharting sales tab, for sales whose title names no company
  var PC_TAB = { 'Ungraded': '', 'Grade 7': 'Graded 7', 'Grade 8': 'Graded 8', 'Grade 9': 'Graded 9', 'Grade 9.5': 'Graded 9.5', 'PSA 10': 'PSA 10' };
  // ordering of grade labels: raw first, then highest grade, then company
  function gradeOrder(a, b) {
    if (!a || !b) return a ? 1 : b ? -1 : 0;
    var lvl = function (g) { return (parseFloat(g.split(' ')[1]) || 0) + (/Black Label/.test(g) ? 0.2 : /Pristine/.test(g) ? 0.1 : 0); }; // the premium 10s first
    var na = lvl(a), nb = lvl(b);
    if (na !== nb) return nb - na;
    var ca = GRADERS.indexOf(a.split(' ')[0]), cb = GRADERS.indexOf(b.split(' ')[0]);
    return (ca < 0 ? 99 : ca) - (cb < 0 ? 99 : cb) || (a < b ? -1 : a > b ? 1 : 0);
  }

  // ---- language of a listing from its title (Cardmarket language ids); 0 when the title doesn't say ----
  var TITLE_LANGS = [
    [7, /japanese|\bjapan\b|japanisch|japonais|giappones|japon[eé]s|\bjpn?\b|日本語|日本版/i],
    [10, /korean|koreanisch|cor[ée]en|coreano|\bkor\b|한국/i],
    [11, /traditional chinese|t-chinese|繁體|繁体/i],
    [6, /chinese|chinesisch|chinois|cinese|\bchn\b|简体|中文/i],
    [3, /\bgerman\b|deutsch|\bdeu\b|\bger\b|allemand|tedesco|alem[aá]n/i],
    [2, /\bfrench\b|fran[cç]ais|franz[öo]sisch|\bfra\b|\bvf\b|francese|franc[eé]s/i],
    [5, /italian|italiano|italienisch|\bita\b|\bitalien\b/i],
    [4, /spanish|espa[ñn]ol|spanisch|\besp\b|castellano|espagnol|spagnolo/i],
    [8, /portugu[eê]se?|portugiesisch|\bpt-?br\b/i],
    [12, /\bdutch\b|nederlands|niederl[äa]ndisch|n[ée]erlandais/i],
    [13, /\bpolish\b|polski|polnisch/i],
    [9, /russian|russisch|русск/i],
    [1, /english|englisch|anglais|inglese|ingl[eé]s|\beng\b/i]
  ];
  function titleLang(title) {
    var t = String(title || '');
    for (var i = 0; i < TITLE_LANGS.length; i++) if (TITLE_LANGS[i][1].test(t)) return TITLE_LANGS[i][0];
    return 0;
  }

  // ---- the breakdown: every price observation of a card, grouped by source, for sale / sold, language and grade ----
  // key "<source>|<L for sale, S sold>|<language id, 0 unknown>|<grade label, '' raw>" -> [n, min, median, avg, max] EUR
  // sources: cm Cardmarket, ct CardTrader, eb eBay, pc PriceCharting
  var SEG_SOURCES = { cm: 'Cardmarket', ct: 'CardTrader', eb: 'eBay', pc: 'PriceCharting' };
  var SEG_KEY = /^(cm|ct|eb|pc)\|[LS]\|\d{1,2}\|(|(PSA|BGS|CGC|SGC|ACE|TAG|PCA|AGS|ARS|MNT|GMA|HGA|Graded) (10|[1-9](\.5)?|\?)( Black Label| Pristine)?)$/;
  function segKey(src, kind, lang, g) { return src + '|' + kind + '|' + (lang || 0) + '|' + (g || ''); }
  // obs: [key, EUR price, quantity]
  function segments(obs) {
    var groups = {}, out = {};
    obs.forEach(function (o) { if (!(o[1] > 0)) return; var g = groups[o[0]] || (groups[o[0]] = []); for (var c = 0; c < Math.min(4, Math.max(1, o[2] || 1)); c++) g.push(o[1]); });
    Object.keys(groups).sort().forEach(function (k) { var st = stats(groups[k]); if (st) out[k] = st; });
    return out;
  }
  // Cardmarket / CardTrader article rows (all listings): plain copies only, like listingAvg (reverse holo, 1st edition,
  // signed and altered copies stay in the condition matrix); a comment naming a grade makes it a graded copy
  function obsArticles(src, articles) {
    return (articles || []).filter(function (a) { return !(a[5] || a[6] || a[7] || a[8]); })
      .map(function (a) { return [segKey(src, 'L', a[1], grade(a[11])), a[3], a[4]]; });
  }
  // eBay item rows [id, title, price, currency, condition, marketplace, date, image, url, kind, bids/qty, country, graded];
  // language from the title, else `defaultLang(marketplace, title)` (scripts/lib/ebay.js: the card name used, the search language)
  function obsEbay(active, sold, fx, defaultLang) {
    function row(kind) { return function (r) {
      var lang = titleLang(r[1]) || (defaultLang ? defaultLang(r[5], r[1]) : 0);
      return [segKey('eb', kind, lang, grade(r[1], r[4])), toEur(r[2], r[3], fx), kind === 'S' ? r[10] || 1 : 1];
    }; }
    return (active || []).map(row('L')).concat((sold || []).map(row('S')));
  }
  // PriceCharting sales [date, tab, title, price USD, url]; every sale on a card's page is in that card's language
  function obsPricecharting(sold, lang, fx) {
    return (sold || []).map(function (r) {
      var g = grade(r[2]); if (!g && PC_TAB[r[1]] != null) g = PC_TAB[r[1]];
      return [segKey('pc', 'S', lang, g), toEur(r[3], 'USD', fx), 1];
    });
  }
  // replaces one source's part of a card's breakdown
  function setSegments(entry, src, obs) {
    var b = entry.b || {};
    Object.keys(b).forEach(function (k) { if (k.slice(0, src.length + 1) === src + '|') delete b[k]; });
    var add = segments(obs); for (var k in add) b[k] = add[k];
    if (Object.keys(b).length) entry.b = b; else delete entry.b;
  }
  // the breakdown merged across sources (and prints): { "<L|S>|<lang>|<grade>": { n, med, min, max, src: {cm: stats…} } }
  // med is exact for one source, else the n-weighted mean of the sources' medians (approx: true)
  function mergeSegments(list) {
    var out = {};
    (list || []).forEach(function (b) {
      for (var k in b || {}) {
        var p = k.split('|'), key = p[1] + '|' + p[2] + '|' + p[3], s = b[k], c = out[key];
        if (!c) c = out[key] = { kind: p[1], lang: +p[2], grade: p[3], n: 0, w: 0, min: null, max: null, src: {} };
        c.n += s[0]; c.w += s[2] * s[0];
        c.min = c.min == null ? s[1] : Math.min(c.min, s[1]); c.max = c.max == null ? s[4] : Math.max(c.max, s[4]);
        var prev = c.src[p[0]]; c.src[p[0]] = prev ? [prev[0] + s[0], Math.min(prev[1], s[1]), (prev[2] * prev[0] + s[2] * s[0]) / (prev[0] + s[0]), null, Math.max(prev[4], s[4])] : s;
      }
    });
    for (var k2 in out) { var c2 = out[k2], parts = 0; for (var x in c2.src) parts++; c2.med = r2(c2.w / c2.n); c2.approx = parts > 1; delete c2.w; }
    return out;
  }
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
    toEur: toEur, fromEur: fromEur, isGraded: isGraded, sameCardNumber: sameCardNumber, coverage: coverage, r2: r2,
    grade: grade, gradeOrder: gradeOrder, PC_TAB: PC_TAB, GRADERS: GRADERS, titleLang: titleLang, SEG_SOURCES: SEG_SOURCES, SEG_KEY: SEG_KEY, segKey: segKey, segments: segments,
    obsArticles: obsArticles, obsEbay: obsEbay, obsPricecharting: obsPricecharting, setSegments: setSegments, mergeSegments: mergeSegments };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PRICES = api;
})(typeof window !== 'undefined' ? window : globalThis);
