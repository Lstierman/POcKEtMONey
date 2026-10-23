// Public price sources the collector reads without credentials.
const sleep = ms => new Promise(r => setTimeout(r, ms));
// tcgcsv.com blocks unidentified clients; every request names the app
const UA = { 'User-Agent': 'POcKEtMONey-price-collector/1.0 (+https://github.com/; Pokemon card index)' };

async function getJSON(url, opts = {}, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({}, UA, opts.headers) }));
      if (r.ok) return await r.json();
      if (r.status === 404 || r.status === 401 || r.status === 403 || attempt >= tries) { const e = new Error('HTTP ' + r.status + ' ' + url.split('?')[0]); e.status = r.status; throw e; }
    } catch (e) { if (e.status || attempt >= tries) throw e; }
    await sleep(1000 * attempt);
  }
}

// euro per one unit of each currency (ECB reference rates via frankfurter.dev)
async function fx() {
  const d = await getJSON('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD,GBP,JPY,CAD,AUD,CHF,SEK,PLN,CZK,DKK,HKD,SGD');
  const out = { EUR: 1 };
  for (const [k, v] of Object.entries(d.rates)) if (v > 0) out[k] = Math.round(1 / v * 1e6) / 1e6;
  return { fx: out, date: d.date };
}

// Cardmarket's own public price guide (all products, EUR), refreshed by Cardmarket about once a day
const GUIDE_URL = 'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_6.json';
async function guide(prevCreatedAt) {
  const d = await getJSON(GUIDE_URL);
  if (prevCreatedAt && d.createdAt === prevCreatedAt) return { createdAt: d.createdAt, unchanged: true };
  const pos = x => (typeof x === 'number' && x > 0 ? Math.round(x * 100) / 100 : null);
  const byProduct = new Map();
  for (const g of d.priceGuides) byProduct.set(g.idProduct, [g.idProduct, pos(g.trend), pos(g.low), pos(g.avg1), pos(g.avg7), pos(g.avg30), pos(g['trend-holo']), pos(g['low-holo'])]);
  return { createdAt: d.createdAt, byProduct };
}

// TCGplayer prices through tcgcsv.com (daily dumps of the TCGplayer API), only the groups the card map uses
async function tcgplayer(groupIds, prevUpdated) {
  const r = await fetch('https://tcgcsv.com/last-updated.txt', { headers: UA }); const updated = (await r.text()).trim();
  if (!r.ok || isNaN(Date.parse(updated))) throw new Error('tcgcsv last-updated: HTTP ' + r.status + ' ' + updated.slice(0, 60));
  if (prevUpdated && updated === prevUpdated) return { updated, unchanged: true };
  const byProduct = new Map(), failed = [];
  const queue = [...groupIds];
  async function worker() {
    while (queue.length) {
      const g = queue.shift();
      try {
        const d = await getJSON(`https://tcgcsv.com/tcgplayer/3/${g}/prices`);
        for (const p of d.results || []) {
          const row = [p.productId, p.subTypeName || 'Normal', p.marketPrice, p.lowPrice, p.midPrice, p.highPrice].map((v, i) => (i < 2 ? v : v > 0 ? Math.round(v * 100) / 100 : null));
          if (row[2] == null && row[3] == null) continue;
          if (!byProduct.has(p.productId)) byProduct.set(p.productId, []);
          byProduct.get(p.productId).push(row);
        }
      } catch (e) { failed.push(g); }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  if (failed.length === groupIds.size) throw new Error('tcgcsv: every group request failed');
  return { updated, byProduct, failed };
}

module.exports = { getJSON, fx, guide, tcgplayer, sleep };
