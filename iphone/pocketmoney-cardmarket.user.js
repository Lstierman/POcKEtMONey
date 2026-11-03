// ==UserScript==
// @name         POcKEtMONey · Cardmarket
// @namespace    https://github.com/Lstierman/POcKEtMONey
// @version      1.0.0
// @description  Reads every Cardmarket offer of a card in Safari on your iPhone, shows it per language and condition, and saves it to POcKEtMONey.
// @author       POcKEtMONey
// @match        https://www.cardmarket.com/*
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      api.github.com
// @connect      raw.githubusercontent.com
// @connect      prices.pokemontcg.io
// @run-at       document-idle
// @inject-into  content
// @updateURL    https://raw.githubusercontent.com/Lstierman/POcKEtMONey/main/iphone/pocketmoney-cardmarket.user.js
// @downloadURL  https://raw.githubusercontent.com/Lstierman/POcKEtMONey/main/iphone/pocketmoney-cardmarket.user.js
// ==/UserScript==
//
// How it works (see iphone/README.md for setup):
//  - Runs inside Safari on cardmarket.com, so every request is a normal request from your phone, with your cookies:
//    no robot checks to fight. Pages are fetched from the page you are on and read without rendering.
//  - A product page shows only its cheapest offers (about 50). To get the rest it opens filtered views of the same
//    product (price floor, language, seller country, minimum condition). Every view is CHECKED against what its rows
//    really show: a view for "Japanese" whose rows are English means Cardmarket ignored that filter, so the view is
//    not trusted (the old scraper trusted those and stored wrong coverage). A view whose rows all match its filter is
//    exactly that filter's cheapest offers, whether or not Cardmarket applied it, so nothing is ever mis-filed.
//  - What it read is kept in an outbox on the phone and committed in batches to the `inbox` branch of your
//    repository; the "Ingest phone captures" workflow files it into the price store (prices branch) with the same
//    validation as everything else, and empties the inbox.
(function () {
  'use strict';
  var VERSION = '1.0.0';

  // ===================================================================================================== core
  // (pure functions; loaded by test/iphone.test.js under Node)
  var LANGS = { 1: 'English', 2: 'French', 3: 'German', 4: 'Spanish', 5: 'Italian', 6: 'S-Chinese', 7: 'Japanese', 8: 'Portuguese', 9: 'Russian', 10: 'Korean', 11: 'T-Chinese', 12: 'Dutch', 13: 'Polish' };
  var LANG_IDS = { english: 1, french: 2, german: 3, spanish: 4, italian: 5, 's-chinese': 6, 'simplified chinese': 6, 'chinese (s)': 6, japanese: 7, portuguese: 8, russian: 9, korean: 10, 't-chinese': 11, 'traditional chinese': 11, 'chinese (t)': 11, dutch: 12, polish: 13 };
  var CONDS = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];
  var COND_WORDS = [['near mint', 'NM'], ['mint', 'MT'], ['excellent', 'EX'], ['lightly played', 'LP'], ['light played', 'LP'], ['good', 'GD'], ['played', 'PL'], ['poor', 'PO']];
  var CUR = [[/EUR|€/, 'EUR'], [/GBP|£/, 'GBP'], [/CHF/, 'CHF'], [/US\s?\$|USD|\$/, 'USD']];

  function txt(el) { return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
  function tip(el) { return el ? el.getAttribute('aria-label') || el.getAttribute('data-bs-original-title') || el.getAttribute('data-original-title') || el.getAttribute('title') || '' : ''; }
  function all(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }

  // "1.234,56 €", "1,234.56 €", "12,50 €" -> 1234.56 / 12.5
  function parsePrice(text) {
    var s = String(text || ''), m = /(\d[\d.,\s ]*)/.exec(s); if (!m) return null;
    var n = m[1].replace(/[\s ]/g, ''), dec = /[.,](\d{1,2})$/.exec(n);
    n = dec ? n.slice(0, -dec[0].length).replace(/[.,]/g, '') + '.' + dec[1] : n.replace(/[.,]/g, '');
    var v = parseFloat(n);
    if (!(v > 0)) return null;
    for (var i = 0; i < CUR.length; i++) if (CUR[i][0].test(s) && CUR[i][1] !== 'EUR') return null; // only euro prices
    return Math.round(v * 100) / 100;
  }
  function condOf(row) {
    var el = row.querySelector('.article-condition'), m;
    if (el && (m = /condition-(mt|nm|ex|gd|lp|pl|po)\b/i.exec(el.className || ''))) return m[1].toUpperCase();
    var badge = txt(row.querySelector('.article-condition .badge, .article-condition, .badge'));
    if ((m = /\b(MT|NM|EX|GD|LP|PL|PO)\b/.exec(badge))) return m[1];
    var t = (tip(el) + ' ' + all(row, '.product-attributes [aria-label], .product-attributes [data-bs-original-title], .product-attributes [title]').map(tip).join(' ')).toLowerCase();
    for (var i = 0; i < COND_WORDS.length; i++) if (t.indexOf(COND_WORDS[i][0]) >= 0) return COND_WORDS[i][1];
    return '??';
  }
  var TIP_SEL = '[aria-label], [data-bs-original-title], [data-original-title], [title]';
  // one offer row -> PRICES.ARTICLE: [idArticle, lang, cond, price, count, reverse holo, signed, 1st edition, altered, country, seller, comment, idProduct]
  function parseRow(row, idProduct, n) {
    var id = +String(row.id || '').replace(/\D/g, '') || 0;
    var attrs = row.querySelector('.product-attributes') || row;
    var attrTips = all(attrs, TIP_SEL).map(tip).filter(Boolean), tips = all(row, TIP_SEL).map(tip).filter(Boolean);
    var lang = 0, country = '', f = 0, s = 0, one = 0, alt = 0;
    attrTips.concat(tips).forEach(function (t) { var k = t.toLowerCase().trim(); if (!lang && LANG_IDS[k]) lang = LANG_IDS[k]; });
    attrTips.forEach(function (t) {
      var k = t.toLowerCase();
      if (/reverse/.test(k)) f = 1;
      if (/signed/.test(k)) s = 1;
      if (/first edition|1st edition/.test(k)) one = 1;
      if (/altered/.test(k)) alt = 1;
    });
    tips.forEach(function (t) { var c = /(item location|artikelstandort|localisation|ubicación|posizione)\s*:\s*(.+)/i.exec(t); if (c && !country) country = c[2].trim(); });
    var price = null, sels = ['.col-offer .price-container .color-primary', '.price-container .color-primary', '.price-container span', '.mobile-offer-container .color-primary', '.col-offer [class*="price"]'];
    for (var i = 0; i < sels.length && price == null; i++) { var el = row.querySelector(sels[i]); if (el) price = parsePrice(txt(el)); }
    if (price == null) { var mm = (txt(row.querySelector('.col-offer') || row).match(/\d[\d.,]*\s*€/) || [])[0]; price = mm ? parsePrice(mm) : null; }
    if (price == null) return null;
    var qty = +((txt(row.querySelector('.amount-container .item-count, .item-count')).match(/\d+/) || [1])[0]) || 1;
    var seller = txt(row.querySelector('.seller-name a[href*="/Users/"], a[href*="/Users/"]'));
    var comment = txt(row.querySelector('.product-comments')).slice(0, 120);
    return [id || n + 1, lang, condOf(row), price, qty, f, s, one, alt, country, seller, comment, idProduct || 0];
  }
  // the product box: "Available items 412", "From 0,02 €", "Price Trend 1,23 €", "30-days average price" …
  function parseInfo(doc) {
    var raw = {};
    all(doc, 'dl dt').forEach(function (dt) { var dd = dt.nextElementSibling; if (dd && dd.tagName === 'DD') raw[txt(dt).replace(/:$/, '')] = txt(dd); });
    var pick = function (re, num) { for (var k in raw) if (re.test(k.toLowerCase())) return num ? +(raw[k].replace(/\D/g, '')) || 0 : parsePrice(raw[k]); return null; };
    return { available: pick(/available items/, true), from: pick(/^from/), trend: pick(/price trend/), avg30: pick(/30.?days/), avg7: pick(/7.?days/), avg1: pick(/1.?day/), raw: raw };
  }
  function hasLoadMore(doc) {
    return all(doc, 'button, a.btn, #loadMore, [id*="loadMore"], [id*="loadmore"]').some(function (b) {
      return /load more|show more|loadMore/i.test((b.id || '') + ' ' + b.textContent) && !b.disabled && !(b.closest && b.closest('.d-none, [hidden], [style*="display: none"], [style*="display:none"]'));
    });
  }
  var PAGE = 50; // a product page renders this many offers before "load more"
  function productId(doc) {
    var inp = doc.querySelector('input[name="idProduct"]'); if (inp && +inp.value) return +inp.value;
    var html = doc.documentElement.innerHTML, m = /idProduct["'\s:=]+(\d{4,})/.exec(html) || /[?&]idProduct=(\d+)/.exec(html);
    return m ? +m[1] : 0;
  }
  // the filter form's fields: which languages and seller countries this product can be filtered by
  function formOptions(doc) {
    var out = { languages: [], countries: [], fields: [] }, seen = {};
    all(doc, 'form input[name], form select[name]').forEach(function (el) {
      var name = el.getAttribute('name') || ''; if (!seen[name]) { seen[name] = 1; out.fields.push(name); }
      var low = name.toLowerCase();
      if (/language/.test(low)) {
        var br = /\[(\d+)\]/.exec(name), v = /^\d+$/.test(el.value || '') ? +el.value : br ? +br[1] : 0;
        if (v >= 1 && v <= 13 && out.languages.indexOf(v) < 0) out.languages.push(v);
        all(el, 'option').forEach(function (o) { var n = +o.value; if (n >= 1 && n <= 13 && out.languages.indexOf(n) < 0) out.languages.push(n); });
      }
      if (/sellercountry/.test(low)) all(el, 'option').forEach(function (o) { var n = +o.value; if (n > 0) out.countries.push([n, txt(o)]); });
    });
    return out;
  }
  function parseProduct(doc) {
    var idProduct = productId(doc), rows = all(doc, '[id^="articleRow"]');
    if (!rows.length) rows = all(doc, '.article-row');
    var seen = {}, articles = [];
    rows.forEach(function (row, n) {
      var a = parseRow(row, idProduct, n); if (!a) return;
      if (seen[a[0]]) return; seen[a[0]] = 1; articles.push(a);
    });
    var h1 = doc.querySelector('h1');
    return { idProduct: idProduct, title: h1 ? txt(h1.firstChild && h1.firstChild.nodeType === 3 ? h1.firstChild : h1) || txt(h1) : '', articles: articles, rows: rows.length,
      more: hasLoadMore(doc) || rows.length >= PAGE, info: parseInfo(doc), form: formOptions(doc), sampleRow: rows[0] ? rows[0].outerHTML.slice(0, 4000) : '' };
  }
  function isBlocked(status, html) {
    return (status === 403 || status === 503 || /challenge-platform|cf-turnstile|<title>\s*(just a moment|attention required)|verify you are a human/i.test(html.slice(0, 30000))) && !/articleRow/.test(html);
  }

  // ---------- the views of one product and how they are checked ----------
  function qs(params) { var k = Object.keys(params).sort(), q = k.map(function (x) { return encodeURIComponent(x) + '=' + encodeURIComponent(params[x]); }).join('&'); return q ? '?' + q : ''; }
  function offerKey(a) { return a[0] > 99999 ? 'id' + a[0] : JSON.stringify(a.slice(1, 12)); }
  // A view is trusted when every row it shows satisfies its filter (rows whose value can't be read don't count
  // against it). Such a view holds exactly the cheapest offers of that filter: if Cardmarket ignored the filter, the
  // cheapest offers of the whole product happened to match it, and they are then also the filter's cheapest.
  function viewOk(params, arts, ctx) {
    for (var i = 0; i < arts.length; i++) {
      var a = arts[i];
      if (params.language && a[1] && a[1] !== +params.language) return false;
      if (params.minCondition && CONDS.indexOf(a[2]) >= 0 && CONDS.indexOf(a[2]) + 1 > +params.minCondition) return false;
      if (ctx.priceParam && params[ctx.priceParam] != null && a[3] < +params[ctx.priceParam] - 0.005) return false;
      if (params.sellerCountry && a[9] && ctx.countryName && ctx.countryName[params.sellerCountry] && a[9] !== ctx.countryName[params.sellerCountry]) return false;
    }
    return true;
  }
  function cheapest(arts, n) { return arts.map(function (a) { return a[3]; }).sort(function (x, y) { return x - y; }).slice(0, n); }

  // Reads every offer of one product it can reach. fetchView(params) -> { articles, more, idProduct, title, info, form }.
  // opts: { maxViews, priceParams: ['minPrice', …] to try (or the one known to work), ja, onStep(text) }
  // Returns { idProduct, title, info, articles, coverage: [[lang, minCondition, offers, complete]], complete, diag }.
  async function scanProduct(fetchView, opts) {
    opts = opts || {};
    var offers = new Map(), coverage = [], max = opts.maxViews || 60, step = opts.onStep || function () {};
    var ctx = { priceParam: null, countryName: {} };
    var diag = { views: 0, untrusted: [], priceParam: null, priceTried: [], dims: {} };
    var budgetHit = false;
    async function view(params) {
      if (diag.views >= max) { budgetHit = true; return null; }
      diag.views++;
      var v = await fetchView(params);
      if (!v) return null;
      v.articles.forEach(function (a) { offers.set(offerKey(a), a); }); // real offers of this product, whatever the filter did
      v.ok = viewOk(params, v.articles, ctx);
      if (!v.ok) diag.untrusted.push(qs(params));
      return v;
    }
    var first = await view({});
    if (!first) throw new Error('could not read the product page');
    var res = { idProduct: first.idProduct, title: first.title, info: first.info, form: first.form };
    (first.form.countries || []).forEach(function (c) { ctx.countryName[c[0]] = c[1]; });
    var cov = function (params, n, done) { coverage.push([+params.language || 0, +params.minCondition || 0, n, done ? 1 : 0]); };

    // price floor paging: the view from the highest price seen so far up, repeated until a page is not cut off
    var priceState = { known: opts.priceParam || null, candidates: (opts.priceParams || ['minPrice']).slice(), broken: false };
    if (!priceState.known && !priceState.candidates.length) priceState.broken = true;
    async function pricePaging(params, v) {
      if (priceState.broken) return false;
      var seen = new Set(v.articles.map(offerKey)), last = v;
      for (var page = 0; last.more && page < 40; page++) {
        var floor = Math.max.apply(null, last.articles.map(function (a) { return a[3]; }));
        if (!priceState.known) { // find the parameter name the first time it is needed
          var found = null;
          while (priceState.candidates.length && !found) {
            var name = priceState.candidates.shift(); diag.priceTried.push(name);
            ctx.priceParam = name;
            var p0 = Object.assign({}, params); p0[name] = floor;
            var t = await view(p0); if (!t) return false;
            var fresh = t.articles.some(function (a) { return !seen.has(offerKey(a)); });
            if (t.ok && fresh && t.articles.length) { found = name; last = t; }
          }
          if (!found) { priceState.broken = true; ctx.priceParam = null; diag.priceParam = 'none'; return false; }
          priceState.known = found; diag.priceParam = found;
        } else {
          ctx.priceParam = priceState.known;
          var p = Object.assign({}, params); p[priceState.known] = floor;
          step('price from ' + floor.toFixed(2) + ' €');
          last = await view(p); if (!last) return false;
          if (!last.ok) { priceState.broken = true; diag.priceParam = 'ignored'; return false; }
        }
        var added = last.articles.filter(function (a) { return !seen.has(offerKey(a)); });
        if (!added.length) return false; // more offers at exactly this price than one page holds
        added.forEach(function (a) { seen.add(offerKey(a)); });
      }
      if (last.more) return false;
      cov(params, seen.size, true); return true;
    }

    // exact partitions (each offer is in exactly one value), tried in this order
    var dims = [
      { name: 'language', values: function (v) {
        var vals = (res.form.languages && res.form.languages.length ? res.form.languages : opts.ja ? [7] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]).slice();
        v.articles.forEach(function (a) { if (a[1] && vals.indexOf(a[1]) < 0) vals.push(a[1]); });
        return vals;
      } },
      { name: 'sellerCountry', values: function () { return (res.form.countries || []).map(function (c) { return c[0]; }); } }
    ];
    // returns true when everything under params was read
    async function cover(params, v, d) {
      if (!v.more) { cov(params, v.articles.length, true); return true; }
      if (await pricePaging(params, v)) return true;
      for (; d < dims.length; d++) {
        var dim = dims[d], st = diag.dims[dim.name] = diag.dims[dim.name] || { trusted: 0, untrusted: 0 };
        if (dim.broken || params[dim.name] != null) continue;
        var vals = dim.values(v); if (!vals.length) continue;
        var done = true, used = 0, ignored = 0, parentKeys = v.articles.map(offerKey).sort().join('|');
        for (var i = 0; i < vals.length; i++) {
          var p = Object.assign({}, params); p[dim.name] = vals[i];
          step((dim.name === 'language' ? LANGS[vals[i]] || 'language ' + vals[i] : ctx.countryName[vals[i]] || dim.name + ' ' + vals[i]));
          var w = await view(p);
          if (!w) { done = false; break; }
          if (!w.ok) { // Cardmarket didn't filter by this value: what it showed is kept, but not trusted
            st.untrusted++;
            // the exact unfiltered list back means Cardmarket doesn't offer this value here (a Japanese filter on an
            // English print); once other values of the filter work, that value has no offers to miss
            if (w.articles.map(offerKey).sort().join('|') === parentKeys) ignored++; else done = false;
            continue;
          }
          st.trusted++; used++;
          if (!(await cover(p, w, d + 1))) done = false;
        }
        if (used) { if (ignored) st.ignoredValues = (st.ignoredValues || 0) + ignored; return done; }
        dim.broken = true; // no value of this filter worked: try the next kind
      }
      // nothing left to split by: the cheapest offers per minimum condition ("this or better")
      var prev = JSON.stringify(cheapest(v.articles, PAGE));
      for (var c = 1; c <= 6; c++) {
        var pc = Object.assign({}, params, { minCondition: c });
        step((params.language ? LANGS[params.language] + ', ' : '') + CONDS[c - 1] + ' or better');
        var x = await view(pc); if (!x) break;
        if (!x.ok) continue;
        cov(pc, x.articles.length, !x.more);
        if (x.more && JSON.stringify(cheapest(x.articles, PAGE)) === prev) break; // same as the unfiltered view: worse conditions add nothing new
      }
      cov(params, v.articles.length, false);
      return false;
    }
    var complete = await cover({}, first, 0);
    res.articles = Array.from(offers.values());
    res.coverage = coverage; res.complete = complete && !budgetHit;
    diag.budgetHit = budgetHit; diag.offers = res.articles.length;
    res.diag = diag;
    return res;
  }

  // ---------- statistics for the sheet ----------
  function stats(prices) {
    var p = prices.slice().sort(function (a, b) { return a - b; }), n = p.length; if (!n) return null;
    var med = n % 2 ? p[(n - 1) / 2] : (p[n / 2 - 1] + p[n / 2]) / 2, cut = Math.floor(n * 0.1), t = p.slice(cut, n - cut || n);
    return { n: n, min: p[0], median: Math.round(med * 100) / 100, avg: Math.round(t.reduce(function (s, x) { return s + x; }, 0) / t.length * 100) / 100, max: p[n - 1] };
  }
  // language -> condition -> { n (copies), min }, plus per-language stats
  function matrix(arts) {
    var m = {};
    arts.forEach(function (a) {
      if (a[6] || a[8]) return; // signed / altered copies are their own thing
      var L = m[a[1]] = m[a[1]] || { cells: {}, prices: [] }, c = L.cells[a[2]] = L.cells[a[2]] || { n: 0, min: Infinity };
      c.n += a[4]; c.min = Math.min(c.min, a[3]);
      if (a[2] === 'NM' || a[2] === 'MT') for (var k = 0; k < Math.min(a[4], 20); k++) L.prices.push(a[3]);
    });
    Object.keys(m).forEach(function (l) { m[l].nm = stats(m[l].prices); delete m[l].prices; });
    return m;
  }

  var CORE = { parsePrice: parsePrice, parseRow: parseRow, parseInfo: parseInfo, parseProduct: parseProduct, formOptions: formOptions, viewOk: viewOk, scanProduct: scanProduct,
    stats: stats, matrix: matrix, qs: qs, isBlocked: isBlocked, offerKey: offerKey, LANGS: LANGS, CONDS: CONDS, VERSION: VERSION };
  if (typeof module !== 'undefined' && module.exports) { module.exports = CORE; return; }
  if (typeof document === 'undefined' || window.top !== window.self) return;

  // =============================================================================================== on the phone
  var DEFAULTS = { repo: 'Lstierman/POcKEtMONey', token: '', autoScan: false, gap: 1.5, maxViews: 60, watchStaleHours: 24 };
  var hasGM = typeof GM !== 'undefined' && GM && typeof GM.getValue === 'function';
  async function getVal(k, d) {
    try { if (hasGM) { var v = await GM.getValue(k); return v === undefined ? d : JSON.parse(v); } var s = localStorage.getItem('pm.' + k); return s == null ? d : JSON.parse(s); } catch (e) { return d; }
  }
  async function setVal(k, v) { var s = JSON.stringify(v); try { if (hasGM) await GM.setValue(k, s); else localStorage.setItem('pm.' + k, s); } catch (e) { console.warn('POcKEtMONey: could not store ' + k, e); } }
  async function settings() { return Object.assign({}, DEFAULTS, await getVal('settings', {})); }

  // cross-origin requests (GitHub, pokemontcg.io) through the userscript manager, else fetch
  function xhr(o) {
    if (hasGM && typeof GM.xmlHttpRequest === 'function') return new Promise(function (ok, no) {
      GM.xmlHttpRequest({ method: o.method || 'GET', url: o.url, headers: o.headers || {}, data: o.body, responseType: o.type === 'buffer' ? 'arraybuffer' : 'text',
        onload: function (r) { ok({ status: r.status, url: r.finalUrl || o.url, body: o.type === 'buffer' ? r.response : r.responseText }); },
        onerror: function () { no(new Error('network error: ' + o.url)); }, ontimeout: function () { no(new Error('timeout: ' + o.url)); } });
    });
    return fetch(o.url, { method: o.method || 'GET', headers: o.headers, body: o.body }).then(function (r) {
      return (o.type === 'buffer' ? r.arrayBuffer() : r.text()).then(function (b) { return { status: r.status, url: r.url, body: b }; });
    });
  }
  async function gunzipJson(buf) {
    var ds = new DecompressionStream('gzip'), s = new Blob([buf]).stream().pipeThrough(ds);
    return JSON.parse(await new Response(s).text());
  }

  // ---------- Cardmarket requests: one at a time, a human-like pace ----------
  var lastReq = 0, gapMul = 1, stopFlag = false;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  async function cmFetch(url, gap) {
    for (var attempt = 0; attempt < 4; attempt++) {
      var wait = lastReq + gap * 1000 * gapMul * (0.7 + Math.random() * 0.6) - Date.now();
      if (wait > 0) await sleep(wait);
      if (stopFlag) throw new StopError();
      lastReq = Date.now();
      var r = await fetch(url, { credentials: 'include', headers: { Accept: 'text/html,application/xhtml+xml' } });
      var html = await r.text();
      if (r.status === 429) { gapMul = Math.min(8, gapMul * 2); ui.note('Cardmarket asks to slow down: waiting a minute'); await sleep(60e3); continue; }
      if (isBlocked(r.status, html)) throw new BlockedError();
      return { url: r.url, status: r.status, html: html };
    }
    throw new Error('Cardmarket keeps answering "too many requests"');
  }
  function StopError() { this.message = 'stopped'; } StopError.prototype = Object.create(Error.prototype);
  function BlockedError() { this.message = 'Cardmarket wants a check: reload this page, complete it, then try again'; } BlockedError.prototype = Object.create(Error.prototype);
  function parseHtml(html, url) {
    var doc = new DOMParser().parseFromString(html, 'text/html'), base = doc.createElement('base'); base.href = url;
    (doc.head || doc.documentElement).prepend(base); return doc;
  }
  // product URLs are read in English, whatever language the site is set to, so names and tooltips are predictable
  function enUrl(u) { var x = new URL(u, location.href); x.pathname = x.pathname.replace(/^\/[a-z]{2}\//, '/en/'); x.search = ''; x.hash = ''; return x.href; }
  var isProductUrl = function (u) { return /\/Pokemon\/Products\/Singles\/[^/]+\/[^/?#]+/.test(new URL(u, location.href).pathname); };

  async function scanUrl(url, onStep) {
    var s = await settings(), base = enUrl(url), known = await getVal('priceParam', null), sample = '';
    var fresh = known && known.at > Date.now() - 7 * 864e5; // the price parameter that works (or 'none'), re-checked weekly
    var found = {}; // every product page read: its id -> address, so the watch-list run finds it next time
    var res = await scanProduct(async function (params) {
      var r = await cmFetch(base + qs(params), s.gap), p = parseProduct(parseHtml(r.html, r.url));
      if (!sample) sample = p.sampleRow;
      if (p.idProduct) found[p.idProduct] = r.url.split('?')[0];
      return p;
    }, { maxViews: s.maxViews, priceParam: fresh && known.name !== 'none' ? known.name : null, priceParams: fresh ? [] : ['minPrice', 'priceMin'], onStep: onStep });
    if (res.diag.priceTried.length || res.diag.priceParam === 'ignored') await setVal('priceParam', { name: res.diag.priceParam === 'ignored' ? 'none' : res.diag.priceParam, at: Date.now() });
    var urls = await getVal('urls', {}); Object.assign(urls, found); await setVal('urls', urls);
    res.url = base; res.sampleRow = sample;
    return res;
  }

  // ---------- POcKEtMONey: card map, To watch list, outbox -> inbox branch ----------
  var RAW = function (repo, branch, file) { return 'https://raw.githubusercontent.com/' + repo + '/' + branch + '/' + file; };
  var mapCache = null;
  async function cardMap() {
    if (mapCache) return mapCache;
    var s = await settings(), r = await xhr({ url: RAW(s.repo, 'main', 'data/card-map.json.gz'), type: 'buffer' });
    if (r.status !== 200) throw new Error('card map: HTTP ' + r.status);
    var m = await gunzipJson(r.body), byId = new Map(), byCm = {};
    m.cards.forEach(function (c) { if (!c[6].length) return; byId.set(c[0], c); c[6].forEach(function (p) { byCm[p[0]] = c[0]; }); });
    await setVal('byCm', { at: Date.now(), map: byCm });
    return (mapCache = { byId: byId, byCm: byCm });
  }
  async function cardOf(idProduct) { // product id -> card id, from a cached index (refreshed daily)
    var c = await getVal('byCm', null);
    if (!c || Date.now() - c.at > 864e5) { try { c = { map: (await cardMap()).byCm }; } catch (e) { if (!c) return null; } }
    return c.map[idProduct] || null;
  }
  async function rawJson(file) {
    var s = await settings(), r = await xhr({ url: RAW(s.repo, 'prices', file) + '?t=' + Date.now() });
    if (r.status !== 200) throw new Error(file + ': HTTP ' + r.status);
    return JSON.parse(r.body);
  }

  async function queueCapture(res, cardId) {
    var at = new Date().toISOString(), out = await getVal('outbox', []);
    var cap = { v: 1, site: 'cardmarket', via: 'iphone', version: VERSION, at: at, url: res.url, cardId: cardId || undefined,
      data: { idProduct: res.idProduct, title: res.title, articles: res.articles, found: res.articles.length, coverage: res.coverage, complete: res.complete, available: res.info.available || null },
      info: { from: res.info.from, trend: res.info.trend, avg30: res.info.avg30, avg7: res.info.avg7, avg1: res.info.avg1 } };
    out.push({ path: 'cardmarket/' + at.slice(0, 10) + '/' + at.replace(/[-:.]/g, '').slice(0, 15) + '-' + res.idProduct + '-' + Math.random().toString(36).slice(2, 6) + '.json', content: JSON.stringify(cap) });
    await setVal('outbox', out);
    ui.outbox(out.length);
    flushSoon(out.length >= 5 ? 1000 : 20e3);
  }
  var flushTimer = null, flushing = null;
  function flushSoon(ms) { clearTimeout(flushTimer); flushTimer = setTimeout(function () { flush().catch(function (e) { ui.note('Not sent yet: ' + e.message); }); }, ms); }
  async function gh(s, method, path, body) {
    var r = await xhr({ method: method, url: 'https://api.github.com/repos/' + s.repo + path, body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: 'Bearer ' + s.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' } });
    var data = null; try { data = r.body ? JSON.parse(r.body) : null; } catch (e) {}
    return { status: r.status, data: data };
  }
  // commits the whole outbox to the inbox branch in one commit (git data API), then asks the workflow to run
  async function flush() {
    if (flushing) return flushing;
    flushing = (async function () {
      var s = await settings(), out = await getVal('outbox', []);
      if (!out.length) return 0;
      if (!s.token) { ui.outbox(out.length, 'add a GitHub token in ⚙'); return 0; }
      var batch = out.slice(0, 40);
      for (var attempt = 0; attempt < 4; attempt++) {
        var ref = await gh(s, 'GET', '/git/ref/heads/inbox'), parents = [], baseTree;
        if (ref.status === 200) { parents = [ref.data.object.sha]; baseTree = (await gh(s, 'GET', '/git/commits/' + parents[0])).data.tree.sha; }
        else if (ref.status !== 404) throw new Error('GitHub: ' + ref.status + ' ' + ((ref.data && ref.data.message) || '') + (ref.status === 401 ? ' (check the token)' : ''));
        var entries = batch.map(function (f) { return { path: f.path, mode: '100644', type: 'blob', content: f.content }; });
        if (!parents.length) entries.push({ path: 'README.md', mode: '100644', type: 'blob', content: '# Inbox\n\nCaptures from the iPhone script (iphone/), waiting for the "Ingest phone captures" workflow to file them into the prices branch.\n' });
        var tree = await gh(s, 'POST', '/git/trees', baseTree ? { base_tree: baseTree, tree: entries } : { tree: entries });
        if (tree.status !== 201) throw new Error('GitHub tree: ' + tree.status + ' ' + (tree.data && tree.data.message));
        var commit = await gh(s, 'POST', '/git/commits', { message: 'iPhone: ' + batch.length + ' Cardmarket capture' + (batch.length > 1 ? 's' : ''), tree: tree.data.sha, parents: parents });
        if (commit.status !== 201) throw new Error('GitHub commit: ' + commit.status + ' ' + (commit.data && commit.data.message));
        var upd = parents.length ? await gh(s, 'PATCH', '/git/refs/heads/inbox', { sha: commit.data.sha, force: false }) : await gh(s, 'POST', '/git/refs', { ref: 'refs/heads/inbox', sha: commit.data.sha });
        if (upd.status === 200 || upd.status === 201) {
          var left = (await getVal('outbox', [])).filter(function (f) { return !batch.some(function (b) { return b.path === f.path; }); });
          await setVal('outbox', left); ui.outbox(left.length, 'sent ✓');
          var last = await getVal('dispatchAt', 0);
          if (Date.now() - last > 10 * 60e3) { var d = await gh(s, 'POST', '/actions/workflows/ingest-inbox.yml/dispatches', { ref: 'main' }); if (d.status === 204) await setVal('dispatchAt', Date.now()); }
          if (left.length) flushSoon(2000);
          return batch.length;
        }
        if (upd.status !== 422 && upd.status !== 409) throw new Error('GitHub ref: ' + upd.status + ' ' + (upd.data && upd.data.message));
        await sleep(1500); // the workflow emptied the inbox meanwhile: try again on top of it
      }
      throw new Error('GitHub kept changing under us; will retry');
    })().finally(function () { flushing = null; });
    return flushing;
  }

  // ---------- the To watch list, from the phone ----------
  function words(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(function (w) { return w.length >= 2; }); }
  function hasNum(s, num) { return new RegExp('(^|[^0-9])0*' + String(num).replace(/[^0-9a-z]/gi, '').replace(/^0+(?=\d)/, '') + '($|[^0-9])', 'i').test(String(s)); }
  async function findProducts(card, want, s) { // search Cardmarket for the card; returns the product pages it found: id -> url
    var found = {}, name = card[5] === 'ja' ? card[9] || card[2] : card[2];
    if (card[5] !== 'ja') try { // pokemontcg.io redirects English prints to their Cardmarket page
      var r = await xhr({ url: 'https://prices.pokemontcg.io/cardmarket/' + encodeURIComponent(card[0]) });
      if (isProductUrl(r.url)) { var p = await cmFetch(enUrl(r.url), s.gap), d = parseProduct(parseHtml(p.html, p.url)); if (d.idProduct) found[d.idProduct] = enUrl(p.url); }
    } catch (e) { if (e instanceof StopError || e instanceof BlockedError) throw e; }
    if (want.every(function (cm) { return found[cm]; })) return found;
    var q = await cmFetch('https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=' + encodeURIComponent(name), s.gap), doc = parseHtml(q.html, q.url);
    if (isProductUrl(q.url)) { var one = parseProduct(doc); if (one.idProduct) found[one.idProduct] = enUrl(q.url); return found; }
    var nameW = words(name), setW = words(card[11]), seen = {};
    var cands = all(doc, 'a[href*="/Products/Singles/"]').map(function (a) {
      var href = a.href.split(/[?#]/)[0]; if (seen[href] || !isProductUrl(href)) return null; seen[href] = 1;
      var parts = href.split('/'), slug = parts[parts.length - 1], exp = parts[parts.length - 2], hay = words(slug + ' ' + txt(a.closest('.row, tr, li, article') || a));
      var nm = nameW.filter(function (w) { return hay.indexOf(w) >= 0; }).length; if (!nm) return null;
      return { href: href, score: 3 * nm + 2 * setW.filter(function (w) { return words(exp).indexOf(w) >= 0; }).length + (hasNum(slug, card[3]) ? 4 : 0) };
    }).filter(Boolean).sort(function (a, b) { return b.score - a.score; }).slice(0, 4);
    for (var i = 0; i < cands.length && !want.every(function (cm) { return found[cm]; }); i++) {
      var pg = await cmFetch(cands[i].href, s.gap), pd = parseProduct(parseHtml(pg.html, pg.url));
      if (pd.idProduct) found[pd.idProduct] = enUrl(pg.url);
    }
    return found;
  }
  async function watchRun() {
    var s = await settings(); stopFlag = false;
    ui.open('To watch list'); ui.body('<p>Loading your To watch list…</p>'); ui.running(true);
    var lock = null; try { lock = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch (e) {}
    try {
      var got = await Promise.all([cardMap(), rawJson('watchlist.json'), rawJson('state.json')]), map = got[0], watch = got[1], state = got[2];
      var done = await getVal('done', {}), searched = await getVal('searched', {}), urls = Object.assign({}, (state.urls || {}).cardmarket || {}, await getVal('urls', {}));
      var cap = (state.capture || {}).cardmarket || {}, now = Date.now(), H = 3600e3;
      var queue = watch.cards.map(function (w) { return map.byId.get(w[0]); }).filter(Boolean).map(function (c) {
        var at = [cap[c[0]], done[c[0]]].filter(Boolean).sort().pop() || ''; return { c: c, at: at };
      }).filter(function (x) { return !x.at || now - Date.parse(x.at) > s.watchStaleHours * H; })
        .sort(function (a, b) { return (a.at ? 1 : 0) - (b.at ? 1 : 0) || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0); });
      var total = queue.length, n = 0, saved = 0, missed = 0, t0 = Date.now();
      ui.progress(0, total, 'cards due (not read in ' + s.watchStaleHours + ' h)');
      for (var i = 0; i < queue.length && !stopFlag; i++) {
        var c = queue[i].c, want = c[6].slice(0, 3).map(function (p) { return p[0]; }), label = c[2] + ' · ' + c[11] + ' ' + c[3];
        ui.current(label, '');
        try {
          if (!want.every(function (cm) { return urls[cm]; }) && !(now - (searched[c[0]] || 0) < 7 * 24 * H)) {
            ui.current(label, 'finding it on Cardmarket'); Object.assign(urls, await findProducts(c, want, s));
            searched[c[0]] = Date.now(); await setVal('searched', searched);
          }
          var any = false;
          for (var k = 0; k < want.length && !stopFlag; k++) {
            if (!urls[want[k]]) continue;
            var res = await scanUrl(urls[want[k]], function (t) { ui.current(label, t); });
            if (res.idProduct !== want[k]) { ui.log('✗ ' + label + ': page is product ' + res.idProduct + ', not ' + want[k]); delete urls[want[k]]; continue; }
            await queueCapture(res, c[0]); any = true;
            ui.log((res.complete ? '✓ ' : '◐ ') + label + (c[6].length > 1 ? ' (' + c[6][k][1] + ')' : '') + ': ' + res.articles.length + ' offers' + (res.info.available ? ' of ' + res.info.available : '') + ', ' + res.diag.views + ' pages');
          }
          if (any) { saved++; done[c[0]] = new Date().toISOString(); await setVal('done', done); }
          else { missed++; ui.log('– ' + label + ': not found on Cardmarket'); }
        } catch (e) {
          if (e instanceof StopError) break;
          if (e instanceof BlockedError) { ui.log('⚠ ' + e.message); break; }
          ui.log('✗ ' + label + ': ' + e.message);
        }
        n++; ui.progress(n, total, saved + ' saved, ' + missed + ' not found · ' + Math.round(n / ((Date.now() - t0) / 60e3) * 10) / 10 + ' cards/min');
      }
      ui.current(stopFlag ? 'Stopped' : 'Done', '');
      await flush().catch(function (e) { ui.log('Not sent yet: ' + e.message); });
    } catch (e) { ui.log('✗ ' + e.message); }
    finally { ui.running(false); if (lock) try { lock.release(); } catch (e) {} }
  }

  // ---------- the product page you are on ----------
  async function scanHere() {
    stopFlag = false; ui.open('Scanning'); ui.running(true);
    ui.body('<p class="pm-dim">Reading every offer… <span id="pm-step"></span></p>');
    try {
      var res = await scanUrl(location.href, function (t) { var el = document.getElementById('pm-step'); if (el) el.textContent = t; });
      var cardId = await cardOf(res.idProduct).catch(function () { return null; });
      await queueCapture(res, cardId);
      ui.result(res, cardId);
    } catch (e) {
      ui.body('<p>' + esc(e.message) + '</p>');
    } finally { ui.running(false); }
  }

  // ---------- UI ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var eur = function (v) { return v == null || !isFinite(v) ? '–' : v.toFixed(2).replace('.', ',') + ' €'; };
  var ui = (function () {
    var css = '#pm-fab{position:fixed;right:14px;bottom:calc(18px + env(safe-area-inset-bottom));z-index:2147483646;width:52px;height:52px;border-radius:26px;border:0;background:#ffcb05;color:#1d2c5e;font:700 20px -apple-system,system-ui;box-shadow:0 4px 14px rgba(0,0,0,.35)}' +
      '#pm-fab .pm-badge{position:absolute;top:-4px;right:-4px;background:#e3350d;color:#fff;border-radius:10px;font-size:11px;padding:2px 6px;display:none}' +
      '#pm-sheet{position:fixed;left:0;right:0;bottom:0;max-height:82vh;z-index:2147483647;background:#14161c;color:#eee;font:14px/1.4 -apple-system,system-ui;border-radius:16px 16px 0 0;box-shadow:0 -6px 24px rgba(0,0,0,.5);display:none;flex-direction:column;padding-bottom:env(safe-area-inset-bottom)}' +
      '#pm-sheet header{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #2a2d36}#pm-sheet header b{flex:1;font-size:16px}' +
      '#pm-sheet button{background:#2a2d36;color:#eee;border:0;border-radius:8px;padding:8px 12px;font:600 14px -apple-system,system-ui}#pm-sheet button.pm-go{background:#ffcb05;color:#1d2c5e}' +
      '#pm-body{overflow:auto;padding:12px 14px;-webkit-overflow-scrolling:touch}#pm-body table{border-collapse:collapse;width:100%;font-size:12px;margin:6px 0 12px}#pm-body th,#pm-body td{color:#e8e9ee;background:transparent;font:12px/1.3 -apple-system,system-ui;padding:5px 4px;border-bottom:1px solid #2a2d36;text-align:right;white-space:nowrap}#pm-body th:first-child,#pm-body td:first-child{text-align:left}' +
      '#pm-body th{color:#8a8f9c;font-weight:600}#pm-body td small{display:block;color:#8a8f9c;font-size:10px}#pm-body p{color:#e8e9ee;margin:0 0 8px}.pm-dim{color:#8a8f9c}.pm-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}.pm-kpis div{background:#1d2029;border-radius:10px;padding:8px}.pm-kpis small{display:block;color:#8a8f9c;font-size:11px}.pm-kpis b{font-size:15px}' +
      '#pm-body label{display:block;margin:10px 0 4px;color:#8a8f9c;font-size:12px}#pm-body input[type=text],#pm-body input[type=password],#pm-body input[type=number]{width:100%;box-sizing:border-box;background:#1d2029;color:#eee;border:1px solid #2a2d36;border-radius:8px;padding:9px;font-size:16px}' +
      '.pm-log{font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;color:#c9ccd4}.pm-bar{height:6px;background:#2a2d36;border-radius:3px;overflow:hidden;margin:8px 0}.pm-bar i{display:block;height:100%;background:#ffcb05;width:0}.pm-row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}';
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var fab = document.createElement('button'); fab.id = 'pm-fab'; fab.textContent = '€'; var badge = document.createElement('span'); badge.className = 'pm-badge'; fab.appendChild(badge);
    var sheet = document.createElement('div'); sheet.id = 'pm-sheet';
    sheet.innerHTML = '<header><b id="pm-title">POcKEtMONey</b><button id="pm-stop" style="display:none">Stop</button><button id="pm-close">✕</button></header><div id="pm-body"></div>';
    document.body.appendChild(fab); document.body.appendChild(sheet);
    var $ = function (id) { return document.getElementById(id); };
    $('pm-close').onclick = function () { sheet.style.display = 'none'; };
    $('pm-stop').onclick = function () { stopFlag = true; $('pm-stop').textContent = 'Stopping…'; };
    fab.onclick = function () { if (isProductUrl(location.href)) scanHere(); else menu(); };
    var logLines = [];
    var api = {
      open: function (t) { $('pm-title').textContent = t; sheet.style.display = 'flex'; },
      body: function (h) { $('pm-body').innerHTML = h; logLines = []; },
      running: function (on) { $('pm-stop').style.display = on ? '' : 'none'; $('pm-stop').textContent = 'Stop'; },
      note: function (t) { var el = $('pm-step') || $('pm-cur2'); if (el) el.textContent = t; },
      outbox: function (n, msg) { badge.style.display = n ? 'block' : 'none'; badge.textContent = n; var el = $('pm-outbox'); if (el) el.textContent = (n ? n + ' waiting to be sent' : 'nothing waiting') + (msg ? ' · ' + msg : ''); },
      progress: function (n, total, sub) {
        if (!$('pm-bar')) $('pm-body').innerHTML = '<div id="pm-prog"></div><div class="pm-bar"><i id="pm-bar"></i></div><p><b id="pm-cur"></b><br><span class="pm-dim" id="pm-cur2"></span></p><p class="pm-dim" id="pm-outbox"></p><div class="pm-log" id="pm-log"></div>';
        $('pm-prog').textContent = n + ' / ' + total + ' · ' + sub; $('pm-bar').style.width = (total ? n / total * 100 : 100) + '%';
      },
      current: function (a, b) { if ($('pm-cur')) { $('pm-cur').textContent = a; $('pm-cur2').textContent = b; } },
      log: function (t) { logLines.unshift(t); logLines.length = Math.min(logLines.length, 200); if ($('pm-log')) $('pm-log').textContent = logLines.join('\n'); },
      result: function (res, cardId) { renderResult(res, cardId); }
    };
    return api;
  })();

  function renderResult(res, cardId) {
    ui.open('Cardmarket offers');
    var m = matrix(res.articles), langs = Object.keys(m).map(Number).sort(function (a, b) { return (a || 99) - (b || 99); });
    var ownLang = m[1] ? 1 : m[7] ? 7 : langs[0], own = m[ownLang] || null, nm = own && own.nm;
    var copies = res.articles.reduce(function (s, a) { return s + a[4]; }, 0), avail = res.info.available;
    var h = '<p class="pm-dim">' + esc(res.title) + (cardId ? ' · <b>' + esc(cardId) + '</b>' : ' · not in POcKEtMONey') + '</p>';
    h += '<div class="pm-kpis"><div><small>Offers read</small><b>' + res.articles.length + '</b>' + (avail ? '<small>' + copies + ' of ' + avail + ' copies</small>' : '') + '</div>' +
      '<div><small>Trend</small><b>' + eur(res.info.trend) + '</b><small>30 d ' + eur(res.info.avg30) + '</small></div>' +
      '<div><small>NM median ' + esc(LANGS[ownLang] || '') + '</small><b>' + eur(nm && nm.median) + '</b><small>from ' + eur(nm && nm.min) + '</small></div></div>';
    h += '<p>' + (res.complete ? '✓ Every offer read' : '◐ Cheapest offers per view; some views were cut off') + ' · ' + res.diag.views + ' pages · <span id="pm-outbox"></span></p>';
    h += '<table><tr><th>Language</th>' + CONDS.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '<th>NM avg</th></tr>';
    langs.forEach(function (l) {
      var L = m[l];
      h += '<tr><td>' + esc(LANGS[l] || '?') + '</td>' + CONDS.map(function (c) { var x = L.cells[c]; return '<td>' + (x ? eur(x.min) + '<small>' + x.n + '×</small>' : '<span class="pm-dim">·</span>') + '</td>'; }).join('') +
        '<td>' + (L.nm ? eur(L.nm.avg) + '<small>' + L.nm.n + '×</small>' : '–') + '</td></tr>';
    });
    h += '</table>';
    // the cheapest NM-or-better copies below 85 % of the NM median: offers worth a look
    if (nm && nm.n >= 5) {
      var deals = res.articles.filter(function (a) { return a[1] === ownLang && (a[2] === 'NM' || a[2] === 'MT') && !a[6] && !a[8] && a[3] < nm.median * 0.85; }).sort(function (a, b) { return a[3] - b[3]; }).slice(0, 5);
      if (deals.length) h += '<p><b>Below 85 % of the NM median</b></p><table>' + deals.map(function (a) { return '<tr><td>' + esc(a[10]) + '<small>' + esc(a[9]) + (a[11] ? ' · ' + esc(a[11]) : '') + '</small></td><td>' + a[2] + (a[5] ? ' RH' : '') + '</td><td>' + eur(a[3]) + '</td></tr>'; }).join('') + '</table>';
    }
    h += '<div class="pm-row"><button id="pm-again" class="pm-go">Scan again</button><button id="pm-diag">Copy diagnostics</button></div>';
    ui.body(h);
    getVal('outbox', []).then(function (o) { ui.outbox(o.length); });
    document.getElementById('pm-again').onclick = scanHere;
    document.getElementById('pm-diag').onclick = function () {
      var d = JSON.stringify({ version: VERSION, url: res.url, idProduct: res.idProduct, complete: res.complete, coverage: res.coverage, diag: res.diag, info: res.info, form: res.form, firstRows: res.articles.slice(0, 5), sampleRow: res.sampleRow }, null, 1);
      navigator.clipboard.writeText(d).then(function () { document.getElementById('pm-diag').textContent = 'Copied ✓'; });
    };
  }

  async function menu() {
    var s = await settings(), out = await getVal('outbox', []);
    ui.open('POcKEtMONey'); ui.body(
      '<p>Open a card\'s page on Cardmarket and tap <b>€</b> to read every offer and save it.</p>' +
      '<div class="pm-row"><button class="pm-go" id="pm-watch">Scrape my To watch list</button><button id="pm-send">Send now</button></div>' +
      '<p class="pm-dim" id="pm-outbox"></p>' +
      '<label>GitHub repository</label><input type="text" id="pm-repo" value="' + esc(s.repo) + '" autocapitalize="off">' +
      '<label>GitHub token (fine-grained: this repository only, Contents read &amp; write, Actions read &amp; write)</label><input type="password" id="pm-token" value="' + esc(s.token) + '" placeholder="github_pat_…">' +
      '<label><input type="checkbox" id="pm-auto"' + (s.autoScan ? ' checked' : '') + '> Scan every card page I open</label>' +
      '<label>Seconds between pages</label><input type="number" id="pm-gap" step="0.1" min="0.8" value="' + s.gap + '">' +
      '<label>Most pages per product</label><input type="number" id="pm-max" min="5" value="' + s.maxViews + '">' +
      '<div class="pm-row"><button id="pm-save" class="pm-go">Save settings</button></div><p class="pm-dim">v' + VERSION + '</p>');
    ui.outbox(out.length);
    document.getElementById('pm-watch').onclick = watchRun;
    document.getElementById('pm-send').onclick = function () { flush().then(function (n) { ui.outbox(0, n ? 'sent ✓' : ''); }).catch(function (e) { ui.outbox(out.length, e.message); }); };
    document.getElementById('pm-save').onclick = async function () {
      await setVal('settings', { repo: document.getElementById('pm-repo').value.trim(), token: document.getElementById('pm-token').value.trim(), autoScan: document.getElementById('pm-auto').checked,
        gap: Math.max(0.8, +document.getElementById('pm-gap').value || DEFAULTS.gap), maxViews: Math.max(5, +document.getElementById('pm-max').value || DEFAULTS.maxViews), watchStaleHours: s.watchStaleHours });
      document.getElementById('pm-save').textContent = 'Saved ✓'; flushSoon(500);
    };
  }

  // long-press the button for the menu on a product page too
  (function () {
    var fab = document.getElementById('pm-fab'), t = null;
    fab.addEventListener('touchstart', function () { t = setTimeout(function () { t = 'menu'; menu(); }, 600); }, { passive: true });
    fab.addEventListener('touchend', function (e) { if (t === 'menu') { e.preventDefault(); } else clearTimeout(t); t = null; });
  })();
  getVal('outbox', []).then(function (o) { ui.outbox(o.length); if (o.length) flushSoon(3000); });
  settings().then(function (s) { if (s.autoScan && isProductUrl(location.href)) setTimeout(scanHere, 1200); });
})();
