// Hourly price collector. Updates the price store (see scripts/lib/store.js) from every source it can reach:
//   always:            exchange rates, Cardmarket price guide, TCGplayer (tcgcsv)
//   with credentials:  Cardmarket listings (CARDMARKET_*), CardTrader listings (CARDTRADER_TOKEN), eBay for sale / sold (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET)
// Usage: node scripts/collect.js <store dir> [--force] [--only=fx,guide,tcg,cardmarket,cardtrader,ebay] [--cards=id,id]
// The run is skipped when the last one is younger than intervalMinutes (prices.config.json, or PRICE_INTERVAL_MINUTES).
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const P = require('../src/prices.js');
const { Store, SCHEMA } = require('./lib/store.js');
const { applyCardmarket, applyCardTrader, applyEbay, finalize } = require('./lib/entries.js');
const CT = require('./lib/cardtrader.js');
const src = require('./lib/sources.js');
const CM = require('./lib/cardmarket.js'), EB = require('./lib/ebay.js');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2), flag = n => args.find(a => a === '--' + n || a.startsWith('--' + n + '='));
const dir = args.find(a => !a.startsWith('--')) || path.join(root, 'store');
const only = flag('only') ? flag('only').split('=')[1].split(',') : null, want = s => !only || only.includes(s);
const forced = flag('cards') ? flag('cards').split('=')[1].split(',') : [];
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

  // ---- which cards get the per-card (budgeted) fetches this run ----
  const S = cfg.schedule;
  function due(stamps, eligible) {
    const list = [];
    for (const c of eligible) {
      const v = (entries[c[0]] && entries[c[0]].h) || 0, last = stamps[c[0]] ? Date.parse(stamps[c[0]]) : 0;
      const hot = S.always.includes(c[0]) || v >= S.hotEur;
      const period = (hot ? cfg.intervalMinutes / 60 : v >= S.warmEur ? S.warmEveryHours : S.coldEveryHours) * 3600e3;
      const overdue = (now - last) / period;
      if (forced.includes(c[0])) list.push([c, Infinity]);
      else if (!forced.length && overdue >= 0.95) list.push([c, overdue * (1 + Math.log1p(v))]);
    }
    return list.sort((a, b) => b[1] - a[1]).map(x => x[0]);
  }

  // ---- Cardmarket listings ----
  const cmCreds = CM.credentials();
  if (!want('cardmarket') || !cfg.cardmarket.enabled) {}
  else if (!cmCreds) note('listings', { ok: false, note: 'no Cardmarket API credentials (CARDMARKET_APP_TOKEN, …)' });
  else {
    const api = new CM.Cardmarket(cmCreds, cfg.cardmarket.requestsPerRun); let n = 0, failed = 0, stop = '';
    for (const c of due(state.cm, [...cards.values()].filter(c => c[6].length))) {
      try {
        const products = [];
        for (const [cm, label] of c[6].slice(0, cfg.cardmarket.maxProductsPerCard)) products.push({ cm, label, articles: await api.articles(cm) });
        applyCardmarket(store, E(c[0]), c, products, at, 'api'); state.cm[c[0]] = at; n++;
      } catch (e) { if (e.budget) break; if (e.fatal) { stop = e.message; break; } failed++; }
    }
    note('listings', { ok: !stop, note: (stop || 'requests ' + api.used + '/' + cfg.cardmarket.requestsPerRun) + (failed ? ', ' + failed + ' failed' : '') + (api.limit ? ', daily ' + api.limit.count + '/' + api.limit.max : ''), count: n });
  }

  // ---- CardTrader: listings per language and condition, one request per expansion ----
  const ctToken = process.env.CARDTRADER_TOKEN;
  if (!want('cardtrader') || !(cfg.cardtrader && cfg.cardtrader.enabled)) {}
  else if (!ctToken) note('cardtrader', { ok: false, note: 'no CardTrader API token (CARDTRADER_TOKEN)' });
  else {
    const api = new CT.CardTrader(ctToken, cfg.cardtrader.requestsPerRun), WEEK = 7 * 86400e3;
    const map = store.read('cardtrader-map.json', { v: SCHEMA, expansions: {} });
    let n = 0, mapped = 0, stop = '';
    const byCm = new Map(), byTcg = new Map();
    for (const c of cards.values()) { for (const [cm] of c[6]) byCm.set(cm, c[0]); for (const [t] of c[7]) byTcg.set(t, c[0]); }
    try {
      if (!map.listedAt || now - Date.parse(map.listedAt) > WEEK) {
        const r = await api.pokemonExpansions(); map.game = r.game; map.listedAt = at;
        for (const e of r.expansions) map.expansions[e.id] = Object.assign(map.expansions[e.id] || {}, { code: e.code, name: e.name });
      }
      for (const [eid, x] of Object.entries(map.expansions)) { // blueprint -> card mapping, refreshed weekly per expansion
        if (x.mappedAt && now - Date.parse(x.mappedAt) < WEEK) continue;
        x.bp = CT.mapBlueprints(await api.blueprints(eid), byCm, byTcg); x.mappedAt = at; mapped++;
      }
    } catch (e) { if (!e.budget) stop = e.message; }
    if (!stop) {
      const todo = Object.entries(map.expansions).filter(([, x]) => x.bp && Object.keys(x.bp).length)
        .sort((a, b) => ((a[1].fetchedAt || '') < (b[1].fetchedAt || '') ? -1 : 1));
      const toEur = (v, cur) => P.toEur(v, cur, fx);
      for (const [eid, x] of todo) {
        try {
          const res = await api.products(eid), groups = {};
          if (Array.isArray(res)) res.forEach(p => { (groups[p.blueprint_id] = groups[p.blueprint_id] || []).push(p); }); else Object.assign(groups, res);
          const byCard = new Map();
          for (const [bp, prods] of Object.entries(groups)) {
            const id = x.bp[bp]; if (!id) continue;
            if (!byCard.has(id)) byCard.set(id, []);
            byCard.get(id).push({ bp: +bp, articles: (prods || []).map(p => CT.productRow(p, toEur)).filter(Boolean) });
          }
          for (const id of new Set(Object.values(x.bp))) { const c = cards.get(id); if (c) { applyCardTrader(store, E(id), c, byCard.get(id) || [], at, 'api'); n++; } }
          x.fetchedAt = at;
        } catch (e) { if (e.budget) break; if (e.fatal) { stop = e.message; break; } }
      }
    }
    store.write('cardtrader-map.json', map, 'ctMap');
    note('cardtrader', { ok: !stop, note: (stop || 'requests ' + api.used + '/' + cfg.cardtrader.requestsPerRun) + (mapped ? ', ' + mapped + ' expansions mapped' : ''), count: n });
  }

  // ---- eBay ----
  const ebCreds = EB.credentials();
  if (!want('ebay') || !cfg.ebay.enabled) {}
  else if (!ebCreds) note('ebay', { ok: false, note: 'no eBay API credentials (EBAY_CLIENT_ID, EBAY_CLIENT_SECRET)' });
  else {
    const api = new EB.Ebay(ebCreds, cfg.ebay.callsPerRun); let n = 0, failed = 0, stop = '';
    let soldOn = cfg.ebay.sold && !(state.insightsBlockedUntil && Date.parse(state.insightsBlockedUntil) > now), soldNote = soldOn ? '' : 'sold: Marketplace Insights not granted';
    for (const c of due(state.eb, cards.values())) {
      try {
        const active = [], sold = [], queries = {}; // queries: the exact search per marketplace, kept as evidence
        for (const mp of cfg.ebay.marketplaces) {
          const q = EB.query(c, mp); queries[mp] = q;
          active.push(...EB.relevant(c, await api.forSale(q, mp, cfg.ebay.itemsPerSearch)));
          if (soldOn) try { sold.push(...EB.relevant(c, await api.sold(q, mp, cfg.ebay.itemsPerSearch))); }
          catch (e) { if (e.budget || e.fatal) throw e; if (e.denied || e.scope) { soldOn = false; soldNote = 'sold: ' + e.message; state.insightsBlockedUntil = new Date(now + 86400e3).toISOString(); } }
        }
        applyEbay(store, E(c[0]), c, active, sold, queries, fx, at, 'api'); state.eb[c[0]] = at; n++;
      } catch (e) { if (e.budget) break; if (e.fatal) { stop = e.message; break; } failed++; }
    }
    note('ebay', { ok: !stop, note: [stop || 'calls ' + api.used + '/' + cfg.ebay.callsPerRun, soldNote, failed ? failed + ' failed' : ''].filter(Boolean).join(', '), count: n });
  }

  // ---- headline (EUR) and history ----
  const changedSets = finalize(store, entries, cards, cfg, fx, now);

  // ---- summary, state, meta ----
  for (const k of ['cm', 'eb']) for (const id of Object.keys(state[k])) if (!cards.has(id)) delete state[k][id];
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
