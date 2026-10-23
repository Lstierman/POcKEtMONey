// eBay Buy APIs with an application token (client credentials): EBAY_CLIENT_ID, EBAY_CLIENT_SECRET from developer.ebay.com.
//   for sale: Browse API item_summary/search (open to every developer account)
//   sold:     Marketplace Insights item_sales/search (eBay grants this scope on request; without it sold lists are skipped)
const { isGraded } = require('../../src/prices.js');
const API = 'https://api.ebay.com';
const CATEGORY = '183454'; // CCG Individual Cards
const SCOPE = 'https://api.ebay.com/oauth/api_scope', INSIGHTS = 'https://api.ebay.com/oauth/api_scope/buy.marketplace.insights';

function credentials(env = process.env) {
  return env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET ? { id: env.EBAY_CLIENT_ID, secret: env.EBAY_CLIENT_SECRET } : null;
}

// item row (13 fields): [item id, title, price, currency, condition, marketplace, date, image, url, kind, bids or quantity sold, country, graded]
function activeRow(it, mp) {
  const auction = (it.buyingOptions || []).includes('AUCTION') && !(it.buyingOptions || []).includes('FIXED_PRICE');
  const p = auction && it.currentBidPrice ? it.currentBidPrice : it.price || {};
  return [it.itemId, it.title || '', +p.value, p.currency || '', it.condition || '', mp, it.itemCreationDate || it.itemEndDate || '',
    (it.image && it.image.imageUrl) || (it.thumbnailImages && it.thumbnailImages[0] && it.thumbnailImages[0].imageUrl) || '',
    it.itemWebUrl || '', auction ? 'AUCTION' : 'FIXED_PRICE', it.bidCount || 0, (it.itemLocation && it.itemLocation.country) || '', isGraded(it.title) ? 1 : 0];
}
function soldRow(it, mp) {
  const p = it.lastSoldPrice || {};
  return [it.itemId, it.title || '', +p.value, p.currency || '', it.condition || '', mp, it.lastSoldDate || '',
    (it.image && it.image.imageUrl) || '', it.itemWebUrl || '', 'SOLD', it.totalSoldQuantity || 1, (it.itemLocation && it.itemLocation.country) || '', isGraded(it.title) ? 1 : 0];
}

class Ebay {
  constructor(creds, budget) { this.creds = creds; this.budget = budget; this.used = 0; this.tokens = {}; }
  async token(scope) {
    const t = this.tokens[scope];
    if (t && t.exp > Date.now() + 60e3) return t.value;
    const r = await fetch(API + '/identity/v1/oauth2/token', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(this.creds.id + ':' + this.creds.secret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&scope=' + encodeURIComponent(scope)
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error('eBay token: ' + (d.error_description || d.error || r.status)); e.scope = scope; e.fatal = scope === SCOPE; throw e; }
    this.tokens[scope] = { value: d.access_token, exp: Date.now() + d.expires_in * 1000 };
    return d.access_token;
  }
  async call(scope, path, mp) {
    if (this.used >= this.budget) { const e = new Error('call budget used'); e.budget = true; throw e; }
    this.used++;
    const r = await fetch(API + path, { headers: { Authorization: 'Bearer ' + await this.token(scope), 'X-EBAY-C-MARKETPLACE-ID': mp, Accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) { const e = new Error('eBay refused ' + path.split('?')[0] + ' (HTTP ' + r.status + ')'); e.denied = true; throw e; }
    if (r.status === 429) { const e = new Error('eBay call limit reached'); e.fatal = true; throw e; }
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + path.split('?')[0]);
    return r.json();
  }
  async forSale(q, mp, limit) {
    const d = await this.call(SCOPE, `/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&category_ids=${CATEGORY}&limit=${limit}`, mp);
    return (d.itemSummaries || []).map(it => activeRow(it, mp)).filter(r => r[2] > 0);
  }
  async sold(q, mp, limit) {
    const d = await this.call(INSIGHTS, `/buy/marketplace_insights/v1_beta/item_sales/search?q=${encodeURIComponent(q)}&category_ids=${CATEGORY}&limit=${limit}`, mp);
    return (d.itemSales || []).map(it => soldRow(it, mp)).filter(r => r[2] > 0);
  }
}

// search text per marketplace, in that market's language where the card has a translated name
const MP_LANG = { EBAY_DE: 'de', EBAY_AT: 'de', EBAY_FR: 'fr', EBAY_IT: 'it', EBAY_ES: 'es' };
function query(card, mp) {
  const [, , name, number, printed, lang, , , names, enName, setCode] = card;
  const num = String(number).replace(/^0+(?=\d)/, '');
  if (lang === 'ja') return [enName || name, setCode, num, 'japanese'].filter(Boolean).join(' ');
  const local = (names && names[MP_LANG[mp]]) || name;
  return local + ' ' + (/^\d+$/.test(num) && printed ? num + '/' + printed : num);
}
// keeps items whose title names this card (first word of any of its names) and no other card number
function relevant(card, rows) {
  const { sameCardNumber } = require('../../src/prices.js');
  const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const words = [card[2], card[9]].concat(Object.values(card[8] || {})).filter(Boolean)
    .map(n => norm(n).split(/[^a-z0-9぀-ヿ一-鿿]+/).find(w => w.length >= 3)).filter(Boolean);
  return rows.filter(r => { const t = norm(r[1]); return sameCardNumber(r[1], card[3]) && (!words.length || words.some(w => t.includes(w))); });
}

module.exports = { Ebay, credentials, query, relevant, activeRow, soldRow, SCOPE, INSIGHTS };
