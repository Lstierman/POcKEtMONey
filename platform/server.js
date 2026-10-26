// The platform's local web server (http://127.0.0.1:8787 by default).
//
//   GET  /                     the card index (index.html), reading prices from this platform's store
//   GET  /dashboard            what the scraper is doing: queue, CPU use, recent results
//   GET  /status               store and scraper summary
//   GET  /cards?q=             card search (the extension's "which card is this?")
//   GET  /resolve?cm=|pc=      card id for a Cardmarket product or PriceCharting page
//   GET  /store/<file>         the price store
//   POST /ingest               a capture from the extension
//   GET  /watchlist            watched cards with their freshness
//   POST /watchlist            { id } adds a card (it is scraped right away), { id, remove: true } removes it
//   DELETE /watchlist/<id>     removes a card
//   GET  /scraper              scheduler status
//   POST /scraper/pause | /scraper/resume | /scraper/plan
//   POST /scraper/enqueue      { id } scrape this card next
const http = require('http'), fs = require('fs'), path = require('path');
const { lastSeen } = require('./scheduler/planner.js');

function createServer({ capture, scheduler, watchlist, root, publish }) {
  const send = (res, code, body, type) => {
    res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Private-Network': 'true', 'Cache-Control': 'no-store' });
    res.end(type ? body : JSON.stringify(body));
  };
  const body = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 30e6) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { no(e); } }); });

  function watchInfo() {
    const E = capture.entries(), sites = scheduler ? scheduler.sites : ['ebay'];
    return watchlist.items.map(w => {
      const c = capture.cards.get(w.id), e = E[w.id];
      const seen = Object.fromEntries(sites.map(s => { const t = lastSeen(s, w.id, e, capture.state); return [s, t ? new Date(t).toISOString() : null]; }));
      const queued = scheduler ? sites.some(s => scheduler.queue.jobs.has(s + ':' + w.id)) || (scheduler.current && scheduler.current.id === w.id) : false;
      return Object.assign({}, w, c ? capture.describe(c) : { unknown: true }, { headline: e && e.h != null ? e.h : null, lastSeen: seen, queued });
    });
  }

  function page() { // the built page, pointed at this platform's store when it has one
    const f = path.join(root, 'index.html');
    if (!fs.existsSync(f)) return null;
    let html = fs.readFileSync(f, 'utf8');
    if (capture.store && capture.store.exists('summary.json.gz')) html = html.replace(/PRICES_URL = "[^"]*"/, 'PRICES_URL = "/store/"');
    return html;
  }

  async function handle(req, res) {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');
    if (p === '/' || p === '/index.html') { const h = page(); return h ? send(res, 200, h, 'text/html; charset=utf-8') : send(res, 404, { error: 'index.html not built yet: npm run build' }); }
    if (p === '/dashboard') return send(res, 200, fs.readFileSync(path.join(__dirname, 'dashboard.html')), 'text/html; charset=utf-8');
    if (p === '/status') return send(res, 200, { ok: true, platform: true, store: capture.dir, publish: !!publish, pending: capture.pending, cards: Object.keys(capture.entries()).length,
      fx: capture.fx && capture.fx.USD, scrapedAt: capture.meta && capture.meta.scrapedAt, watchlist: watchlist.ids(), scraper: scheduler ? { paused: scheduler.status().paused, queued: scheduler.queue.size, current: scheduler.current } : null });
    if (p === '/cards') return send(res, 200, capture.search(u.searchParams.get('q') || '', 12));
    if (p === '/resolve') {
      const cm = +u.searchParams.get('cm'), pc = u.searchParams.get('pc');
      const id = (cm && capture.byCm.get(cm)) || (pc && capture.byPc.get(pc.split(/[?#]/)[0])) || null;
      return send(res, 200, { id, card: id ? capture.describe(capture.cards.get(id)) : null });
    }
    if (p.startsWith('/store/') && req.method === 'GET') {
      const f = path.resolve(capture.dir, decodeURIComponent(p.slice(7)));
      if (!f.startsWith(path.resolve(capture.dir) + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(res, 404, { error: 'not found' });
      return send(res, 200, fs.readFileSync(f), f.endsWith('.json') ? 'application/json' : 'application/octet-stream');
    }
    if (p === '/ingest' && req.method === 'POST') { const r = await capture.ingest(await body(req)); return send(res, r.code, r.body); }

    if (p === '/watchlist' && req.method === 'GET') return send(res, 200, { cards: watchInfo() });
    if (p === '/watchlist' && req.method === 'POST') {
      const b = await body(req);
      if (!b.id || !capture.cards.has(b.id)) return send(res, 404, { error: 'unknown card ' + b.id, suggestions: b.id ? capture.search(String(b.id), 5) : [] });
      const changed = b.remove ? watchlist.remove(b.id) : watchlist.add(b.id, b.note);
      return send(res, 200, { ok: true, changed, watched: watchlist.has(b.id), cards: watchlist.ids() });
    }
    if (p.startsWith('/watchlist/') && req.method === 'DELETE') {
      const id = decodeURIComponent(p.slice(11)); const changed = watchlist.remove(id);
      return send(res, 200, { ok: true, changed, watched: false, cards: watchlist.ids() });
    }

    if (p.startsWith('/scraper')) {
      if (!scheduler) return send(res, 404, { error: 'the scraper is off (started with --no-scrape)' });
      if (p === '/scraper' && req.method === 'GET') return send(res, 200, scheduler.status());
      if (req.method === 'POST') {
        if (p === '/scraper/pause') scheduler.pause();
        else if (p === '/scraper/resume') scheduler.resume();
        else if (p === '/scraper/plan') scheduler.plan();
        else if (p === '/scraper/enqueue') { const b = await body(req); if (!scheduler.enqueue(b.id)) return send(res, 404, { error: 'unknown card ' + b.id }); }
        else return send(res, 404, { error: 'not found' });
        return send(res, 200, scheduler.status());
      }
    }
    send(res, 404, { error: 'not found' });
  }

  return http.createServer((q, s) => handle(q, s).catch(e => send(s, 500, { error: e.message })));
}

module.exports = { createServer };
