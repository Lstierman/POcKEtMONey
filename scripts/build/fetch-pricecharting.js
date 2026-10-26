// Refreshes the graded prices of every card in data/pricecharting/ from the PriceCharting API.
// Needs an API token (PriceCharting subscription) in PRICECHARTING_TOKEN; without one it does nothing.
// Writes data/pricecharting-live.json: { "<card id>": { pcid, at, prices: { ungraded, grade7, grade8, grade9, grade9_5, psa10 } } }.
// merge-pricecharting.js lays these over the collected files; the sold listings stay as collected (the API has none).
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '../..'), dir = path.join(root, 'data/pricecharting'), out = path.join(root, 'data/pricecharting-live.json');
const token = process.env.PRICECHARTING_TOKEN;
if (!token) { console.log('PRICECHARTING_TOKEN not set: graded prices stay as collected'); process.exit(0); }

// trading-card meaning of PriceCharting's video-game price fields (values in US cents)
const FIELDS = { ungraded: 'loose-price', grade7: 'cib-price', grade8: 'new-price', grade9: 'graded-price', grade9_5: 'box-only-price', psa10: 'manual-only-price' };
const key = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cards = [];
for (const f of fs.readdirSync(dir)) for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)) {
  if (f.endsWith('.raw')) { const [id, pc] = line.split('\t'); cards.push({ id, pc }); }
  else { const o = JSON.parse(line); cards.push({ id: o.id, pc: o.pc }); }
}
const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out)) : {};

async function api(params) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch('https://www.pricecharting.com/api/product?' + new URLSearchParams({ t: token, ...params }));
    if (r.ok) return r.json();
    if (attempt >= 3 || r.status === 401 || r.status === 403) throw new Error('HTTP ' + r.status);
    await sleep(2000 * attempt);
  }
}

(async () => {
  const res = {}; let ok = 0, failed = 0;
  for (const c of cards) {
    const m = /\/game\/([^/]+)\/([^/?#]+)/.exec(c.pc || '');
    if (!m) { failed++; continue; }
    const [, consoleSlug, productSlug] = m.map(decodeURIComponent);
    try {
      // first run: search by the page's slugs and keep the product id only if it is the same page; later runs use the id
      const pcid = prev[c.id] && prev[c.id].pcid;
      const p = await api(pcid ? { id: pcid } : { q: (consoleSlug + ' ' + productSlug).replace(/-/g, ' ') });
      if (p.status !== 'success' || key(p['console-name']) !== key(consoleSlug) || key(p['product-name']) !== key(productSlug))
        throw new Error('no exact match (got ' + p['console-name'] + ' / ' + p['product-name'] + ')');
      const prices = {};
      for (const [k, f] of Object.entries(FIELDS)) prices[k] = p[f] ? p[f] / 100 : null;
      res[c.id] = { pcid: p.id, at: new Date().toISOString(), prices }; ok++;
    } catch (e) {
      failed++; console.warn(c.id, e.message);
      if (prev[c.id]) res[c.id] = prev[c.id]; // keep the last good refresh
      if (/HTTP 40[13]/.test(e.message)) { console.error('token rejected, stopping'); break; }
    }
    await sleep(1100); // stay well under the API rate limit
  }
  fs.writeFileSync(out, JSON.stringify(res, null, 0) + '\n');
  console.log(`graded prices refreshed: ${ok} cards, ${failed} failed, written to ${path.relative(root, out)}`);
})();
