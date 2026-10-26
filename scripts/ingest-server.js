// Local helper for the scraper extension (scraper-extension/) and the site's To watch list.
//
//   npm run helper    works on a copy of the "prices" branch in store/, pushes new data every 15 minutes, when you
//                     click "Push to GitHub" in the extension, when a run stops, and when you stop it with Ctrl+C
//   node scripts/ingest-server.js [--store=store] [--port=8787] [--publish] [--publish-minutes=15] [--watchlist=config/watchlist.json|none]
//                     without --publish: a local store only, nothing is pushed
//
// It decides what to scrape (scripts/lib/scrape-plan.js), stores what the extension read in the same files and
// format as the hourly collector (listings/<site>/<set>/<card>.json, summary.json.gz, history/, validated on write),
// and keeps the To watch list (watchlist.json in the store, so it is pushed and the site can show it). Cards listed in
// config/watchlist.json are added to the To watch list once (removing one on the site keeps it removed).
//
// With scrape.autoStart on (default), the scraper extension starts scraping by itself within a minute of the helper
// starting, and keeps its work under scrape.cpuLimitPercent (default 20 %) of the CPU.
//
//   GET  /sites                  per site: last scrape, cards with prices, watched cards up to date
//   GET  /queue?site=&n=&only=   the next cards to scrape: To watch first, then the catalog
//   POST /ingest                 one page's prices          POST /skip   no match (or failed) for a card
//   GET  /watch                  the To watch list          POST /watch  { add: [ids], remove: [ids] }
//   GET  /cards?q=               card search                POST /publish   push now
//   GET  /                       the site itself, built from src/page.html: open http://127.0.0.1:8787/
//   GET  /changes?since=<ms>     cards saved since then, for the site's live view
//   GET  /store/<file>           the store's files, so the site sees new data before it is pushed
//
// Every change is also written to a journal (build/ingest-journal.jsonl). If the hourly collector pushed in between,
// the store is reset to its version and the changes not pushed yet are replayed on top, so neither side loses data.
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), cp = require('child_process');
const P = require('../src/prices.js');
const { Store, SCHEMA } = require('./lib/store.js');
const { applyCardmarket, applyEbay, applyPricecharting, finalize } = require('./lib/entries.js');
const src = require('./lib/sources.js');
const PLAN = require('./lib/scrape-plan.js'), EBQ = require('./lib/ebay.js');

const root = path.join(__dirname, '..');
const arg = (n, d) => { const a = process.argv.find(x => x === '--' + n || x.startsWith('--' + n + '=')); return a ? (a.includes('=') ? a.split('=').slice(1).join('=') : true) : d; };
const dir = path.resolve(root, String(arg('store', 'store'))), port = +arg('port', 8787);
const journalF = path.resolve(root, String(arg('journal', 'build/ingest-journal.jsonl'))), debugDir = path.join(root, 'build/ingest-debug');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config/prices.config.json'), 'utf8'));
const every = +arg('publish-minutes', 15);
const SESSION = new Date().toISOString(); // the extension starts by itself once per helper session (see /sites) // with --publish: push every N minutes; 0 = only when asked (POST /publish) and on exit

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

