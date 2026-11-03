// Files the iPhone script's captures (iphone/pocketmoney-cardmarket.user.js) into the price store.
//
//   node scripts/ingest-inbox.js --store=store --inbox=inbox [--done=build/inbox-done.txt]
//
// The phone commits one JSON file per Cardmarket product it read to the `inbox` branch
// (cardmarket/<day>/<time>-<product>.json). This applies them, oldest first, exactly like the helper applies a
// scraper capture (scripts/ingest-server.js): the card is found by its Cardmarket product id, the product's
// listings replace the stored ones, and the summary, markets and history are updated. Every file written is
// validated (scripts/lib/store.js); a capture that would not validate is rejected on its own and the rest go on.
// --done lists every inbox file that was handled (applied, already applied, or rejected), for the workflow to
// remove from the inbox branch. Exit code 1 only when the store itself fails verification: nothing is published.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { Store, SCHEMA } = require('./lib/store.js');
const { applyCardmarket, finalize } = require('./lib/entries.js');
const src = require('./lib/sources.js');

const root = path.join(__dirname, '..');
const arg = (n, d) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const dir = path.resolve(arg('store', 'store')), inbox = path.resolve(arg('inbox', 'inbox')), doneF = arg('done', null);
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config/prices.config.json'), 'utf8'));
const map = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'data/card-map.json.gz'))));
const cards = new Map(), byCm = new Map();
for (const c of map.cards) { cards.set(c[0], c); for (const [cm] of c[6]) byCm.set(cm, c[0]); }

const isIso = s => typeof s === 'string' && !isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T/.test(s);
const PRODUCT_URL = /^https:\/\/www\.cardmarket\.com\/[a-z]{2}\/Pokemon\/Products\/Singles\/[^?#]+$/;
// the same checks the store applies to a listing file, so one bad capture can't stop the others
function problem(m) {
  if (!m || m.v !== 1 || m.site !== 'cardmarket') return 'not a Cardmarket capture';
  if (!isIso(m.at) || Date.parse(m.at) > Date.now() + 36e5) return 'bad time';
  const d = m.data; if (!d || !Number.isInteger(d.idProduct) || !(d.idProduct > 0) || !Array.isArray(d.articles)) return 'no product';
  for (const a of d.articles) {
    if (!Array.isArray(a) || a.length !== 13 || !(a[3] > 0) || a[3] > 1e6 || !Number.isInteger(a[1]) || typeof a[2] !== 'string') return 'bad offer ' + JSON.stringify(a).slice(0, 80);
    if (a[12] !== d.idProduct) return 'offer of another product';
  }
  if (d.coverage != null && (!Array.isArray(d.coverage) || !d.coverage.every(x => Array.isArray(x) && x.length === 4))) return 'bad coverage';
  return null;
}

function files(d, out = []) {
  if (!fs.existsSync(d)) return out;
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (f.name.startsWith('.')) continue;
    const p = path.join(d, f.name);
    if (f.isDirectory()) files(p, out); else if (f.name.endsWith('.json')) out.push(p);
  }
  return out;
}

async function main() {
  const list = files(inbox).map(f => { try { return { f, m: JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch (e) { return { f, bad: 'not JSON' }; } })
    .sort((a, b) => String(a.m && a.m.at).localeCompare(String(b.m && b.m.at)));
  const done = [], report = { applied: 0, already: 0, rejected: 0, unknown: 0 };
  const rel = f => path.relative(inbox, f).split(path.sep).join('/');
  if (!list.length) { console.log('inbox: nothing to ingest'); if (doneF) fs.writeFileSync(doneF, ''); return; }

  const store = new Store(dir);
  const sum = store.read('summary.json.gz', null) || { v: SCHEMA, at: new Date().toISOString(), sources: {}, cards: {} };
  const meta = store.read('meta.json', null);
  const state = store.read('state.json', { v: SCHEMA, cm: {}, eb: {} });
  state.capture = state.capture || {}; state.urls = state.urls || {}; state.urls.cardmarket = state.urls.cardmarket || {};
  let fx = sum.fx, fxDate = sum.fxDate;
  if (!fx || !(fx.USD > 0)) { const r = await src.fx(); fx = r.fx; fxDate = r.date; }
  const E = sum.cards, ids = new Set();

  for (const { f, m, bad } of list) {
    const why = bad || problem(m);
    if (why) { console.warn('rejected ' + rel(f) + ': ' + why); report.rejected++; done.push(rel(f)); continue; }
    const d = m.data, id = byCm.get(d.idProduct) || (m.cardId && cards.has(m.cardId) && cards.get(m.cardId)[6].some(p => p[0] === d.idProduct) ? m.cardId : null);
    if (!id) { console.warn('skipped ' + rel(f) + ': Cardmarket product ' + d.idProduct + ' is not a card in the catalog'); report.unknown++; done.push(rel(f)); continue; }
    const card = cards.get(id), file = store.listingFile('cardmarket', card[1], id), old = store.read(file, null);
    const prev = old && old.products.find(p => p.cm === d.idProduct);
    if (prev && prev.at && prev.at >= m.at) { report.already++; done.push(rel(f)); continue; } // applied before (or something newer is stored)
    const label = (card[6].find(x => x[0] === d.idProduct) || [])[1] || d.title || 'Cardmarket';
    const prod = { cm: d.idProduct, label, at: m.at, via: 'iphone', articles: d.articles };
    if (Array.isArray(d.coverage)) prod.coverage = d.coverage.map(x => [+x[0] || 0, +x[1] || 0, +x[2] || 0, x[3] ? 1 : 0]);
    if (d.available > 0) prod.available = Math.round(d.available);
    const products = (old ? old.products : []).filter(p => p.cm !== d.idProduct).concat([prod]);
    const e = E[id] || (E[id] = {});
    applyCardmarket(store, e, card, products, m.at, 'scraper', fx);
    const st = state.capture.cardmarket = state.capture.cardmarket || {};
    if (!st[id] || st[id] < m.at) st[id] = m.at;
    if (PRODUCT_URL.test(String(m.url || ''))) state.urls.cardmarket[d.idProduct] = m.url;
    ids.add(id); report.applied++; done.push(rel(f));
    console.log(`${id} ${label}: ${d.articles.length} Cardmarket offers` + (prod.available ? ' of ' + prod.available + ' copies listed' : '') + (d.complete ? ', every offer' : '') + ' (' + m.at.slice(0, 16) + ')');
  }

  if (ids.size) {
    const at = new Date().toISOString();
    finalize(store, E, cards, cfg, fx, Date.now(), [...ids]);
    store.write('summary.json.gz', Object.assign(sum, { v: SCHEMA, fx, fxDate, scrapedAt: at, cards: E }), 'summary');
    store.write('state.json', state, 'state');
    store.write('meta.json', Object.assign({ v: SCHEMA, at, sources: {} }, meta || {}, { fx, fxDate, scrapedAt: at, cards: Object.keys(E).length }), 'meta');
    const bad = store.verify();
    if (bad.length) { console.error('store verification failed, nothing will be published: ' + bad.join('; ')); process.exitCode = 1; return; }
  }
  if (doneF) { fs.mkdirSync(path.dirname(path.resolve(doneF)), { recursive: true }); fs.writeFileSync(doneF, done.join('\n') + (done.length ? '\n' : '')); }
  console.log(`inbox: ${report.applied} applied to ${ids.size} cards, ${report.already} already applied, ${report.unknown} not in the catalog, ${report.rejected} rejected`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
