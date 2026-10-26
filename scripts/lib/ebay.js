// eBay searches for a card: the query per marketplace (in that market's language), which results are this card, the
// language of an item, and eBay's search results page that the scraper extension reads.
const CATEGORY = '183454'; // CCG Individual Cards

// search text per marketplace, in that market's language where the card has a translated name
const MP_LANG = { EBAY_DE: 'de', EBAY_AT: 'de', EBAY_FR: 'fr', EBAY_IT: 'it', EBAY_ES: 'es' };
function query(card, mp) {
  const [, , name, number, printed, lang, , , names, enName, setCode] = card;
  const num = String(number).replace(/^0+(?=\d)/, '');
  if (lang === 'ja') return [enName || name, setCode, num, 'japanese'].filter(Boolean).join(' ');
  const local = (names && names[MP_LANG[mp]]) || name;
  return local + ' ' + (/^\d+$/.test(num) && printed ? num + '/' + printed : num);
}
// the language of an eBay item whose title doesn't name one: the card name it uses (Glurak: German, Charizard:
// English), else the language the search was made in. Japanese cards stay Japanese.
const LANG_ID = { de: 3, fr: 2, it: 5, es: 4, pt: 8, nl: 12, pl: 13 };
function defaultLang(card, mp, q, title) {
  if (card[5] === 'ja') return 7;
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const t = norm(title), hasEn = t.includes(norm(card[2]));
  if (!hasEn) for (const [l, name] of Object.entries(card[8] || {})) if (LANG_ID[l] && name && name !== card[2] && t.includes(norm(name))) return LANG_ID[l];
  if (hasEn) return 1;
  const l = MP_LANG[mp], local = l && card[8] && card[8][l];
  if (!local || local === card[2]) return 1;
  return q == null || norm(q).includes(norm(local)) ? LANG_ID[l] : 1;
}

// keeps items whose title names this card (first word of any of its names) and no other card number
function relevant(card, rows) {
  const { sameCardNumber } = require('../../src/prices.js');
  const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const words = [card[2], card[9]].concat(Object.values(card[8] || {})).filter(Boolean)
    .map(n => norm(n).split(/[^a-z0-9぀-ヿ一-鿿]+/).find(w => w.length >= 3)).filter(Boolean);
  return rows.filter(r => { const t = norm(r[1]); return sameCardNumber(r[1], card[3]) && (!words.length || words.some(w => t.includes(w))); });
}

// eBay's own search results page for the same query (the scraper extension reads these in your browser)
const HOST = { EBAY_US: 'www.ebay.com', EBAY_GB: 'www.ebay.co.uk', EBAY_DE: 'www.ebay.de', EBAY_FR: 'www.ebay.fr', EBAY_IT: 'www.ebay.it', EBAY_ES: 'www.ebay.es', EBAY_AT: 'www.ebay.at' };
function searchUrl(mp, q, sold) {
  return 'https://' + (HOST[mp] || HOST.EBAY_US) + '/sch/i.html?_nkw=' + encodeURIComponent(q).replace(/%20/g, '+') + '&_sacat=' + CATEGORY + '&_ipg=60' + (sold ? '&LH_Sold=1&LH_Complete=1' : '');
}

module.exports = { query, relevant, defaultLang, searchUrl };
