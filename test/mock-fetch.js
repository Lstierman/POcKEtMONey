// Preloaded into scripts/collect.js by the tests (node --require): answers every API the collector calls with
// fixtures shaped like the real responses, and records the requests in MOCK_LOG.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const map = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../data/card-map.json.gz'))));
const card = id => map.cards.find(c => c[0] === id);
const log = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-limit-count': '12', 'x-request-limit-max': '5000' } });

// 1,037 English/German articles for every Cardmarket product: two pages (206 then 200)
function articles(cm, start) {
  const total = 1037, out = [];
  for (let i = start; i < Math.min(total, start + 1000); i++) {
    out.push({ idArticle: cm * 10000 + i, idProduct: cm, language: { idLanguage: i % 3 === 0 ? 3 : 1, languageName: '' }, comments: i === 5 ? 'mint from pack' : '',
      price: 10 + (i % 20), count: i % 7 === 0 ? 2 : 1, condition: ['NM', 'NM', 'EX', 'LP'][i % 4], isFoil: i % 50 === 0, isSigned: false, isAltered: false, isFirstEd: false,
      seller: { username: 'seller' + (i % 40), address: { country: 'DE' } } });
  }
  return json({ article: out }, start + 1000 < total ? 206 : 200);
}

globalThis.fetch = async (url, opts = {}) => {
  url = String(url); log.push([url, (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '']);
  if (url.includes('frankfurter')) return json({ base: 'EUR', date: '2026-10-22', rates: { USD: 1.12, GBP: 0.84 } });
  if (url.includes('price_guide')) {
    const g = card('base1-4')[6].map(([cm]) => ({ idProduct: cm, trend: 280, low: 100, avg1: 300, avg7: 290, avg30: 310, 'trend-holo': 0, 'low-holo': null }));
    return json({ version: 1, createdAt: '2026-10-22T02:45:11+0200', priceGuides: g });
  }
  if (url.includes('last-updated.txt')) return new Response('2026-10-22T20:06:32+0000');
  if (url.includes('tcgcsv.com/tcgplayer/3/')) {
    const [pid, g] = card('base1-4')[7][0];
    return json({ success: true, results: url.includes('/' + g + '/') ? [{ productId: pid, lowPrice: 499, midPrice: 600, highPrice: 3499, marketPrice: 954.65, subTypeName: 'Holofoil' }] : [] });
  }
  if (url.includes('api.cardtrader.com')) {
    if (url.endsWith('/games')) return json({ array: [{ id: 1, name: 'Magic' }, { id: 5, name: 'Pokemon', display_name: 'Pokémon' }] });
    if (url.endsWith('/expansions')) return json([{ id: 100, game_id: 5, code: 'bs', name: 'Base Set' }, { id: 7, game_id: 1, code: 'lea', name: 'Alpha' }]);
    if (url.includes('/blueprints/export?expansion_id=100')) return json([{ id: 9001, name: 'Charizard', card_market_ids: [card('base1-4')[6][0][0]] }, { id: 9002, name: 'Unknown', card_market_ids: [1] }]);
    if (url.includes('/marketplace/products?expansion_id=100')) return json({
      9001: [
        { id: 1, blueprint_id: 9001, quantity: 1, price: { cents: 30000, currency: 'EUR' }, properties_hash: { condition: 'Near Mint', pokemon_language: 'en' }, user: { username: 'ash', country_code: 'IT' } },
        { id: 2, blueprint_id: 9001, quantity: 2, price: { cents: 25000, currency: 'EUR' }, properties_hash: { condition: 'Slightly Played', pokemon_language: 'de' }, user: { username: 'misty', country_code: 'DE' }, description: 'small whitening' },
        { id: 3, blueprint_id: 9001, quantity: 1, price_cents: 33600, price_currency: 'USD', properties_hash: { condition: 'Near Mint', pokemon_language: 'en' }, user: { username: 'brock', country_code: 'US' } },
        { id: 4, blueprint_id: 9001, quantity: 1, price: { cents: 0, currency: 'EUR' }, properties_hash: { condition: 'Near Mint', pokemon_language: 'en' } }],
      9002: [{ id: 5, blueprint_id: 9002, quantity: 1, price: { cents: 100, currency: 'EUR' }, properties_hash: { condition: 'Near Mint' } }] });
    return new Response('not mocked', { status: 404 });
  }
  if (url.includes('apiv2.cardmarket.com')) {
    const m = /articles\/(\d+)\?start=(\d+)/.exec(url);
    return articles(+m[1], +m[2]);
  }
  if (url.includes('/identity/v1/oauth2/token')) {
    if (String(opts.body).includes('marketplace.insights') && process.env.MOCK_NO_INSIGHTS) return json({ error: 'invalid_scope', error_description: 'The requested scope is invalid' }, 400);
    return json({ access_token: 'tok', expires_in: 7200 });
  }
  if (url.includes('/buy/browse/')) {
    const mp = opts.headers['X-EBAY-C-MARKETPLACE-ID'], cur = mp === 'EBAY_US' ? 'USD' : mp === 'EBAY_GB' ? 'GBP' : 'EUR';
    return json({ itemSummaries: [
      { itemId: mp + '-1', title: 'Charizard 4/102 Base Set Holo', price: { value: '400.00', currency: cur }, condition: 'Used', buyingOptions: ['FIXED_PRICE'], itemWebUrl: 'https://www.ebay.com/itm/1', image: { imageUrl: 'https://i.ebayimg.com/1.jpg' }, itemLocation: { country: 'DE' }, itemCreationDate: '2026-10-20T10:00:00Z' },
      { itemId: mp + '-2', title: 'Charizard 4/102 PSA 9 Base Set', price: { value: '3000.00', currency: cur }, condition: 'Graded', buyingOptions: ['FIXED_PRICE'], itemWebUrl: 'https://www.ebay.com/itm/2' },
      { itemId: mp + '-3', title: 'Charizard 6/102 Base Set', price: { value: '50.00', currency: cur }, buyingOptions: ['AUCTION'], currentBidPrice: { value: '20.00', currency: cur }, bidCount: 3 },
      { itemId: mp + '-4', title: 'Glurak 4/102 Basis Set', price: { value: '380.00', currency: cur }, buyingOptions: ['AUCTION'], currentBidPrice: { value: '350.00', currency: cur }, bidCount: 9 }] });
  }
  if (url.includes('/marketplace_insights/')) {
    const mp = opts.headers['X-EBAY-C-MARKETPLACE-ID'], cur = mp === 'EBAY_US' ? 'USD' : 'EUR';
    return json({ itemSales: [
      { itemId: mp + '-s1', title: 'Charizard 4/102 Base Set Unlimited', lastSoldPrice: { value: '420.00', currency: cur }, lastSoldDate: '2026-10-21T18:00:00Z', totalSoldQuantity: 1, condition: 'Used' },
      { itemId: mp + '-s2', title: 'Charizard 4/102 CGC 8.5', lastSoldPrice: { value: '1200.00', currency: cur }, lastSoldDate: '2026-10-19T18:00:00Z', totalSoldQuantity: 1 }] });
  }
  return new Response('not mocked: ' + url, { status: 599 });
};
process.on('exit', () => { if (process.env.MOCK_LOG) fs.writeFileSync(process.env.MOCK_LOG, JSON.stringify(log)); });
