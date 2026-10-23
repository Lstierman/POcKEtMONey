// Local helper for the capture extension (extension/). Receives what the extension read on a Cardmarket, eBay or
// PriceCharting page you opened, works out which card it is, and stores it in the price store, in the same files and
// format as the hourly collector (listings/<site>/<set>/<card>.json, summary.json.gz, history/, validated on write).
//
//   npm run ingest -- [--store=store] [--port=8787] [--publish] [--publish-minutes=10]
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

const root = path.join(__dirname, '..');
const arg = (n, d) => { const a = process.argv.find(x => x === '--' + n || x.startsWith('--' + n + '=')); return a ? (a.includes('=') ? a.split('=').slice(1).join('=') : true) : d; };
const dir = path.resolve(root, String(arg('store', 'store'))), port = +arg('port', 8787);
const journalF = path.join(root, 'build/ingest-journal.jsonl'), debugDir = path.join(root, 'build/ingest-debug');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'prices.config.json'), 'utf8'));

// ---------- card lookup ----------
const map = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'data/card-map.json.gz'))));
const cards = new Map(map.cards.map(c => [c[0], c])), byCm = new Map(), byPc = new Map();
for (const c of map.cards) for (const [cm] of c[6]) byCm.set(cm, c[0]);
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
  const at = m.at, E = entries(), e = E[card[0]] || (E[card[0]] = {}), d = m.data;
  if (m.site === 'cardmarket') {
    const rel = store.listingFile('cardmarket', card[1], card[0]), old = store.read(rel, null);
    const products = (old ? old.products : []).filter(p => p.cm !== (d.idProduct || 0));
    const label = (card[6].find(x => x[0] === d.idProduct) || [])[1] || d.title || 'Cardmarket';
    products.push({ cm: d.idProduct || 0, label, articles: d.articles.map(a => (a[12] = d.idProduct || 0, a)) });
    applyCardmarket(store, e, card, products, at, 'extension');
    return d.articles.length + ' Cardmarket listings' + (d.idProduct ? ' (product ' + d.idProduct + ')' : '');
  }
  if (m.site === 'ebay') {
    const rel = store.listingFile('ebay', card[1], card[0]), old = store.read(rel, null) || { queries: {}, active: [], sold: [] };
    const keep = rows => rows.filter(r => r[5] !== d.mp);
    const active = d.sold ? old.active : keep(old.active).concat(d.items), sold = d.sold ? keep(old.sold).concat(d.items) : old.sold;
    applyEbay(store, e, card, active, sold, Object.assign({}, old.queries, { [d.mp]: d.query }), fx, at, 'extension');
    return d.items.length + ' eBay ' + (d.sold ? 'sold' : 'for-sale') + ' items (' + d.mp.replace('EBAY_', '') + ')';
  }
  if (m.site === 'pricecharting') {
    const g = ['ungraded', 'grade7', 'grade8', 'grade9', 'grade9_5', 'psa10'].map(k => d.prices[k] == null ? null : +d.prices[k]);
    store.write(store.listingFile('pricecharting', card[1], card[0]), { v: SCHEMA, id: card[0], at, source: 'extension', url: d.url, g, sold: d.sold }, 'pcListing');
    e.pc = { u: d.url, g, at, n: d.sold.length };
    return 'PriceCharting: ' + g.filter(x => x != null).length + ' graded prices, ' + d.sold.length + ' sales';
  }
  throw new Error('unknown site ' + m.site);
}

// ---------- publishing to the prices branch ----------
const git = (cwd, ...a) => cp.execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
let base = null, pending = 0, publishing = false;
function pull() {
  git(root, 'fetch', '-q', 'origin', 'prices');
  const head = git(root, 'rev-parse', 'FETCH_HEAD');
  if (!fs.existsSync(path.join(dir, '.git'))) git(root, 'worktree', 'add', '-q', '--detach', dir, head);
  else { git(dir, 'checkout', '-q', '-f', '--detach', head); git(dir, 'clean', '-qfd'); }
  base = head; load();
}
async function publish() {
  if (publishing || !pending) return; publishing = true;
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
    pending = 0;
  } catch (e) { console.error('publish failed (will retry): ' + e.message); }
  finally { publishing = false; }
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
    if (!m.data.found) { // nothing recognised: keep a copy of the page so the parser can be fixed
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
  if (arg('publish')) { pull(); setInterval(publish, (+arg('publish-minutes', 10)) * 60e3); } else load();
  if (!fx) try { const r = await src.fx(); fx = r.fx; fxDate = r.date; } catch (e) { console.warn('no exchange rates yet: ' + e.message); }
  http.createServer((q, s) => handle(q, s).catch(e => send(s, 500, { error: e.message }))).listen(port, '127.0.0.1', () =>
    console.log(`POcKEtMONey capture helper on http://127.0.0.1:${port}  store: ${dir}${arg('publish') ? '  (publishing every ' + arg('publish-minutes', 10) + ' min)' : ''}`));
  process.on('SIGINT', async () => { if (arg('publish')) { console.log('publishing before exit…'); await publish(); } process.exit(0); });
})();