// ---------- Cardmarket's product catalog: exact product name and expansion, for a precise search ----------
// build/sources/cm-products.json from the build if present, else downloaded once a week to build/cm-products.json
const CM_CATALOG = 'https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_6.json';
let cmInfo = null, cmInfoAt = 0;
async function cmCatalog() {
  if (cmInfo && Date.now() - cmInfoAt < 7 * 86400e3) return cmInfo;
  const built = path.join(root, 'build/sources/cm-products.json'), cached = path.join(root, 'build/cm-products.json');
  const fresh = f => fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 7 * 86400e3;
  let f = fresh(built) ? built : fresh(cached) ? cached : null;
  if (!f) try {
    const r = await fetch(CM_CATALOG); if (!r.ok) throw new Error('HTTP ' + r.status);
    fs.mkdirSync(path.dirname(cached), { recursive: true }); fs.writeFileSync(cached, Buffer.from(await r.arrayBuffer())); f = cached;
  } catch (e) { console.warn('Cardmarket product catalog not available (' + e.message + '): searching by name only'); f = fs.existsSync(built) ? built : fs.existsSync(cached) ? cached : null; }
  if (!f) { cmInfoAt = Date.now() - 6.9 * 86400e3; return null; } // try again in a few minutes
  const m = new Map(); for (const p of JSON.parse(fs.readFileSync(f, 'utf8')).products || []) m.set(p.idProduct, { name: p.name, idExpansion: p.idExpansion });
  cmInfo = m; cmInfoAt = Date.now(); console.log('Cardmarket product catalog: ' + m.size + ' products');
  return cmInfo;
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
  // the To watch list; a new store starts with the collector's `always` cards
  watch = store.read('watchlist.json', null);
  if (!watch) watch = { v: SCHEMA, at: new Date().toISOString(), cards: ((cfg.schedule && cfg.schedule.always) || []).map(id => [id, new Date().toISOString()]) };
}
let watch = null;
// cards changed since the helper started, for the site's live view: id -> { t: ms, what }
const changes = new Map();
function changed(id, what) { changes.delete(id); changes.set(id, { t: Date.now(), what }); if (changes.size > 5000) changes.delete(changes.keys().next().value); }
const watchIds = () => watch.cards.map(w => w[0]);
function applyWatch(op, at) { // { add: [ids], remove: [ids] }; returns whether anything changed
  const have = new Set(watchIds()); let changed = false;
  for (const id of op.remove || []) if (have.has(id)) { watch.cards = watch.cards.filter(w => w[0] !== id); have.delete(id); changed = true; }
  for (const id of op.add || []) if (cards.has(id) && !have.has(id)) { watch.cards.push([id, at]); have.add(id); changed = true; }
  if (op.seed) { const s = new Set(watch.seeded || []); for (const id of op.add || []) if (!s.has(id)) { s.add(id); changed = true; } watch.seeded = [...s]; }
  if (changed) { watch.at = at; store.write('watchlist.json', watch, 'watchlist'); store.written = []; }
  return changed;
}
// config/watchlist.json: cards to put on the To watch list. Each is added once (remembered in watch.seeded), so a card
// you remove on the site stays removed.
function seedWatch() {
  const w = String(arg('watchlist', 'config/watchlist.json')); if (w === 'none') return 0;
  const f = path.resolve(root, w); if (!fs.existsSync(f)) return 0;
  let list = [];
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); list = (Array.isArray(j) ? j : j.cards || []).map(x => typeof x === 'string' ? x : x && x.id).filter(Boolean); }
  catch (e) { console.warn('config/watchlist.json unreadable: ' + e.message); return 0; }
  const seeded = new Set(watch.seeded || []), add = list.filter(id => !seeded.has(id) && cards.has(id));
  if (!add.length) return 0;
  const at = new Date().toISOString(), op = { add, seed: true };
  if (applyWatch(op, at)) journal({ at, watch: op });
  console.log('To watch: ' + add.length + ' cards from config/watchlist.json added');
  return add.length;
}
function applySkip(k, at) { // { site, card, kind: 'miss' | 'fail' }
  const key = k.kind === 'fail' ? 'fails' : 'misses';
  (state[key] = state[key] || {}); (state[key][k.site] = state[key][k.site] || {})[k.card] = at;
}
function journal(j) { fs.mkdirSync(path.dirname(journalF), { recursive: true }); fs.appendFileSync(journalF, JSON.stringify(j) + '\n'); pending++; }
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
    const prod = { cm: d.idProduct || 0, label, articles: d.articles.map(a => (a[12] = d.idProduct || 0, a)) };
    // which filtered views the scraper loaded: [language id or 0 for all, minCondition or 0, offers seen, complete]
    if (Array.isArray(d.coverage)) prod.coverage = d.coverage.filter(x => Array.isArray(x) && x.length === 4).map(x => [+x[0] || 0, +x[1] || 0, +x[2] || 0, x[3] ? 1 : 0]);
    products.push(prod);
    applyCardmarket(store, e, card, products, at, source, fx);
    if (d.idProduct && /cardmarket\.com\/[a-z]{2}\/Pokemon\/Products\/Singles\//.test(page)) state.urls.cardmarket[d.idProduct] = page.split('?')[0]; // visit directly next time
    return d.articles.length + ' Cardmarket listings' + (d.idProduct ? ' (product ' + d.idProduct + ')' : '') +
      (prod.coverage ? ', ' + (prod.coverage.every(x => x[3]) ? 'complete' : prod.coverage.filter(x => x[3]).length + '/' + prod.coverage.length + ' views complete') : '');
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
    const g = applyPricecharting(store, e, card, d, fx, at, source);
    if (d.url) { state.urls.pricecharting[card[0]] = d.url; byPc.set(d.url, card[0]); }
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
  if (!fs.existsSync(path.join(dir, '.git'))) {
    // a plain store folder (from npm run ingest) is kept under another name; its captures are in the journal and
    // are replayed on top of the prices branch below
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
      const aside = dir + '-local-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      fs.renameSync(dir, aside); console.log('kept your local store as ' + aside);
    } else if (fs.existsSync(dir)) fs.rmdirSync(dir);
    git(root, 'worktree', 'prune');
    git(root, 'worktree', 'add', '-q', '--detach', dir, head);
  }
  else { git(dir, 'checkout', '-q', '-f', '--detach', head); git(dir, 'clean', '-qfd'); }
  base = head; load();
}
// re-applies the captures not pushed yet (build/ingest-journal.jsonl) to the store; returns how many
function replay() {
  if (!fs.existsSync(journalF)) return 0;
  const lines = fs.readFileSync(journalF, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(j => j && !j.published);
  const ids = []; let n = 0;
  if (!lines.length) return 0;
  for (const j of lines) {
    try {
      if (j.watch) { applyWatch(j.watch, j.at); n++; continue; }
      if (j.skip) { applySkip(j.skip, j.at); n++; continue; }
      const c = cards.get(j.card); if (!c) continue;
      apply(j.m, c); if (!j.m.partial) (state.capture[j.m.site] = state.capture[j.m.site] || {})[c[0]] = j.at; ids.push(c[0]); n++;
    } catch (e) { console.warn('skipped an old change (' + (j.card || 'watch list') + '): ' + e.message); }
  }
  if (ids.length) saveAll(ids); else store.write('state.json', state, 'state');
  store.written = [];
  return n;
}
async function publish() {
  if (publishing) return { ok: false, error: 'already pushing' };
  if (!pending) return { ok: true, nothing: true };
  publishing = true;
  try {
    git(root, 'fetch', '-q', 'origin', 'prices');
    const head = git(root, 'rev-parse', 'FETCH_HEAD');
    if (head !== base) { // the collector pushed meanwhile: take its version, replay our captures on top
      pull();
      console.log('replayed ' + replay() + ' captures on top of the collector\'s newer version');
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

// the scraper's CPU budget (scraper-extension/governor.js)
function cpuCfg() {
  const sc = cfg.scrape || {};
  return { limitPercent: sc.cpuLimitPercent == null ? 20 : sc.cpuLimitPercent, headroom: sc.cpuHeadroom == null ? 0.1 : sc.cpuHeadroom,
    overhead: sc.cpuOverhead || 1.5, pageLoadMs: sc.cpuPageLoadMs || 1500 };
}

// ---------- http ----------
function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Private-Network': 'true', 'Cache-Control': 'no-store' });
  res.end(type ? body : JSON.stringify(body));
}
function body(req) { return new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 30e6) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { no(e); } }); }); }

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');
  if ((u.pathname === '/' || u.pathname === '/index.html') && req.method === 'GET') { // the site, built from src/page.html
    try { return send(res, 200, require('./lib/page.js').servePage(root), 'text/html; charset=utf-8'); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (u.pathname === '/status') return send(res, 200, { ok: true, store: dir, publish: !!arg('publish'), pending, cards: Object.keys(entries()).length, fx: fx && fx.USD, scrapedAt: meta && meta.scrapedAt });
  if (u.pathname === '/sites' || u.pathname === '/queue') refreshCards();
  if (u.pathname === '/sites') return send(res, 200, {
    sites: PLAN.siteStatus(state || {}, cards, cfg, watchIds()), watch: watch.cards.length, publish: !!arg('publish'), pending, lastPublish,
    auto: { on: (cfg.scrape || {}).autoStart !== false, session: SESSION }, cpu: cpuCfg(),
    collectorAt: (meta && meta.at) || null, store: dir });
  if (u.pathname === '/changes') { // GET /changes?since=<ms>: the summary entries of cards saved since then (newest last)
    const since = +u.searchParams.get('since') || 0, out = {}, recent = [];
    for (const [id, c] of changes) if (c.t > since) { out[id] = entries()[id] || null; recent.push([id, c.t, c.what]); }
    return send(res, 200, { now: Date.now(), cards: out, recent: recent.slice(-50), fx, fxDate });
  }
  if (u.pathname === '/watch' && req.method === 'GET') return send(res, 200, { at: watch.at, cards: watch.cards.map(([id, at]) => {
    const c = cards.get(id), e = entries()[id];
    return c ? { id, at, label: PLAN.label(c), name: c[2], lang: c[5], price: e && e.h != null ? e.h : null } : { id, at, label: id + ' (no longer in the catalog)' };
  }) });
  if (u.pathname === '/watch' && req.method === 'POST') {
    const m = await body(req), op = { add: [].concat(m.add || []).map(String), remove: [].concat(m.remove || []).map(String) };
    const unknown = op.add.filter(id => !cards.has(id)), at = new Date().toISOString();
    if (applyWatch(op, at)) { journal({ at, watch: op }); console.log(`${at.slice(11, 19)} To watch: ${op.add.length ? '+' + op.add.join(', +') : ''}${op.remove.length ? ' -' + op.remove.join(', -') : ''}`); }
    return send(res, 200, { ok: true, cards: watchIds(), unknown });
  }
  if (u.pathname === '/queue') {
    const site = u.searchParams.get('site');
    if (!PLAN.SITES.includes(site)) return send(res, 400, { error: 'site must be one of ' + PLAN.SITES.join(', ') });
    const n = Math.max(1, Math.min(500, +u.searchParams.get('n') || 20)), only = u.searchParams.get('only') || '';
    const list = PLAN.pickCards(site, { cards, entries: entries(), state, cfg, n, only, watch: watchIds() });
    const sc = cfg.scrape || {}, c = cpuCfg(), pace = { gap: sc.secondsBetweenRequests || 1.5, conc: sc.parallelRequests || 2, pageSize: (sc.cardmarket && sc.cardmarket.pageSize) || 50,
      cpuLimit: c.limitPercent, cpuHeadroom: c.headroom, cpuOverhead: c.overhead, cpuPageLoadMs: c.pageLoadMs };
    const info = site === 'cardmarket' ? await cmCatalog() : null;
    return send(res, 200, { site, items: list.map(([c, phase]) => Object.assign(PLAN.plan(site, c, { cfg, urls: state.urls, cmInfo: info }), { phase })), pace });
  }
  if (u.pathname === '/skip' && req.method === 'POST') { // the scraper found nothing for this card: don't queue it again for staleHours
    const m = await body(req);
    if (!PLAN.SITES.includes(m.site) || !cards.has(m.card)) return send(res, 400, { error: 'site and card required' });
    const at = new Date().toISOString(), k = { site: m.site, card: m.card, kind: m.kind === 'fail' ? 'fail' : 'miss' };
    applySkip(k, at); store.write('state.json', state, 'state'); store.written = []; journal({ at, skip: k });
    console.log(`${at.slice(11, 19)} ${m.card} ${m.site}: ${k.kind === 'fail' ? 'failed' : 'no match'} (${String(m.reason || '').slice(0, 120)})`);
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
    let report;
    try {
      report = apply(j.m, cards.get(id));
      // a capture cut short by Stop is saved, but the card stays due, so the next run does it completely
      if (!m.partial) (state.capture[m.site] = state.capture[m.site] || {})[id] = at;
      saveAll([id]);
      const bad = store.verify(); if (bad.length) throw new Error('store validation failed: ' + bad.join('; '));
    } catch (e) {
      // a refused write must not leave the half-applied capture in memory, or every later capture fails too
      store.written = []; load();
      console.error(`${at.slice(11, 19)} ${id} ${m.site}: not saved: ${e.message}`);
      return send(res, 500, { error: 'not saved: ' + e.message });
    }
    store.written = [];
    changed(id, report);
    journal(j);
    console.log(`${at.slice(11, 19)} ${id} ${report}${m.partial ? ' (stopped part-way; done again next run)' : ''}`);
    return send(res, 200, { ok: true, card: search(id, 1)[0], report, pending });
  }
  send(res, 404, { error: 'not found' });
}

(async () => {
  if (arg('publish')) {
    pull();
    if (!fx) try { const r = await src.fx(); fx = r.fx; fxDate = r.date; } catch (e) {}
    pending = replay(); if (pending) console.log(pending + ' captures from earlier runs are waiting to be pushed');
    if (every > 0) setInterval(publish, every * 60e3);
  } else load();
  seedWatch();
  if (!fx) try { const r = await src.fx(); fx = r.fx; fxDate = r.date; } catch (e) { console.warn('no exchange rates yet: ' + e.message); }
  http.createServer((q, s) => handle(q, s).catch(e => send(s, 500, { error: e.message }))).listen(port, '127.0.0.1', () =>
    console.log(`POcKEtMONey helper: open the site at http://127.0.0.1:${port}/  store: ${dir}${arg('publish') ? (every > 0 ? '  (pushing every ' + every + ' min)' : '  (pushes when you click Push to GitHub, and on exit)') : ''}` +
      ((cfg.scrape || {}).autoStart !== false ? `\nThe scraper extension starts scraping by itself within a minute (To watch: ${watch.cards.length} cards), using at most ${cpuCfg().limitPercent}% CPU.` : '')));
  process.on('SIGINT', async () => { if (arg('publish')) { console.log('publishing before exit…'); await publish(); } process.exit(0); });
})();
