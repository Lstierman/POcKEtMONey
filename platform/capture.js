// The platform's view of the price store: knows every card, writes captures (from the browser extension and from the
// scraper) into the store in the same files and format as the hourly collector (listings/<site>/<set>/<card>.json,
// summary.json.gz, history/, validated on write), journals them, and optionally publishes to the "prices" branch.
//
// Publishing: the store becomes a worktree of the "prices" branch; new captures are pushed every few minutes. If the
// hourly collector pushed in between, the store is reset to that version and the captures are replayed on top
// (journal: build/ingest-journal.jsonl), so neither side loses data.
const fs = require('fs'), path = require('path'), zlib = require('zlib'), cp = require('child_process');
const P = require('../src/prices.js');
const { Store, SCHEMA } = require('../scripts/lib/store.js');
const { applyCardmarket, applyEbay, finalize } = require('../scripts/lib/entries.js');
const src = require('../scripts/lib/sources.js');

const ROOT = path.join(__dirname, '..');
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

class Capture {
  constructor({ dir, cfg, root = ROOT, log = console }) {
    this.dir = dir; this.cfg = cfg; this.root = root; this.log = log;
    this.journalF = path.join(root, 'build/ingest-journal.jsonl'); this.debugDir = path.join(root, 'build/ingest-debug');
    this.base = null; this.pending = 0; this.publishing = false; this.fx = null; this.fxDate = null;
    // card lookup
    this.map = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'data/card-map.json.gz'))));
    this.cards = new Map(this.map.cards.map(c => [c[0], c])); this.byCm = new Map(); this.byPc = new Map();
    for (const c of this.map.cards) for (const [cm] of c[6]) this.byCm.set(cm, c[0]);
    const pcDir = path.join(root, 'data/pricecharting');
    for (const f of fs.readdirSync(pcDir)) for (const line of fs.readFileSync(path.join(pcDir, f), 'utf8').split('\n').filter(Boolean)) {
      try { const [id, pc] = f.endsWith('.raw') ? line.split('\t') : [JSON.parse(line).id, JSON.parse(line).pc]; if (pc) this.byPc.set(pc.split(/[?#]/)[0], id); } catch (e) {}
    }
  }

  // ---------- cards ----------
  search(q, n) {
    const words = norm(q).split(/[^a-z0-9぀-ヿ一-鿿/:-]+/).filter(Boolean), out = [];
    for (const c of this.map.cards) {
      const hay = norm([c[0], c[2], c[9] || '', Object.values(c[8] || {}).join(' '), c[10], c[11], c[3] + '/' + c[4], c[3]].join(' '));
      let s = 0; for (const w of words) if (hay.includes(w)) s += w.length; else { s = -1; break; }
      if (s > 0) out.push([s + (c[0] === q ? 100 : 0), c]);
    }
    return out.sort((a, b) => b[0] - a[0]).slice(0, n || 12).map(([, c]) => this.describe(c));
  }
  describe(c) { return { id: c[0], name: c[2], en: c[9] || '', set: c[11], code: c[10], number: c[3] + (c[4] ? '/' + c[4] : ''), lang: c[5] }; }
  resolve(m) {
    if (m.cardId && this.cards.has(m.cardId)) return m.cardId;
    if (m.data && m.data.idProduct && this.byCm.has(m.data.idProduct)) return this.byCm.get(m.data.idProduct);
    if (m.site === 'pricecharting' && this.byPc.has(String(m.url).split(/[?#]/)[0])) return this.byPc.get(String(m.url).split(/[?#]/)[0]);
    return null;
  }

  // ---------- store ----------
  load() {
    this.store = new Store(this.dir);
    this.sum = this.store.read('summary.json.gz', null); this.meta = this.store.read('meta.json', null);
    this.state = this.store.read('state.json', { v: SCHEMA, cm: {}, eb: {} });
    this.state.capture = this.state.capture || {}; this.state.scrape = this.state.scrape || {};
    if (this.sum && this.sum.fx) { this.fx = this.sum.fx; this.fxDate = this.sum.fxDate; }
    return this;
  }
  entries() { return (this.sum = this.sum || { v: SCHEMA, at: new Date().toISOString(), sources: {}, cards: {} }).cards; }
  async ensureFx() {
    if (this.fx) return;
    const r = await src.fx(); this.fx = r.fx; this.fxDate = r.date;
  }
  saveAll(ids) {
    if (!this.fx) throw new Error('no exchange rates yet');
    const at = new Date().toISOString(), E = this.entries(), { store } = this;
    finalize(store, E, this.cards, this.cfg, this.fx, Date.now(), ids);
    store.write('summary.json.gz', Object.assign(this.sum, { v: SCHEMA, fx: this.fx, fxDate: this.fxDate, scrapedAt: at, cards: E }), 'summary');
    store.write('state.json', this.state, 'state');
    store.write('meta.json', Object.assign({ v: SCHEMA, at, sources: {} }, this.meta || {}, { fx: this.fx, fxDate: this.fxDate, scrapedAt: at, cards: Object.keys(E).length }), 'meta');
    this.meta = store.read('meta.json');
    const bad = store.verify(); store.written = [];
    if (bad.length) throw new Error('store validation failed: ' + bad.join('; '));
  }

  // one capture -> store; returns a short report. Deterministic, so captures can be replayed from the journal.
  apply(m, card) {
    const at = m.at, E = this.entries(), e = E[card[0]] || (E[card[0]] = {}), d = m.data, { store } = this, source = m.source || 'extension';
    const kind = source === 'scrape' ? 'scrape' : 'capture';
    (this.state[kind][m.site] = this.state[kind][m.site] || {})[card[0]] = at;
    if (m.site === 'cardmarket') {
      const rel = store.listingFile('cardmarket', card[1], card[0]), old = store.read(rel, null);
      const products = (old ? old.products : []).filter(p => p.cm !== (d.idProduct || 0));
      const label = (card[6].find(x => x[0] === d.idProduct) || [])[1] || d.title || 'Cardmarket';
      products.push({ cm: d.idProduct || 0, label, articles: d.articles.map(a => (a[12] = d.idProduct || 0, a)) });
      applyCardmarket(store, e, card, products, at, source);
      return d.articles.length + ' Cardmarket listings' + (d.idProduct ? ' (product ' + d.idProduct + ')' : '');
    }
    if (m.site === 'ebay') {
      const rel = store.listingFile('ebay', card[1], card[0]), old = store.read(rel, null) || { queries: {}, active: [], sold: [] };
      const keep = rows => rows.filter(r => r[5] !== d.mp);
      const active = d.sold ? old.active : keep(old.active).concat(d.items), sold = d.sold ? keep(old.sold).concat(d.items) : old.sold;
      applyEbay(store, e, card, active, sold, Object.assign({}, old.queries, { [d.mp]: d.query }), this.fx, at, source);
      return d.items.length + ' eBay ' + (d.sold ? 'sold' : 'for-sale') + ' items (' + d.mp.replace('EBAY_', '') + ')';
    }
    if (m.site === 'pricecharting') {
      const g = ['ungraded', 'grade7', 'grade8', 'grade9', 'grade9_5', 'psa10'].map(k => d.prices[k] == null ? null : +d.prices[k]);
      store.write(store.listingFile('pricecharting', card[1], card[0]), { v: SCHEMA, id: card[0], at, source, url: d.url, g, sold: d.sold }, 'pcListing');
      e.pc = { u: d.url, g, at, n: d.sold.length };
      return 'PriceCharting: ' + g.filter(x => x != null).length + ' graded prices, ' + d.sold.length + ' sales';
    }
    throw new Error('unknown site ' + m.site);
  }
  // applies and journals a capture (not saved yet: call saveAll)
  record(m, id) {
    const at = new Date().toISOString(), j = { at, card: id, m: Object.assign({}, m, { at, html: undefined }) };
    const report = this.apply(j.m, this.cards.get(id));
    fs.mkdirSync(path.dirname(this.journalF), { recursive: true }); fs.appendFileSync(this.journalF, JSON.stringify(j) + '\n');
    this.pending++;
    return report;
  }
  coverage(id) {
    const e = this.entries()[id] || {};
    return P.coverage({ guide: e.g, listings: e.ln || e.ctn, tcg: e.t, ebayActive: e.ea, ebaySold: e.es || (e.pc && e.pc.n), graded: e.pc && e.pc.g.some(x => x != null) });
  }

  // a capture sent by the extension: { site, url, cardId?, data, html? } -> { code, body }
  async ingest(m) {
    if (!['cardmarket', 'ebay', 'pricecharting'].includes(m.site) || !m.data) return { code: 400, body: { error: 'site and data required' } };
    if (!m.data.found) { // nothing recognised: keep a copy of the page so the parser can be fixed
      if (m.html) { fs.mkdirSync(this.debugDir, { recursive: true }); fs.writeFileSync(path.join(this.debugDir, m.site + '-' + Date.now() + '.html'), m.html); }
      return { code: 422, body: { error: 'no prices recognised on this page' + (m.html ? '; a copy was saved in build/ingest-debug/ for fixing the parser' : '') } };
    }
    const id = this.resolve(m);
    if (!id) return { code: 409, body: { error: 'which card is this?', need: 'card', suggestions: this.search(m.data.title || m.data.query || '', 8) } };
    await this.ensureFx();
    const report = this.record(Object.assign({}, m, { source: 'extension' }), id);
    this.saveAll([id]);
    const cov = this.coverage(id);
    this.log.log(`${new Date().toISOString().slice(11, 19)} ${id} ${report}`);
    return { code: 200, body: { ok: true, card: this.describe(this.cards.get(id)), report, coverage: cov.tier + ' (' + cov.n + '/6 in the store)', pending: this.pending } };
  }

  // ---------- the "prices" branch ----------
  git(cwd, ...a) { return cp.execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); }
  // the store dir becomes a worktree of the latest origin/prices
  pull() {
    this.git(this.root, 'fetch', '-q', 'origin', 'prices');
    const head = this.git(this.root, 'rev-parse', 'FETCH_HEAD');
    if (!fs.existsSync(path.join(this.dir, '.git'))) this.git(this.root, 'worktree', 'add', '-q', '--detach', this.dir, head);
    else { this.git(this.dir, 'checkout', '-q', '-f', '--detach', head); this.git(this.dir, 'clean', '-qfd'); }
    this.base = head; this.load();
  }
  // an empty store (first start) is filled from the prices branch, so the scraper knows which cards already have data
  seed() {
    const empty = !fs.existsSync(this.dir) || !fs.readdirSync(this.dir).length;
    if (!empty) return false;
    try { if (fs.existsSync(this.dir)) fs.rmdirSync(this.dir); this.pull(); this.log.log('store filled from the prices branch'); return true; }
    catch (e) { this.log.warn('could not fetch the prices branch (' + e.message.split('\n')[0] + '); starting with an empty store'); fs.mkdirSync(this.dir, { recursive: true }); this.load(); return false; }
  }
  async publish() {
    if (this.publishing || !this.pending) return; this.publishing = true;
    const { root, dir } = this;
    try {
      this.git(root, 'fetch', '-q', 'origin', 'prices');
      const head = this.git(root, 'rev-parse', 'FETCH_HEAD');
      if (head !== this.base) { // the collector pushed meanwhile: take its version, replay our captures on top
        const lines = fs.readFileSync(this.journalF, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(j => !j.published);
        this.pull();
        const ids = []; for (const j of lines) { const c = this.cards.get(j.card); if (c) { this.apply(j.m, c); ids.push(c[0]); } }
        await this.ensureFx(); this.saveAll(ids);
        this.log.log('replayed ' + lines.length + ' captures on top of the collector\'s newer version');
      }
      this.git(dir, 'add', '-A');
      if (this.git(dir, 'status', '--porcelain')) {
        this.git(dir, 'checkout', '-q', '--orphan', 'capture-' + Date.now());
        this.git(dir, '-c', 'user.name=price-capture', '-c', 'user.email=capture@localhost', 'commit', '-q', '-m', 'Prices, captured ' + new Date().toISOString().slice(0, 16) + 'Z');
        this.git(dir, 'push', '-q', '-f', 'origin', 'HEAD:prices');
        this.base = this.git(dir, 'rev-parse', 'HEAD');
        this.log.log('published ' + this.pending + ' captures to the prices branch');
      }
      if (fs.existsSync(this.journalF)) // mark the journal as published
        fs.writeFileSync(this.journalF, fs.readFileSync(this.journalF, 'utf8').split('\n').filter(Boolean).map(l => JSON.stringify(Object.assign(JSON.parse(l), { published: true }))).join('\n') + '\n');
      this.pending = 0;
    } catch (e) { this.log.error('publish failed (will retry): ' + e.message); }
    finally { this.publishing = false; }
  }
}

module.exports = { Capture };
