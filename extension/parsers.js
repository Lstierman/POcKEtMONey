/* Page parsers for the POcKEtMONey capture extension (also used by platform/scraper/sites/ebay.js and the tests).
   Each reads the page the user is looking at and returns plain data; nothing here fetches or clicks. */
(function (root) {
  'use strict';

  // ---------- shared ----------
  var CUR = [[/EUR|€/, 'EUR'], [/GBP|£/, 'GBP'], [/AU\s?\$|AUD/, 'AUD'], [/C\s?\$|CAD/, 'CAD'], [/CHF/, 'CHF'], [/US\s?\$|USD|\$/, 'USD'], [/PLN|zł/, 'PLN']];
  // "EUR 1.234,56", "$1,234.56", "£12.50", "12,50 €", "US $20.00 to US $30.00" -> [value, currency]
  function parsePrice(text, fallbackCur) {
    var s = String(text || '').split(/\bto\b|\bbis\b|\bà\b|–/)[0];
    var m = /(\d[\d.,\s ]*)/.exec(s); if (!m) return null;
    var n = m[1].replace(/[\s ]/g, ''), dec = /[.,](\d{1,2})$/.exec(n);
    n = dec ? n.slice(0, -dec[0].length).replace(/[.,]/g, '') + '.' + dec[1] : n.replace(/[.,]/g, '');
    var cur = ''; for (var i = 0; i < CUR.length; i++) if (CUR[i][0].test(s)) { cur = CUR[i][1]; break; }
    var v = parseFloat(n);
    return v > 0 && (cur || fallbackCur) ? [Math.round(v * 100) / 100, cur || fallbackCur] : null;
  }
  var MONTHS = { jan: 1, feb: 2, mar: 3, 'mär': 3, mrz: 3, apr: 4, may: 5, mai: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, dez: 12, janv: 1, 'févr': 2, mars: 3, avr: 4, juin: 6, juil: 7, 'août': 8, sept: 9, 'déc': 12 };
  // "Sold  Oct 20, 2026", "Verkauft  20. Okt 2026", "Vendu le 3 sept. 2026", "2026-10-20" -> "2026-10-20"
  function parseDate(text) {
    var s = String(text || '').toLowerCase(), m, d, mo, y;
    if ((m = /(\d{4})-(\d{2})-(\d{2})/.exec(s))) return m[0];
    if ((m = /([a-zäéû]{3,5})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s)) && MONTHS[m[1]]) { mo = MONTHS[m[1]]; d = +m[2]; y = +m[3]; }
    else if ((m = /(\d{1,2})\.?\s+([a-zäéû]{3,5})\.?\s+(\d{4})/.exec(s)) && MONTHS[m[2]]) { d = +m[1]; mo = MONTHS[m[2]]; y = +m[3]; }
    else return '';
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  var GRADED_RE = /\b(PSA|BGS|CGC|SGC|ACE|TAG|BECKETT)\s*-?\s*(10|[1-9](\.5)?)\b/i;
  function txt(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
  function tip(el) { return el ? el.getAttribute('aria-label') || el.getAttribute('data-bs-original-title') || el.getAttribute('data-original-title') || el.getAttribute('title') || '' : ''; }

  // ---------- eBay search results (for sale and sold) ----------
  var EBAY_MP = { 'www.ebay.com': 'EBAY_US', 'www.ebay.co.uk': 'EBAY_GB', 'www.ebay.de': 'EBAY_DE', 'www.ebay.fr': 'EBAY_FR', 'www.ebay.it': 'EBAY_IT', 'www.ebay.es': 'EBAY_ES', 'www.ebay.at': 'EBAY_AT', 'www.ebay.nl': 'EBAY_NL', 'www.benl.ebay.be': 'EBAY_NLBE', 'www.befr.ebay.be': 'EBAY_FRBE' };
  function ebayRaw(doc) {
    return Array.prototype.map.call(doc.querySelectorAll('li[data-listingid]'), function (li) {
      var t = li.querySelector('.s-card__title'), span = t && t.querySelector('span'), a = li.querySelector('a.s-card__link[href*="/itm/"]'), img = li.querySelector('img.s-card__image');
      return { id: li.getAttribute('data-listingid'), title: (span || t || {}).textContent || '', subtitle: (li.querySelector('.s-card__subtitle') || {}).textContent || '',
        price: (li.querySelector('.s-card__price') || {}).textContent || '',
        rows: Array.prototype.map.call(li.querySelectorAll('.s-card__attribute-row, .s-card__caption, .s-card__footer'), function (x) { return x.textContent.trim(); }),
        caption: (li.querySelector('.s-card__caption') || {}).textContent || '', href: a ? a.href : '', img: img ? img.getAttribute('src') || '' : '' };
    });
  }
  // raw -> [item id, title, price, currency, condition, marketplace, date, image, url, kind, bids or quantity, country, graded]
  function ebayRow(r, mp, sold, host) {
    var p = parsePrice(r.price); if (!p || !r.id || !r.title || /^shop on ebay$/i.test(r.title.trim())) return null;
    var all = r.rows.join(' | '), bids = /(\d+)\s*(bids?|gebote?|enchères?|offerte|pujas?|biedingen)/i.exec(all);
    var title = r.title.replace(/\s*(Opens in a new window or tab|Wird in neuem Fenster oder Tab geöffnet|S'ouvre dans une nouvelle fenêtre ou un nouvel onglet|Si apre in una nuova finestra o scheda|Se abre en una nueva ventana o pestaña)\s*$/i, '').trim();
    return [String(r.id), title, p[0], p[1], r.subtitle.split('|')[0].trim(), mp, sold ? parseDate(r.caption || all) : '', /^data:/.test(r.img || '') ? '' : r.img || '',
      'https://' + host + '/itm/' + r.id, sold ? 'SOLD' : bids ? 'AUCTION' : 'FIXED_PRICE', bids ? +bids[1] : sold ? 1 : 0, '', GRADED_RE.test(title) ? 1 : 0];
  }
  function ebay(doc, loc) {
    var u = new URL(loc.href), sold = u.searchParams.get('LH_Sold') === '1', mp = EBAY_MP[u.host] || 'EBAY_US';
    var items = ebayRaw(doc).map(function (r) { return ebayRow(r, mp, sold, u.host); }).filter(Boolean);
    return { site: 'ebay', mp: mp, sold: sold, query: u.searchParams.get('_nkw') || '', items: items, found: items.length };
  }

  // ---------- Cardmarket product page: the offers table ----------
  var CM_LANG = { english: 1, french: 2, german: 3, spanish: 4, italian: 5, 's-chinese': 6, 'simplified chinese': 6, japanese: 7, portuguese: 8, russian: 9, korean: 10, 't-chinese': 11, 'traditional chinese': 11, dutch: 12, polish: 13,
    englisch: 1, 'französisch': 2, deutsch: 3, spanisch: 4, italienisch: 5, japanisch: 7, portugiesisch: 8, koreanisch: 10, anglais: 1, 'français': 2, allemand: 3, espagnol: 4, italien: 5, japonais: 7 };
  var CONDS = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];
  function cardmarket(doc, loc) {
    var html = doc.documentElement.innerHTML, m = /idProduct["'\s:=]+(\d{4,})/.exec(html) || /\/Products\/\w*\?idProduct=(\d+)/.exec(html);
    var rows = Array.prototype.slice.call(doc.querySelectorAll('[id^="articleRow"], .article-row'));
    var seen = {}, articles = [];
    rows.forEach(function (row) {
      var id = +String(row.id || '').replace(/\D/g, '') || 0;
      if (id && seen[id]) return; seen[id] = 1;
      var icons = Array.prototype.map.call(row.querySelectorAll('[aria-label], [data-bs-original-title], [data-original-title], [title]'), tip).filter(Boolean);
      var lang = 0, flags = { f: 0, s: 0, one: 0, a: 0 }, country = '';
      icons.forEach(function (t) {
        var k = t.toLowerCase().trim();
        if (CM_LANG[k] && !lang) lang = CM_LANG[k];
        if (/reverse holo|reverse/.test(k)) flags.f = 1;
        if (/signed|signiert/.test(k)) flags.s = 1;
        if (/first edition|1st edition|erstauflage/.test(k)) flags.one = 1;
        if (/altered|verändert/.test(k)) flags.a = 1;
        var c = /(item location|artikelstandort|localisation)\s*:\s*(.+)/i.exec(t); if (c) country = c[2].trim();
      });
      var condEl = row.querySelector('.article-condition, .badge'), cond = (txt(condEl).match(/\b(MT|NM|EX|GD|LP|PL|PO)\b/) || [])[1] || '';
      if (!cond) { var mm = /\b(MT|NM|EX|GD|LP|PL|PO)\b/.exec(txt(row)); cond = mm ? mm[1] : '??'; }
      var priceEl = row.querySelector('.price-container .color-primary, .price-container span, .col-offer .price-container, [class*="price"]');
      var price = parsePrice(txt(priceEl), 'EUR');
      if (!price) { var all = txt(row).match(/\d[\d.]*,\d{2}\s*€/g); price = all ? parsePrice(all[all.length - 1], 'EUR') : null; }
      if (!price) return;
      var qtyEl = row.querySelector('.item-count, .amount-container .badge, [class*="amount"] span'), qty = +(txt(qtyEl).match(/\d+/) || [1])[0] || 1;
      var sellerEl = row.querySelector('.seller-name a, a[href*="/Users/"]'), commentEl = row.querySelector('.product-comments, .col-product .text-truncate');
      articles.push([id || articles.length + 1, lang, CONDS.indexOf(cond) >= 0 ? cond : '??', price[0], qty, flags.f, flags.s, flags.one, flags.a, country, txt(sellerEl), txt(commentEl).slice(0, 120), m ? +m[1] : 0]);
    });
    var more = Array.prototype.filter.call(doc.querySelectorAll('button, a.btn, #loadMore, [id*="loadMore"]'), function (b) {
      return /load more|show more|mehr anzeigen|weitere|plus de résultats|loadMore/i.test(b.id + ' ' + b.textContent) && !b.disabled && b.offsetParent !== null;
    })[0] || null;
    return { site: 'cardmarket', idProduct: m ? +m[1] : null, title: txt(doc.querySelector('h1')), articles: articles, found: articles.length, rowsSeen: rows.length, more: more };
  }

  // ---------- PriceCharting game page: graded prices and sold listings ----------
  var PC_FIELDS = [['ungraded', 'used_price'], ['grade7', 'complete_price'], ['grade8', 'new_price'], ['grade9', 'graded_price'], ['grade9_5', 'box_only_price'], ['psa10', 'manual_only_price']];
  var PC_TABS = { used: 'Ungraded', cib: 'Grade 7', new: 'Grade 8', graded: 'Grade 9', 'box-only': 'Grade 9.5', 'manual-only': 'PSA 10' };
  function pricecharting(doc, loc) {
    var prices = {}, n = 0;
    PC_FIELDS.forEach(function (f) {
      var el = doc.querySelector('#' + f[1] + ' .price, #' + f[1] + ' .js-price, td#' + f[1]);
      var p = el ? parsePrice(txt(el), 'USD') : null; prices[f[0]] = p ? p[0] : null; if (p) n++;
    });
    var sold = [];
    Object.keys(PC_TABS).forEach(function (k) {
      Array.prototype.forEach.call(doc.querySelectorAll('.completed-auctions-' + k + ' tr, #completed-auctions-' + k + ' tr'), function (tr) {
        var a = tr.querySelector('td.title a, .title a'), p = parsePrice(txt(tr.querySelector('.js-price, td.numeric, .price')), 'USD'), d = parseDate(txt(tr.querySelector('td.date, .date')));
        if (!p || !d) return;
        var title = txt(a || tr.querySelector('td.title, .title'));
        var href = a ? a.href : null; if (href && /tcgplayer\.com%2Fproduct%2F(\d+)/.test(href)) href = 'https://www.tcgplayer.com/product/' + /tcgplayer\.com%2Fproduct%2F(\d+)/.exec(href)[1];
        if (href) href = href.replace(/(ebay\.[a-z.]+\/itm\/\d+).*/, '$1');
        sold.push([d, PC_TABS[k], title, p[0], href]);
      });
    });
    return { site: 'pricecharting', url: loc.href.split(/[?#]/)[0], title: txt(doc.querySelector('h1')), prices: prices, sold: sold, found: n + sold.length };
  }

  function parsePage(doc, loc) {
    var h = loc.host;
    if (/(^|\.)ebay\./.test(h) && /\/sch\//.test(loc.pathname)) return ebay(doc, loc);
    if (/cardmarket\.com$/.test(h) && /\/Products\/Singles\//.test(loc.pathname)) return cardmarket(doc, loc);
    if (/pricecharting\.com$/.test(h) && /^\/game\//.test(loc.pathname)) return pricecharting(doc, loc);
    return null;
  }

  var api = { parsePage: parsePage, ebay: ebay, ebayRaw: ebayRaw, ebayRow: ebayRow, cardmarket: cardmarket, pricecharting: pricecharting, parsePrice: parsePrice, parseDate: parseDate, EBAY_MP: EBAY_MP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PTCG_PARSE = api;
})(typeof window !== 'undefined' ? window : globalThis);
