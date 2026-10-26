/* Picks the right result on Cardmarket and PriceCharting search pages for the POcKEtMONey scraper.
   Pure functions over { href, text } links, injected into the page by background.js and used by the tests.
   `match` comes from the helper's queue (scripts/lib/scrape-plan.js): { name, num, set, ja } (name and set as slugs). */
(function (root) {
  'use strict';
  function slug(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function words(s) { return slug(s).split('-').filter(function (w) { return w.length >= 2; }); }
  function overlap(a, b) { var B = words(b); return words(a).filter(function (w) { return B.indexOf(w) >= 0; }).length; }
  // set name similarity: shared words count, words only the site's set has (like the "2" of "Base Set 2") cost
  var FILLER = ['set', 'pokemon', 'japanese', 'en', 'de', 'fr', 'v1', 'v2'];
  function setScore(ours, theirs) {
    var O = slug(ours).split('-'), T = slug(theirs).split('-').filter(function (w) { return w && FILLER.indexOf(w) < 0; });
    return 2 * T.filter(function (w) { return O.indexOf(w) >= 0; }).length - 2 * T.filter(function (w) { return O.indexOf(w) < 0; }).length;
  }
  function hasNum(s, num) { return new RegExp('(^|[^0-9])0*' + String(num).replace(/[^0-9a-z]/gi, '') + '($|[^0-9])', 'i').test(String(s)); }
  function uniq(list) { var seen = {}; return list.filter(function (l) { var k = l.href.split(/[?#]/)[0]; if (seen[k]) return false; seen[k] = 1; return true; }); }

  // Cardmarket: /<lang>/Pokemon/Products/Singles/<expansion>/<card>; the product id is checked after opening the page
  function cardmarket(links, match) {
    return uniq(links.filter(function (l) { return /\/Pokemon\/Products\/Singles\/[^/]+\/[^/?#]+/.test(l.href); })).map(function (l) {
      var parts = l.href.split(/[?#]/)[0].split('/'), cardSeg = parts[parts.length - 1], expSeg = parts[parts.length - 2];
      var hay = cardSeg + ' ' + l.text, s = 0;
      if (overlap(match.name, hay) < Math.min(1, words(match.name).length)) return null; // must name the card
      s += 3 * overlap(match.name, hay) + setScore(match.set, expSeg);
      if (match.ja !== /japan/i.test(expSeg + ' ' + l.text)) s -= 1;
      return { href: l.href, score: s, num: hasNum(cardSeg, match.num) || hasNum(l.text, match.num) };
    }).filter(Boolean).filter(function (x, i, all) { // results naming the card's number, when there are any
      return x.num || !all.some(function (y) { return y.num; });
    }).sort(function (a, b) { return b.score - a.score; }).slice(0, 4).map(function (x) { return x.href; });
  }

  // PriceCharting: /game/pokemon-<set>/<name>-<number>; Japanese sets are pokemon-japanese-<set>
  function pricecharting(links, match) {
    return uniq(links.filter(function (l) { return /\/game\/pokemon-[^/]+\/[^/?#]+/.test(l.href); })).map(function (l) {
      var parts = l.href.split(/[?#]/)[0].split('/'), product = parts[parts.length - 1], consoleSeg = parts[parts.length - 2];
      if (!new RegExp('-0*' + slug(match.num).replace(/^0+(?=[0-9])/, '') + '$').test(product)) return null;   // number must match
      if (overlap(match.name, product) < 1) return null;                         // and the name
      if (match.ja !== /japanese/.test(consoleSeg)) return null;                 // and the language
      var s = 3 * overlap(match.name, product) + setScore(match.set, consoleSeg.replace(/^pokemon-(japanese-)?/, ''));
      if (/-(?:1st-edition|shadowless|reverse|holo)/.test(product) && !/-(?:1st-edition|shadowless|reverse|holo)/.test(match.name)) s -= 1; // prefer the plain print
      return { href: l.href, score: s };
    }).filter(Boolean).sort(function (a, b) { return b.score - a.score; }).slice(0, 3).map(function (x) { return x.href; });
  }

  // a PriceCharting card page is this card when its URL ends in the number and names it, in the right language
  function pricechartingPageOk(url, match) {
    return pricecharting([{ href: String(url), text: '' }], match).length === 1;
  }

  var api = { cardmarket: cardmarket, pricecharting: pricecharting, pricechartingPageOk: pricechartingPageOk, slug: slug };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PTCG_MATCH = api;
})(typeof window !== 'undefined' ? window : globalThis);
