// Local helper for the capture extension (extension/). Receives what the extension read on a Cardmarket, eBay or
// PriceCharting page you opened, works out which card it is, and stores it in the price store, in the same files and
// format as the hourly collector (listings/<site>/<set>/<card>.json, summary.json.gz, history/, validated on write).
//
//   npm run ingest -- [--store=store] [--port=8787] [--publish] [--publish-minutes=10]
//   npm run helper    (the same with --publish --publish-minutes=0: works on a copy of the prices branch, pushes only
//                      when you click "Push to GitHub" in the scraper extension, or when you stop it with Ctrl+C)
//
// The scraper extension (scraper-extension/) also asks it what to visit: GET /sites (when each site was last scraped),
// GET /queue?site=…&n=…&only=… (the next cards with their URLs, scripts/lib/scrape-plan.js), POST /publish.
//
// --publish: the store becomes a worktree of the "prices" branch; every few minutes new captures are pushed. If the
// hourly collector pushed in between, the store is reset to that version and the captures are replayed on top
// (journal: build/ingest-journal.jsonl), so neither side loses data.
// It also serves the store at http://127.0.0.1:<port>/store/ so a locally built page sees captures immediately.
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), cp = require('child_process');
const P = require('../src/prices.js');
const { Store, SCHEMA } = require('./lib/store.js');
const { applyCardmarket, applyEbay, finalize } = require('./lib/entries.js');
const src = require('./lib/sources.js');
const PLAN = require('./lib/scrape-plan.js'), EBQ = require('./lib/ebay.js');

const root = path.join(__dirname, '..');
const arg = (n, d) => { const a = process.argv.find(x => x === '--' + n || x.startsWith('--' + n + '=')); return a ? (a.includes('=') ? a.split('=').slice(1).join('=') : true) : d; };
const dir = path.resolve(root, String(arg('store', 'store'))), port = +arg('port', 8787);
const journalF = path.join(root, 'build/ingest-journal.jsonl'), debugDir = path.join(root, 'build/ingest-debug');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'prices.config.json'), 'utf8'));
const every = +arg('publish-minutes', 10); // with --publish: push every N minutes; 0 = only when asked (POST /publish) and on exit

