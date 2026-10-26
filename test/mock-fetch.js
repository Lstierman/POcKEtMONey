// Preloaded into scripts/collect.js and the helper by the tests (node --require): answers the feeds they call with
// fixtures shaped like the real responses, and records the requests in MOCK_LOG.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const map = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../data/card-map.json.gz'))));
const card = id => map.cards.find(c => c[0] === id);
const log = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-limit-count': '12', 'x-request-limit-max': '5000' } });


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
  return new Response('not mocked: ' + url, { status: 599 });
};
process.on('exit', () => { if (process.env.MOCK_LOG) fs.writeFileSync(process.env.MOCK_LOG, JSON.stringify(log)); });
