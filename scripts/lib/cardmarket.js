// Cardmarket API 2.0 (apiv2.cardmarket.com): every article (listing) of a product, in all languages and conditions.
// Needs a Cardmarket app with OAuth 1.0a keys: CARDMARKET_APP_TOKEN, CARDMARKET_APP_SECRET,
// CARDMARKET_ACCESS_TOKEN, CARDMARKET_ACCESS_SECRET (a "dedicated app" from your Cardmarket account).
const crypto = require('crypto');
const BASE = 'https://apiv2.cardmarket.com/ws/v2.0/output.json';
const PAGE = 1000; // the API's maximum per request

const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function credentials(env = process.env) {
  const c = { appToken: env.CARDMARKET_APP_TOKEN, appSecret: env.CARDMARKET_APP_SECRET, accessToken: env.CARDMARKET_ACCESS_TOKEN, accessSecret: env.CARDMARKET_ACCESS_SECRET };
  return Object.values(c).every(Boolean) ? c : null;
}

// OAuth 1.0a header as Cardmarket expects it: realm = the URL without query; query parameters are signed too
function authHeader(method, url, creds, nonce = crypto.randomBytes(12).toString('hex'), timestamp = Math.floor(Date.now() / 1000)) {
  const u = new URL(url), realm = u.origin + u.pathname;
  const oauth = { oauth_consumer_key: creds.appToken, oauth_token: creds.accessToken, oauth_nonce: nonce, oauth_timestamp: String(timestamp), oauth_signature_method: 'HMAC-SHA1', oauth_version: '1.0' };
  const params = Object.assign({}, oauth);
  u.searchParams.forEach((v, k) => { params[k] = v; });
  const base = method.toUpperCase() + '&' + enc(realm) + '&' + enc(Object.keys(params).sort().map(k => enc(k) + '=' + enc(params[k])).join('&'));
  const sig = crypto.createHmac('sha1', enc(creds.appSecret) + '&' + enc(creds.accessSecret)).update(base).digest('base64');
  return 'OAuth realm="' + realm + '", ' + Object.keys(oauth).map(k => k + '="' + enc(oauth[k]) + '"').join(', ') + ', oauth_signature="' + enc(sig) + '"';
}

// one API article -> PRICES.ARTICLE row
function articleRow(a, idProduct) {
  const s = a.seller || {};
  return [a.idArticle, (a.language && a.language.idLanguage) || 0, a.condition || '??', Math.round(a.price * 100) / 100, a.count || 1,
    a.isFoil ? 1 : 0, a.isSigned ? 1 : 0, a.isFirstEd ? 1 : 0, a.isAltered ? 1 : 0,
    (s.address && s.address.country) || s.country || '', s.username || '', (a.comments || '').slice(0, 120), a.idProduct || idProduct];
}

class Cardmarket {
  constructor(creds, budget) { this.creds = creds; this.budget = budget; this.used = 0; this.limit = null; }
  async get(path) {
    if (this.used >= this.budget) { const e = new Error('request budget used'); e.budget = true; throw e; }
    const url = BASE + path; this.used++;
    const r = await fetch(url, { headers: { Authorization: authHeader('GET', url, this.creds), Accept: 'application/json' } });
    const cnt = r.headers.get('x-request-limit-count'), max = r.headers.get('x-request-limit-max');
    if (cnt && max) this.limit = { count: +cnt, max: +max };
    if (r.status === 204) return { status: 204, body: null };
    if (r.status === 401 || r.status === 403) { const e = new Error('Cardmarket rejected the credentials (HTTP ' + r.status + ')'); e.fatal = true; throw e; }
    if (r.status === 429) { const e = new Error('Cardmarket daily request limit reached'); e.fatal = true; throw e; }
    if (r.status !== 200 && r.status !== 206) throw new Error('HTTP ' + r.status + ' ' + path);
    return { status: r.status, body: await r.json() };
  }
  // all articles of a product, following 206 Partial Content pages
  async articles(idProduct) {
    const rows = [];
    for (let start = 0; ; start += PAGE) {
      const r = await this.get(`/articles/${idProduct}?start=${start}&maxResults=${PAGE}`);
      const list = (r.body && r.body.article) || [];
      list.forEach(a => { if (a.price > 0) rows.push(articleRow(a, idProduct)); });
      if (r.status !== 206 || list.length < PAGE) return rows;
    }
  }
}

module.exports = { Cardmarket, credentials, authHeader, articleRow };