// ---------- card lookup ----------
// The card map changes with the daily build (cards added or removed): it is re-read whenever the file changes, so a
// running helper always queues the current cards.
const mapF = path.join(root, 'data/card-map.json.gz');
let map, mapMtime = 0;
const cards = new Map(), byCm = new Map(), byPc = new Map();
function loadCards() {
  const m = fs.statSync(mapF).mtimeMs; if (m === mapMtime) return false;
  map = JSON.parse(zlib.gunzipSync(fs.readFileSync(mapF))); mapMtime = m;
  cards.clear(); byCm.clear();
  for (const c of map.cards) { cards.set(c[0], c); for (const [cm] of c[6]) byCm.set(cm, c[0]); }
  return true;
}
loadCards();
function refreshCards() { // forget scraper bookkeeping for cards that no longer exist
  if (!loadCards() || !state) return;
  for (const k of ['misses', 'capture']) for (const site of Object.keys(state[k] || {})) for (const id of Object.keys(state[k][site])) if (!cards.has(id)) delete state[k][site][id];
  for (const id of Object.keys(state.urls.pricecharting)) if (!cards.has(id)) delete state.urls.pricecharting[id];
  for (const cm of Object.keys(state.urls.cardmarket)) if (!byCm.has(+cm)) delete state.urls.cardmarket[cm];
  console.log('card map changed: ' + cards.size + ' cards');
}
for (const f of fs.readdirSync(path.join(root, 'data/pricecharting'))) for (const line of fs.readFileSync(path.join(root, 'data/pricecharting', f), 'utf8').split('\n').filter(Boolean)) {
  try { const [id, pc] = f.endsWith('.raw') ? line.split('\t') : [JSON.parse(line).id, JSON.parse(line).pc]; if (pc) byPc.set(pc.split(/[?#]/)[0], id); } catch (e) {}
}
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function search(q, n) {
  const words = norm(q).split(/[^a-z0-9぀-ヿ一-鿿/]+/).filter(Boolean);
  const out = [];
  for (const c of map.cards) {
    const hay = norm([c[0], c[2], c[9] || '', Object.values(c[8] || {}).join(' '), c[10], c[11], c[3] + '/' + c[4], c[3]].join(' '));
    let s = 0; for (const w of words) if (hay.includes(w)) s += w.length; else { s = -1; break; }
    if (s > 0) out.push([s, c]);
  }
  return out.sort((a, b) => b[0] - a[0]).slice(0, n || 12).map(([, c]) => ({ id: c[0], name: c[2], en: c[9] || '', set: c[11], code: c[10], number: c[3] + (c[4] ? '/' + c[4] : ''), lang: c[5] }));
}
function resolve(m) {
  if (m.cardId && cards.has(m.cardId)) return m.cardId;
  if (m.data && m.data.idProduct && byCm.has(m.data.idProduct)) return byCm.get(m.data.idProduct);
  if (m.site === 'pricecharting' && byPc.has(String(m.url).split(/[?#]/)[0])) return byPc.get(String(m.url).split(/[?#]/)[0]);
  return null;
}

// ---------- store ----------
let store, fx, fxDate, sum, meta, state;
function load() {
  store = new Store(dir);
  sum = store.read('summary.json.gz', null); meta = store.read('meta.json', null);
  state = store.read('state.json', { v: SCHEMA, cm: {}, eb: {} }); state.capture = state.capture || {};
  state.urls = state.urls || {}; state.urls.cardmarket = state.urls.cardmarket || {}; state.urls.pricecharting = state.urls.pricecharting || {};
  for (const [pc, id] of byPc) if (!state.urls.pricecharting[id]) state.urls.pricecharting[id] = pc;
  if (sum && sum.fx) { fx = sum.fx; fxDate = sum.fxDate; }
}
const entries = () => (sum = sum || { v: SCHEMA, at: new Date().toISOString(), sources: {}, cards: {} }).cards;
function saveAll(ids) {
  const at = new Date().toISOString(), E = entries();
  finalize(store, E, cards, cfg, fx, Date.now(), ids);
  store.write('summary.json.gz', Object.assign(sum, { v: SCHEMA, fx, fxDate, scrapedAt: at, cards: E }), 'summary');
  store.write('state.json', state, 'state');
  store.write('meta.json', Object.assign({ v: SCHEMA, at, sources: {} }, meta || {}, { fx, fxDate, scrapedAt: at, cards: Object.keys(E).length }), 'meta');
  meta = store.read('meta.json');
}

// one capture -> store; returns a short report. Deterministic, so captures can be replayed from the journal.
function apply(m, card) {
  const at = m.at, E = entries(), e = E[card[0]] || (E[card[0]] = {}), d = m.data, source = m.via === 'scraper' ? 'scraper' : 'extension';
  const page = String(m.url || '').split('#')[0];
  if (m.site === 'cardmarket') {
    const rel = store.listingFile('cardmarket', card[1], card[0]), old = store.read(rel, null);
    const products = (old ? old.products : []).filter(p => p.cm !== (d.idProduct || 0));
    const label = (card[6].find(x => x[0] === d.idProduct) || [])[1] || d.title || 'Cardmarket';
    products.push({ cm: d.idProduct || 0, label, articles: d.articles.map(a => (a[12] = d.idProduct || 0, a)) });
    applyCardmarket(store, e, card, products, at, source);
    if (d.idProduct && /cardmarket\.com\/[a-z]{2}\/Pokemon\/Products\/Singles\//.test(page)) state.urls.cardmarket[d.idProduct] = page.split('?')[0]; // visit directly next time
    return d.articles.length + ' Cardmarket listings' + (d.idProduct ? ' (product ' + d.idProduct + ')' : '');
  }
  if (m.site === 'ebay') {
    const rel = store.listingFile('ebay', card[1], card[0]), old = store.read(rel, null) || { queries: {}, active: [], sold: [] };
    const keep = rows => rows.filter(r => r[5] !== d.mp);
    // automated searches keep only items naming this card and its number, like the API collector; manual captures keep all
    const items = m.via === 'scraper' ? EBQ.relevant(card, d.items) : d.items;
    const active = d.sold ? old.active : keep(old.active).concat(items), sold = d.sold ? keep(old.sold).concat(items) : old.sold;
    applyEbay(store, e, card, active, sold, Object.assign({}, old.queries, { [d.mp]: d.query }), fx, at, source);
    return items.length + (items.length !== d.items.length ? ' of ' + d.items.length : '') + ' eBay ' + (d.sold ? 'sold' : 'for-sale') + ' items (' + d.mp.replace('EBAY_', '') + ')';
  }
  if (m.site === 'pricecharting') {
    const g = ['ungraded', 'grade7', 'grade8', 'grade9', 'grade9_5', 'psa10'].map(k => d.prices[k] == null ? null : +d.prices[k]);
    store.write(store.listingFile('pricecharting', card[1], card[0]), { v: SCHEMA, id: card[0], at, source, url: d.url, g, sold: d.sold }, 'pcListing');
    if (d.url) { state.urls.pricecharting[card[0]] = d.url; byPc.set(d.url, card[0]); }
    e.pc = { u: d.url, g, at, n: d.sold.length };
    return 'PriceCharting: ' + g.filter(x => x != null).length + ' graded prices, ' + d.sold.length + ' sales';
  }
  throw new Error('unknown site ' + m.site);
}

// ---------- publishing to the prices branch ----------
const git = (cwd, ...a) => cp.execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
let base = null, pending = 0, publishing = false, lastPublish = null;
function pull() {
  git(root, 'fetch', '-q', 'origin', 'prices');
  const head = git(root, 'rev-parse', 'FETCH_HEAD');
  if (!fs.existsSync(path.join(dir, '.git'))) git(root, 'worktree', 'add', '-q', '--detach', dir, head);
  else { git(dir, 'checkout', '-q', '-f', '--detach', head); git(dir, 'clean', '-qfd'); }
  base = head; load();
}
async function publish() {
  if (publishing) return { ok: false, error: 'already pushing' };
  if (!pending) return { ok: true, nothing: true };
  publishing = true;
  try {
    git(root, 'fetch', '-q', 'origin', 'prices');
    const head = git(root, 'rev-parse', 'FETCH_HEAD');
    if (head !== base) { // the collector pushed meanwhile: take its version, replay our captures on top
      const lines = fs.readFileSync(journalF, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(j => !j.published);
      pull();
      const ids = []; for (const j of lines) { const c = cards.get(j.card); if (c) { apply(j.m, c); ids.push(c[0]); } }
      saveAll(ids);
      console.log('replayed ' + lines.length + ' captures on top of the collector\'s newer version');
    }
    const bad = store.verify(); if (bad.length) throw new Error('verify failed: ' + bad.join('; '));
    git(dir, 'add', '-A');
    if (git(dir, 'status', '--porcelain')) {
      git(dir, 'checkout', '-q', '--orphan', 'capture-' + Date.now());
      git(dir, '-c', 'user.name=price-capture', '-c', 'user.email=capture@localhost', 'commit', '-q', '-m', 'Prices, captured ' + new Date().toISOString().slice(0, 16) + 'Z');
      git(dir, 'push', '-q', '-f', 'origin', 'HEAD:prices');
      base = git(dir, 'rev-parse', 'HEAD');
      console.log('published ' + pending + ' captures to the prices branch');
    }
    // mark the journal as published
    fs.writeFileSync(journalF, fs.readFileSync(journalF, 'utf8').split('\n').filter(Boolean).map(l => JSON.stringify(Object.assign(JSON.parse(l), { published: true }))).join('\n') + '\n');
    pending = 0; lastPublish = { at: new Date().toISOString(), ok: true };
  } catch (e) { console.error('publish failed (will retry): ' + e.message); lastPublish = { at: new Date().toISOString(), ok: false, error: e.message }; }
  finally { publishing = false; }
  return lastPublish;
}

// ---------- http ----------
function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' });
  res.end(type ? body : JSON.stringify(body));
}
function body(req) { return new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 30e6) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { no(e); } }); }); }

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');
  if (u.pathname === '/status') return send(res, 200, { ok: true, store: dir, publish: !!arg('publish'), pending, cards: Object.keys(entries()).length, fx: fx && fx.USD, scrapedAt: meta && meta.scrapedAt });
  if (u.pathname === '/sites' || u.pathname === '/queue') refreshCards();
  if (u.pathname === '/sites') return send(res, 200, {
    sites: PLAN.siteStatus(state || {}, cards), publish: !!arg('publish'), pending, lastPublish,
    collectorAt: (meta && meta.at) || null, store: dir });
  if (u.pathname === '/queue') {
    const site = u.searchParams.get('site');
    if (!PLAN.SITES.includes(site)) return send(res, 400, { error: 'site must be one of ' + PLAN.SITES.join(', ') });
    const n = Math.max(1, Math.min(500, +u.searchParams.get('n') || 20)), only = u.searchParams.get('only') || '';
    const list = PLAN.pickCards(site, { cards, entries: entries(), state, cfg, n, only });
    return send(res, 200, { site, items: list.map(c => PLAN.plan(site, c, { cfg, urls: state.urls })), secondsBetweenPages: (cfg.scrape && cfg.scrape.secondsBetweenPages) || 7 });
  }
  if (u.pathname === '/skip' && req.method === 'POST') { // the scraper found nothing for this card: don't queue it again for staleHours
    const m = await body(req);
    if (!PLAN.SITES.includes(m.site) || !cards.has(m.card)) return send(res, 400, { error: 'site and card required' });
    state.misses = state.misses || {}; (state.misses[m.site] = state.misses[m.site] || {})[m.card] = new Date().toISOString();
    store.write('state.json', state, 'state'); store.written = [];
    console.log(`${new Date().toISOString().slice(11, 19)} ${m.card} ${m.site}: skipped (${String(m.reason || 'no match').slice(0, 120)})`);
    return send(res, 200, { ok: true });
  }
  if (u.pathname === '/publish' && req.method === 'POST') {
    if (!arg('publish')) return send(res, 400, { error: 'This helper keeps captures in ' + dir + ' only. Restart it with: npm run helper' });
    return send(res, 200, Object.assign({}, await publish(), { pending }));
  }
  if (u.pathname === '/cards') return send(res, 200, search(u.searchParams.get('q') || '', 12));
  if (u.pathname === '/resolve') {
    const cm = +u.searchParams.get('cm'), pc = u.searchParams.get('pc');
    const id = (cm && byCm.get(cm)) || (pc && byPc.get(pc.split(/[?#]/)[0])) || null;
    return send(res, 200, { id, card: id ? search(id, 1)[0] : null });
  }
  if (u.pathname.startsWith('/store/') && req.method === 'GET') { // the store, for a locally built page
    const f = path.join(dir, decodeURIComponent(u.pathname.slice(7)));
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(res, 404, { error: 'not found' });
    return send(res, 200, fs.readFileSync(f), f.endsWith('.json') ? 'application/json' : 'application/octet-stream');
  }
  if (u.pathname === '/ingest' && req.method === 'POST') {
    const m = await body(req);
    if (!['cardmarket', 'ebay', 'pricecharting'].includes(m.site) || !m.data) return send(res, 400, { error: 'site and data required' });
    if (!m.data.found && !(m.via === 'scraper' && m.empty)) { // nothing recognised (the scraper sends empty: true for a real page with no results): keep a copy of the page so the parser can be fixed
      if (m.html) { fs.mkdirSync(debugDir, { recursive: true }); fs.writeFileSync(path.join(debugDir, m.site + '-' + Date.now() + '.html'), m.html); }
      return send(res, 422, { error: 'no prices recognised on this page' + (m.html ? '; a copy was saved in build/ingest-debug/ for fixing the parser' : '') });
    }
    const id = resolve(m); if (!id) return send(res, 409, { error: 'which card is this?', need: 'card', suggestions: search(m.data.title || m.data.query || '', 8) });
    if (!fx) { const r = await src.fx(); fx = r.fx; fxDate = r.date; }
    const at = new Date().toISOString(), j = { at, card: id, m: Object.assign({}, m, { at, html: undefined }) };
    const report = apply(j.m, cards.get(id));
    (state.capture[m.site] = state.capture[m.site] || {})[id] = at;
    saveAll([id]);
    const bad = store.verify(); store.written = [];
    if (bad.length) return send(res, 500, { error: 'store validation failed: ' + bad.join('; ') });
    fs.mkdirSync(path.dirname(journalF), { recursive: true }); fs.appendFileSync(journalF, JSON.stringify(j) + '\n');
    pending++;
    const e = entries()[id], cov = P.coverage({ guide: e.g, listings: e.ln || e.ctn, tcg: e.t, ebayActive: e.ea, ebaySold: e.es || (e.pc && e.pc.n), graded: e.pc && e.pc.g.some(x => x != null) });
    console.log(`${at.slice(11, 19)} ${id} ${report}`);
    return send(res, 200, { ok: true, card: search(id, 1)[0], report, coverage: cov.tier + ' (' + cov.n + '/6 in the store)', pending });
  }
  send(res, 404, { error: 'not found' });
}

(async () => {
  if (arg('publish')) { pull(); if (every > 0) setInterval(publish, every * 60e3); } else load();
  if (!fx) try { const r = await src.fx(); fx = r.fx; fxDate = r.date; } catch (e) { console.warn('no exchange rates yet: ' + e.message); }
  http.createServer((q, s) => handle(q, s).catch(e => send(s, 500, { error: e.message }))).listen(port, '127.0.0.1', () =>
    console.log(`POcKEtMONey capture helper on http://127.0.0.1:${port}  store: ${dir}${arg('publish') ? (every > 0 ? '  (pushing every ' + every + ' min)' : '  (pushes when you click Push to GitHub, and on exit)') : ''}`));
  process.on('SIGINT', async () => { if (arg('publish')) { console.log('publishing before exit…'); await publish(); } process.exit(0); });
})();
