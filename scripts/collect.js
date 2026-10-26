// Hourly collector (GitHub Actions). Updates the price store (see scripts/lib/store.js) with the free bulk feeds that
// cover every card at once: exchange rates, Cardmarket's price guide and TCGplayer (tcgcsv). Per-card data (every
// Cardmarket listing, eBay for sale and sold, PriceCharting) comes from the scraper extension through the helper; the
// collector keeps it and recomputes headlines and history.
// Usage: node scripts/collect.js <store dir> [--force] [--only=fx,guide,tcg]
// The run is skipped when the last one is younger than intervalMinutes (prices.config.json, or PRICE_INTERVAL_MINUTES).
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const P = require('../src/prices.js');
const { Store, SCHEMA } = require('./lib/store.js');
const src = require('./lib/sources.js');
const { finalize } = require('./lib/entries.js');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2), flag = n => args.find(a => a === '--' + n || a.startsWith('--' + n + '='));
const dir = args.find(a => !a.startsWith('--')) || path.join(root, 'store');
const only = flag('only') ? flag('only').split('=')[1].split(',') : null, want = s => !only || only.includes(s);
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'prices.config.json'), 'utf8'));
if (process.env.PRICE_INTERVAL_MINUTES) cfg.intervalMinutes = +process.env.PRICE_INTERVAL_MINUTES;

(async () => {
  const now = Date.now(), at = new Date(now).toISOString(), hour = at.slice(0, 13);
  const store = new Store(dir);
  const meta0 = store.read('meta.json', null);
  if (meta0 && !flag('force') && now - Date.parse(meta0.at) < (cfg.intervalMinutes - 5) * 60e3) {
    console.log(`not due: last run ${meta0.at}, interval ${cfg.intervalMinutes} min`); return;
  }
  const map = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'data/card-map.json.gz'))));
  const cards = new Map(map.cards.map(c => [c[0], c]));
  const state = store.read('state.json', { v: SCHEMA, cm: {}, eb: {} });
  const prev = store.read('summary.json.gz', null);
  const entries = (prev && prev.cards) || {};
  const sources = Object.assign({}, meta0 && meta0.sources), report = [];
  const note = (k, o) => { sources[k] = Object.assign({ at }, o); report.push(k + ': ' + (o.ok ? 'ok' : 'skipped') + (o.note ? ' (' + o.note + ')' : '') + (o.count != null ? ', ' + o.count + ' cards' : '')); };
  const E = id => entries[id] || (entries[id] = {});
  for (const id of Object.keys(entries)) if (!cards.has(id)) delete entries[id];

  // ---- exchange rates ----
  let fx = meta0 && meta0.fx, fxDate = meta0 && meta0.fxDate;
  try { const r = await src.fx(); fx = r.fx; fxDate = r.date; note('fx', { ok: true, note: 'ECB ' + r.date }); }
  catch (e) { note('fx', { ok: false, note: e.message + (fx ? ', kept ' + fxDate : '') }); }
  if (!fx) throw new Error('no exchange rates available');

  // ---- Cardmarket price guide ----
  if (want('guide')) try {
    const g = await src.guide(state.guideAt);
    if (g.unchanged) note('guide', { ok: true, note: 'unchanged since ' + g.createdAt, count: sources.guide && sources.guide.count });
    else {
      let n = 0;
      for (const c of cards.values()) {
        const rows = c[6].map(([cm, label]) => g.byProduct.has(cm) ? g.byProduct.get(cm).concat([label]) : null).filter(r => r && (r[1] != null || r[2] != null));
        if (rows.length) { E(c[0]).g = rows; n++; } else if (entries[c[0]]) delete entries[c[0]].g;
      }
      state.guideAt = g.createdAt; note('guide', { ok: true, note: 'price guide of ' + g.createdAt, count: n });
    }
  } catch (e) { note('guide', { ok: false, note: e.message }); }

  // ---- TCGplayer ----
  if (want('tcg')) try {
    const groups = new Set(); for (const c of cards.values()) for (const [, g] of c[7]) groups.add(g);
    const t = await src.tcgplayer(groups, state.tcgAt);
    if (t.unchanged) note('tcg', { ok: true, note: 'unchanged since ' + t.updated, count: sources.tcg && sources.tcg.count });
    else {
      let n = 0;
      for (const c of cards.values()) {
        const rows = c[7].flatMap(([pid]) => t.byProduct.get(pid) || []);
        if (rows.length) { E(c[0]).t = rows; n++; } else if (entries[c[0]] && !t.failed.length) delete entries[c[0]].t;
      }
      if (!t.failed.length) state.tcgAt = t.updated; // a partial fetch is retried next run
      note('tcg', { ok: true, note: 'tcgcsv ' + t.updated + (t.failed.length ? ', ' + t.failed.length + ' groups failed' : ''), count: n });
    }
  } catch (e) { note('tcg', { ok: false, note: e.message }); }

    // ---- headline (EUR) and history ----
  const changedSets = finalize(store, entries, cards, cfg, fx, now);

  // ---- summary, state, meta ----
  for (const k of ['cm', 'eb']) for (const id of Object.keys(state[k] || {})) if (!cards.has(id)) delete state[k][id];
  // sources that the scraper replaced: no longer reported
  for (const k of ['listings', 'cardtrader', 'ebay']) delete sources[k];
  state.v = SCHEMA;
  store.write('summary.json.gz', { v: SCHEMA, at, fx, fxDate, guideAt: state.guideAt || null, tcgAt: state.tcgAt || null, sources, cards: entries }, 'summary');
  store.write('state.json', state, 'state');
  store.write('meta.json', { v: SCHEMA, at, intervalMinutes: cfg.intervalMinutes, fx, fxDate, sources, cards: Object.keys(entries).length }, 'meta');
  const bad = store.verify();
  console.log(report.join('\n'));
  console.log(`store ${dir}: ${Object.keys(entries).length} cards with price data, ${store.written.length} files written, ${changedSets} history files changed`);
  if (bad.length) { console.error('VERIFY FAILED\n' + bad.join('\n')); process.exit(2); }
  console.log('verified: every written file re-read and valid');
})().catch(e => { console.error(e); process.exit(1); });
