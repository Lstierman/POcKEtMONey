// The scraper extension's helper side: what to visit (scripts/lib/scrape-plan.js), how search results are matched
// (scraper-extension/match.js), and the helper's /sites, /queue, /ingest and /skip endpoints against a temporary store.
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib'), cp = require('child_process');
const PLAN = require('../scripts/lib/scrape-plan.js');
const M = require('../scraper-extension/match.js');

const root = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'prices.config.json'), 'utf8'));
const map = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'data/card-map.json.gz'))));
const cards = new Map(map.cards.map(c => [c[0], c]));
const H = 3600e3, now = Date.parse('2026-10-23T12:00:00Z'), ago = h => new Date(now - h * H).toISOString();

test('plan: URLs per site', () => {
  const c = cards.get('base1-4');
  const cm = PLAN.plan('cardmarket', c, { cfg, urls: { cardmarket: { [c[6][0][0]]: 'https://www.cardmarket.com/en/Pokemon/Products/Singles/Base-Set/Charizard' } } });
  assert.deepStrictEqual(cm.products.map(p => p.cm), c[6].map(x => x[0]));
  assert.ok(cm.products[0].url && !cm.products[1].url, 'learned URL used for the product it belongs to');
  assert.strictEqual(cm.redirect, 'https://prices.pokemontcg.io/cardmarket/base1-4');
  assert.match(cm.search, /searchString=Charizard&perSite=50$/);
  const withCat = PLAN.plan('cardmarket', c, { cfg, cmInfo: new Map([[c[6][1][0], { name: 'Charizard', idExpansion: 1525 }]]) });
  assert.strictEqual(withCat.products[1].search, 'https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=Charizard&idExpansion=1525&perSite=50');
  assert.strictEqual(withCat.products[0].search, null, 'not in the catalog: no expansion search');
  assert.deepStrictEqual(cm.match, { name: 'charizard', num: '4', set: 'base', ja: false });

  const eb = PLAN.plan('ebay', c, { cfg });
  assert.strictEqual(eb.pages.length, cfg.scrape.ebayMarketplaces.length * 2);
  assert.ok(eb.pages.some(p => p.sold && /LH_Sold=1/.test(p.url) && /ebay\.de/.test(p.url)));
  assert.ok(eb.pages.some(p => /_nkw=Glurak\+4%2F102/.test(p.url)), 'German search uses the German name');

  const ja = [...cards.values()].find(x => x[5] === 'ja' && x[9] && x[6].length);
  const jcm = PLAN.plan('cardmarket', ja, { cfg }), jpc = PLAN.plan('pricecharting', ja, { cfg });
  assert.strictEqual(jcm.redirect, null, 'Japanese prints have no pokemontcg.io redirect');
  assert.ok(jcm.search.includes(encodeURIComponent(ja[9])), 'searched by English name');
  assert.ok(jpc.match.ja && /pokemon%20japanese/.test(jpc.search));
});

test('pickCards: To watch first, then never-scraped cards by value, then the oldest; misses and failures held back', () => {
  const entries = { 'base1-2': { h: 900 }, 'base1-3': { h: 500 }, 'base1-5': { h: 50 } };
  const watch = ['sv3pt5-199', 'base1-4'];
  const ids = (state, extra) => PLAN.pickCards('ebay', Object.assign({ cards, entries, cfg, n: 5, now, state, watch }, extra)).map(([c, ph]) => c[0] + ':' + ph);
  assert.deepStrictEqual(ids({}), ['sv3pt5-199:watch', 'base1-4:watch', 'base1-2:catalog', 'base1-3:catalog', 'base1-5:catalog']);

  // watched card scraped 30 min ago: current; 2 h ago: again. Catalog: scraped within a week is current.
  let state = { capture: { ebay: { 'sv3pt5-199': ago(0.5), 'base1-4': ago(2), 'base1-2': ago(24) } } };
  assert.deepStrictEqual(ids(state).slice(0, 3), ['base1-4:watch', 'base1-3:catalog', 'base1-5:catalog']);

  // every never-scraped card comes before any scraped one; scraped cards: oldest first
  const all = [...cards.keys()], stamps = {};
  all.forEach((id, k) => { if (id !== 'base1-7') stamps[id] = ago(200 + (k % 50)); });
  state = { capture: { ebay: stamps } };
  const order = PLAN.pickCards('ebay', { cards, entries, cfg, n: 3, now, state, watch: [] }).map(([c]) => c[0]);
  assert.strictEqual(order[0], 'base1-7');
  assert.ok(Date.parse(stamps[order[1]]) <= Date.parse(stamps[order[2]]));

  // no match a day ago: catalog cards wait a week, watched cards a day; a failure waits 12 h
  state = { misses: { ebay: { 'base1-2': ago(30), 'base1-4': ago(30) } }, fails: { ebay: { 'base1-3': ago(2) } } };
  let got = ids(state, { n: 4 });
  assert.ok(got.includes('base1-4:watch') && !got.some(x => /base1-[23]:/.test(x)), got.join(' '));
  state.fails.ebay['base1-3'] = ago(13);
  assert.ok(ids(state, { n: 5 }).includes('base1-3:catalog'));

  // only: card ids or sets, ignoring all of the above
  assert.deepStrictEqual(ids(state, { only: 'base1-2, base1-4' }).sort(), ['base1-2:only', 'base1-4:only']);
  const set = PLAN.pickCards('cardmarket', { cards, entries, cfg, n: 500, now, state, only: 'base1' });
  assert.ok(set.length > 50 && set.every(([c]) => c[1] === 'base1' && c[6].length), 'a whole set; Cardmarket needs a product id');
});

test('siteStatus: last scrape, cards with prices, watched cards up to date; removed cards ignored', () => {
  const s = PLAN.siteStatus({ capture: { ebay: { 'base1-4': ago(3), 'base1-2': ago(0.5), 'gone-1': ago(0) } }, scrape: { ebay: { 'base1-5': ago(300) } } }, cards, cfg, ['base1-2', 'base1-4'], now);
  assert.strictEqual(s.ebay.cards, 3); assert.strictEqual(s.ebay.fresh, 2); assert.strictEqual(s.ebay.lastAt, ago(0.5));
  assert.deepStrictEqual(s.ebay.watch, { n: 2, current: 1 });
  assert.deepStrictEqual([s.cardmarket.lastAt, s.cardmarket.cards], [null, 0]);
  assert.ok(s.cardmarket.eligible < s.ebay.eligible);
});

test('match: picks the right search result', () => {
  const m = { name: 'charizard', num: '4', set: 'base', ja: false };
  const cmLinks = [
    { href: 'https://www.cardmarket.com/en/Pokemon/Products/Singles/Base-Set-2/Charizard-V1-B24', text: 'Charizard Base Set 2' },
    { href: 'https://www.cardmarket.com/en/Pokemon/Products/Singles/Base-Set/Charizard-V1-BS4', text: 'Charizard Base Set (BS 4)' },
    { href: 'https://www.cardmarket.com/en/Pokemon/Products/Singles/Base-Set/Blastoise-V1-BS2', text: 'Blastoise' },
    { href: 'https://www.cardmarket.com/en/Pokemon/Users/someone', text: 'Charizard fan' }
  ];
  // a search showing other sets' Charizards first: only results with the card's number are kept
  const ex = { name: 'charizard-ex', num: '199', set: '151', ja: false };
  const exLinks = [
    { href: 'https://www.cardmarket.com/en/Pokemon/Products/Singles/Pokemon-GO/Charizard-V1-PGO10', text: 'Charizard (PGO 10) Pokémon GO' },
    { href: 'https://www.cardmarket.com/en/Pokemon/Products/Singles/Evolutions/Charizard-EX-V1-EVO12', text: 'Charizard EX (EVO 12) Evolutions' },
    { href: 'https://www.cardmarket.com/en/Pokemon/Products/Singles/151/Charizard-ex-V2-MEW199', text: 'Charizard ex (MEW 199) 151' }
  ];
  assert.deepStrictEqual(M.cardmarket(exLinks, ex), [exLinks[2].href]);
  const got = M.cardmarket(cmLinks, m);
  assert.strictEqual(got[0], cmLinks[1].href); assert.ok(!got.some(h => /Blastoise|Users/.test(h)));

  const pcLinks = [
    { href: 'https://www.pricecharting.com/game/pokemon-base-set-2/charizard-4', text: '' },
    { href: 'https://www.pricecharting.com/game/pokemon-base-set/charizard-1st-edition-4', text: '' },
    { href: 'https://www.pricecharting.com/game/pokemon-base-set/charizard-4', text: '' },
    { href: 'https://www.pricecharting.com/game/pokemon-japanese-base-expansion-pack/charizard-6', text: '' },
    { href: 'https://www.pricecharting.com/game/pokemon-base-set/charizard-40', text: '' }
  ];
  assert.strictEqual(M.pricecharting(pcLinks, m)[0], 'https://www.pricecharting.com/game/pokemon-base-set/charizard-4');
  assert.ok(!M.pricecharting(pcLinks, m).some(h => /japanese|-40$/.test(h)));
  assert.ok(M.pricechartingPageOk('https://www.pricecharting.com/game/pokemon-japanese-base-expansion-pack/charizard-6', { name: 'charizard', num: '006', set: 'x', ja: true }));
  assert.ok(!M.pricechartingPageOk('https://www.pricecharting.com/game/pokemon-base-set/charizard-6', { name: 'charizard', num: '6', set: 'x', ja: true }));
});

test('helper: /sites, /queue, scraper captures with eBay relevance filter, /skip', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptcg-helper-')), port = 18700 + Math.floor(Math.random() * 200);
  const proc = cp.spawn(process.execPath, ['--require', path.join(__dirname, 'mock-fetch.js'), path.join(root, 'scripts/ingest-server.js'), '--store=' + dir, '--port=' + port, '--journal=' + path.join(dir, '..', path.basename(dir) + '-journal.jsonl')],
    { env: Object.assign({}, process.env, { MOCK_LOG: path.join(dir, '..', path.basename(dir) + '-req.json') }), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => proc.kill());
  await new Promise((ok, no) => { proc.stdout.on('data', d => /capture helper on/.test(d) && ok()); proc.on('exit', c => no(new Error('helper exited ' + c))); setTimeout(() => no(new Error('helper did not start')), 15000); });
  const url = 'http://127.0.0.1:' + port, get = p => fetch(url + p).then(r => r.json());
  const post = (p, b) => fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, data: await r.json() }));

  let sites = await get('/sites');
  assert.strictEqual(sites.sites.ebay.lastAt, null); assert.strictEqual(sites.publish, false);

  let q = await get('/queue?site=ebay&n=3');
  assert.strictEqual(q.items.length, 3); assert.strictEqual(q.items[0].card, cfg.schedule.always[0]);
  assert.ok(q.items[0].pages.length >= 2 && q.pace.gap > 0 && q.pace.conc >= 1);
  assert.strictEqual((await fetch(url + '/queue?site=nope')).status, 400);

  // a scraped eBay page: the item for another card number is dropped, the right one kept
  const row = (id, title) => [id, title, 300, 'EUR', 'Used', 'EBAY_DE', '', '', 'https://www.ebay.de/itm/' + id, 'FIXED_PRICE', 0, '', 0];
  const page = { site: 'ebay', mp: 'EBAY_DE', sold: false, query: 'Glurak 4/102', items: [row('1', 'Glurak 4/102 Base Set holo'), row('2', 'Glurak 3/102 Fehldruck')], found: 2 };
  let r = await post('/ingest', { site: 'ebay', url: 'https://www.ebay.de/sch/i.html?_nkw=Glurak', cardId: 'base1-4', data: page, via: 'scraper' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.report, /^1 of 2 eBay for-sale/);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'listings/ebay/base1/base1-4.json')));
  assert.deepStrictEqual(stored.active.map(x => x[0]), ['1']); assert.strictEqual(stored.source, 'scraper');

  // an empty results page is a valid answer from the scraper, but still rejected from the manual panel
  const empty = Object.assign({}, page, { sold: true, items: [], found: 0 });
  assert.strictEqual((await post('/ingest', { site: 'ebay', url: 'x', cardId: 'base1-4', data: empty, via: 'scraper', empty: true })).status, 200);
  assert.strictEqual((await post('/ingest', { site: 'ebay', url: 'x', cardId: 'base1-4', data: empty })).status, 422);

  sites = await get('/sites');
  assert.strictEqual(sites.sites.ebay.cards, 1); assert.ok(sites.sites.ebay.lastAt); assert.strictEqual(sites.pending, 2);

  q = await get('/queue?site=ebay&n=3');
  assert.ok(!q.items.some(i => i.card === 'base1-4'), 'just captured: not queued again');

  // no match on PriceCharting: skipped until it is rechecked a week later
  const first = (await get('/queue?site=pricecharting&n=1')).items[0].card;
  assert.strictEqual((await post('/skip', { site: 'pricecharting', card: first, reason: 'test' })).status, 200);
  assert.notStrictEqual((await get('/queue?site=pricecharting&n=1')).items[0].card, first);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
  assert.ok(state.misses.pricecharting[first]);

  // PriceCharting capture: its URL is remembered for next time
  const pc = { site: 'pricecharting', url: 'https://www.pricecharting.com/game/pokemon-base-set/blastoise-2', title: 'Blastoise #2', prices: { ungraded: 120, psa10: 4000 }, sold: [['2026-10-20', 'PSA 10', 'Blastoise PSA 10', 4100, null]], found: 3 };
  r = await post('/ingest', { site: 'pricecharting', url: pc.url, cardId: 'base1-2', data: pc, via: 'scraper' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual((await get('/queue?site=pricecharting&only=base1-2')).items[0].url, pc.url);

  // Cardmarket offers whose condition could not be read: saved, kept out of the condition prices; and a refused
  // capture must not break the next ones
  const cmRow = (id, lang, cond, price) => [id, lang, cond, price, 1, 0, 0, 0, 0, 'NL', 's', '', 0];
  const cmData = { site: 'cardmarket', idProduct: 273699, title: 'Charizard', articles: [cmRow(1, 1, 'NM', 400), cmRow(2, 12, '??', 380)], found: 2 };
  r = await post('/ingest', { site: 'cardmarket', url: 'https://www.cardmarket.com/en/Pokemon/Products/Singles/Base-Set/Charizard', cardId: 'base1-4', data: cmData, via: 'scraper' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  let sum = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(dir, 'summary.json.gz'))));
  assert.deepStrictEqual(Object.keys(sum.cards['base1-4'].l), ['1|NM|']); assert.ok(sum.cards['base1-4'].b['cm|L|12|']);
  r = await post('/ingest', { site: 'cardmarket', url: 'x', cardId: 'base1-4', data: Object.assign({}, cmData, { articles: [cmRow(3, 1, 'NM', -5)] }), via: 'scraper' });
  assert.strictEqual(r.status, 500, 'invalid price refused');
  r = await post('/ingest', { site: 'pricecharting', url: pc.url, cardId: 'base1-2', data: pc, via: 'scraper' });
  assert.strictEqual(r.status, 200, 'the next capture still works: ' + JSON.stringify(r.data));

  // To watch: starts with the collector's `always` cards; add / remove; unknown ids ignored; stored in the store; first in the queue
  let w = await get('/watch');
  assert.deepStrictEqual(w.cards.map(c => c.id), cfg.schedule.always);
  r = await post('/watch', { add: ['base1-15', 'nope-1'], remove: [cfg.schedule.always[0]] });
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.data.unknown, ['nope-1']);
  assert.deepStrictEqual(r.data.cards, cfg.schedule.always.slice(1).concat('base1-15'));
  const wl = JSON.parse(fs.readFileSync(path.join(dir, 'watchlist.json')));
  assert.deepStrictEqual(wl.cards.map(x => x[0]), r.data.cards);
  q = await get('/queue?site=pricecharting&n=6');
  const phases = q.items.map(i => i.phase), nw = r.data.cards.length;
  assert.deepStrictEqual(phases.slice(0, nw), Array(nw).fill('watch')); assert.ok(phases.slice(nw).every(p => p === 'catalog'));
  assert.ok(q.items.slice(0, nw).some(i => i.card === 'base1-15'));
  sites = await get('/sites');
  assert.strictEqual(sites.watch, nw); assert.strictEqual(sites.sites.pricecharting.watch.n, nw);
  // a failed card is held back from the queue
  const failing = q.items[nw].card;
  await post('/skip', { site: 'pricecharting', card: failing, kind: 'fail', reason: 'test' });
  assert.ok(!(await get('/queue?site=pricecharting&n=6')).items.some(i => i.card === failing));
  // the site (another origin) may call the helper: CORS with private network access
  const pre = await fetch(url + '/watch', { method: 'OPTIONS' });
  assert.strictEqual(pre.headers.get('access-control-allow-private-network'), 'true');
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
  // every change is journaled, so it survives a reset to the collector's newer version
  const journal = fs.readFileSync(path.join(dir, '..', path.basename(dir) + '-journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(journal.some(j => j.watch && j.watch.add.includes('base1-15')) && journal.some(j => j.skip && j.skip.card === failing));

  // the site's live view: cards saved since a moment, with their summary entries
  const t0 = Date.now() - 1;
  await post('/ingest', { site: 'pricecharting', url: pc.url, cardId: 'base1-2', data: pc, via: 'scraper' });
  const ch = await get('/changes?since=' + t0);
  assert.deepStrictEqual(Object.keys(ch.cards), ['base1-2']); assert.ok(ch.cards['base1-2'].pc && ch.now >= t0);
  assert.strictEqual(ch.recent[ch.recent.length - 1][0], 'base1-2');
  assert.deepStrictEqual(Object.keys((await get('/changes?since=' + ch.now)).cards), []);

  assert.strictEqual((await post('/publish', {})).status, 400, 'pushing needs npm run helper');
});

test('classification: grading company and grade, language, raw copies that mention grading', () => {
  const P = require('../src/prices.js');
  const cases = [
    ['1999 Pokemon Base Set Charizard 4/102 PSA 10 GEM MINT', 'PSA 10', 0],
    ['Charizard 4/102 BGS 9.5 Gem Mint', 'BGS 9.5', 0],
    ['Charizard Beckett 10 Black Label', 'BGS 10 Black Label', 0],
    ['Charizard CGC 10 Pristine', 'CGC 10 Pristine', 0],
    ['Gem Mint 10 PSA Charizard 4/102', 'PSA 10', 0],
    ['Dracaufeu 4/102 VF CGC 9,5', 'CGC 9.5', 2],
    ['Glurak 4/102 Basis Set deutsch PSA 8', 'PSA 8', 3],
    ['Charizard 4/102 japanese PSA 9', 'PSA 9', 7],
    ['Charizard TAG 9.5 slab', 'TAG 9.5', 0],
    ['Charizard PSA 10 candidate! NM', '', 0],
    ['Pikachu & Zekrom GX Tag Team 33/181', '', 0],
    ['Pikachu & Zekrom GX Tag Team 33/181 PSA 9', 'PSA 9', 0],
    ['Ace Trainer 69/72 raw', '', 0],
    ['Charizard 4/102 Holo English', '', 1],
    ['Charizard 1999 Base Set', '', 0]
  ];
  for (const [t, g, l] of cases) { assert.strictEqual(P.grade(t), g, t); assert.strictEqual(P.titleLang(t), l, t); }
  assert.strictEqual(P.grade('Charizard 4/102', 'Graded'), 'Graded ?');
  assert.strictEqual(P.grade('Charizard PSA 9', 'Ungraded'), '');
  assert.deepStrictEqual(['PSA 9', '', 'BGS 10 Black Label', 'PSA 10', 'CGC 10'].sort(P.gradeOrder), ['', 'BGS 10 Black Label', 'PSA 10', 'CGC 10', 'PSA 9']);
  // Cardmarket comments: a graded copy leaves the raw condition stats and lands in the breakdown under its grade
  const row = (id, lang, price, comment) => [id, lang, 'NM', price, 1, 0, 0, 0, 0, 'DE', 's', comment, 5];
  const arts = [row(1, 1, 100, ''), row(2, 1, 110, ''), row(3, 1, 2000, 'PSA 10 slab'), row(4, 3, 80, '')];
  assert.deepStrictEqual(Object.keys(P.aggregateArticles(arts)).sort(), ['1|NM|', '3|NM|']);
  assert.strictEqual(P.aggregateArticles(arts)['1|NM|'][4], 110);
  const b = P.segments(P.obsArticles('cm', arts));
  assert.deepStrictEqual(Object.keys(b).sort(), ['cm|L|1|', 'cm|L|1|PSA 10', 'cm|L|3|']);
  // PriceCharting: the title's company wins over the tab
  const pc = P.segments(P.obsPricecharting([['2026-10-20', 'Grade 9', 'Charizard BGS 9', 100, null], ['2026-10-20', 'Grade 9', 'Charizard 4/102', 90, null], ['2026-10-20', 'Ungraded', 'Charizard', 10, null]], 1, { EUR: 1, USD: 1 }));
  assert.deepStrictEqual(Object.keys(pc).sort(), ['pc|S|1|', 'pc|S|1|BGS 9', 'pc|S|1|Graded 9']);
});

// Runs the real scraper-extension/background.js in a VM with a simulated Chrome and a simulated Cardmarket product.
function simulatedExtension(offers) {
  const vm = require('vm');
  const conds = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'], PER = 50;
  const sim = { requests: 0, navigations: 0, ingested: [], skipped: [] };
  function view(url, shownPages) {
    const u = new URL(url), lang = +u.searchParams.get('language') || 0, cond = +u.searchParams.get('minCondition') || 7;
    const all = offers.filter(a => (!lang || a[1] === lang) && conds.indexOf(a[2]) + 1 <= cond).sort((a, b) => a[3] - b[3]);
    const shown = all.slice(0, PER * shownPages);
    return { site: 'cardmarket', idProduct: 5, title: 'Charizard', articles: shown, found: shown.length, rowsSeen: shown.length, cut: shown.length < all.length };
  }
  let tabUrl = '', clicks = 0;
  const ctx = {
    console, URL, URLSearchParams, Map, Set, JSON, Math, Date, Promise, Object, Array, String, Error, AbortController,
    setTimeout: (fn) => setImmediate(fn), clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    importScripts: () => { ctx.PTCG_MATCH = require('../scraper-extension/match.js'); },
    fetch: async (u, o) => {
      if (/\/ingest$/.test(u)) { const b = JSON.parse(o.body); sim.ingested.push(b); return { status: 200, json: async () => ({ report: b.data.found + ' listings', card: { id: 'base1-4' } }) }; }
      if (/\/skip$/.test(u)) { sim.skipped.push(JSON.parse(o.body)); return { status: 200, json: async () => ({ ok: true }) }; }
      return { status: 404, url: u, json: async () => ({}) };
    },
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} }, runtime: { onMessage: { addListener() {} }, getPlatformInfo() {} },
      notifications: { create() {}, clear() {} },
      windows: { create: async () => ({ id: 1, tabs: [{ id: 2 }] }), get: async () => ({ id: 1 }), update: async () => {}, remove: async () => {} },
      tabs: { get: async id => ({ id, status: 'complete' }), create: async () => ({ id: 3 }), update: async (t, o) => { if (o.url) { tabUrl = o.url.split('#')[0]; clicks = 0; sim.navigations++; } } },
      scripting: { executeScript: async ({ func, args }) => {
        if (!func) return [{}];
        if (func.name === 'fetchParse') return [{ result: args[0].map(url => { sim.requests++; const d = view(url, 1), cut = d.cut; delete d.cut; return { url, final: url, status: 200, data: d, more: cut }; }) }];
        if (func.name === 'readPage') { const d = view(tabUrl, 1 + clicks), cut = d.cut; delete d.cut; return [{ result: { url: tabUrl, data: d, more: cut } }]; }
        if (func.name === 'loadAllOffers') { let n = 0; while (n < args[0] && view(tabUrl, 1 + clicks).cut) { clicks++; n++; } return [{ result: n }]; }
        if (func.name === 'blockCheck') return [{ result: '' }];
        return [{ result: 0 }];
      } }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'scraper-extension/background.js'), 'utf8'), ctx);
  sim.run = async (item, deep) => {
    await new Promise(r => setImmediate(r));
    vm.runInContext(`job = { items: [], st: [], i: 0, saved: 0, skipped: 0, failed: 0, pace: { gap: 0, conc: 2, pageSize: 50 }, deep: ${!!deep}, log: [], status: 'running', cur: {}, steps: {}, tabs: {}, ready: {}, waiting: 0 };`, ctx);
    const w = vm.runInContext('worker("cardmarket")', ctx);
    return vm.runInContext('scrapeCardmarket', ctx)(w, item);
  };
  sim.log = () => vm.runInContext('job.log', ctx);
  return sim;
}
function crowdedProduct() {
  // 1,400 offers: English (many cheap Poor/Played copies, pricier Mint/Near Mint), German, Japanese
  const conds = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'], offers = []; let id = 1000000;
  for (let i = 0; i < 900; i++) offers.push([id++, 1, conds[6 - (i % 3)], 5 + i * 0.1, 1, 0, 0, 0, 0, 'DE', 's', '', 5]);
  for (let i = 0; i < 300; i++) offers.push([id++, 1, conds[i % 2], 200 + i, 1, 0, 0, 0, 0, 'DE', 's', '', 5]);
  for (let i = 0; i < 150; i++) offers.push([id++, 3, conds[1], 150 + i, 1, 0, 0, 0, 0, 'DE', 's', '', 5]);
  for (let i = 0; i < 50; i++) offers.push([id++, 7, conds[1], 300 + i, 1, 0, 0, 0, 0, 'JP', 's', '', 5]);
  return offers;
}
const ITEM = { site: 'cardmarket', card: 'base1-4', label: 'Charizard', products: [{ cm: 5, url: 'https://www.cardmarket.com/en/Pokemon/Products/Singles/Base-Set/Charizard' }],
  filters: { maxLoadMore: 40, languages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], conditions: true }, match: {} };

test('scraper extension, fast: the cheapest offers of every language × condition in a few dozen requests', async () => {
  const offers = crowdedProduct(), sim = simulatedExtension(offers);
  assert.strictEqual(await sim.run(ITEM, false), 1);
  const got = sim.ingested[0].data.articles, ids = new Set(got.map(a => a[0]));
  assert.strictEqual(ids.size, got.length, 'each offer once');
  // fetches: the first page + 13 languages + (English, German cut off) × 6 conditions; plus one normal load of the tab
  assert.strictEqual(sim.requests, 1 + 13 + 12, 'requests: ' + sim.requests);
  assert.strictEqual(sim.navigations, 1, 'only the first page is loaded in the tab');
  const cheapest = (lang, okConds, n = 50) => offers.filter(a => a[1] === lang && okConds.includes(a[2])).sort((x, y) => x[3] - y[3]).slice(0, n);
  for (const [lang, set] of [[1, ['MT']], [1, ['MT', 'NM']], [1, ['MT', 'NM', 'EX', 'GD', 'LP']], [3, ['MT', 'NM']], [7, ['NM']]])
    assert.ok(cheapest(lang, set).every(a => ids.has(a[0])), 'cheapest of language ' + lang + ' in ' + set.join('/'));
  const cov = sim.ingested[0].data.coverage;
  assert.deepStrictEqual(cov.find(c => c[0] === 7), [7, 0, 50, 1], 'Japanese: complete');
  assert.deepStrictEqual(cov.find(c => c[0] === 2), [2, 0, 0, 1], 'French: checked, none');
  assert.ok(cov.filter(c => c[0] === 1 && c[1]).length === 6, 'English per condition');
  assert.ok(sim.log().some(l => /267 offers from 26 views \(14 views show the cheapest only/.test(l)), sim.log().join('\n'));
});

test('scraper extension, deep: every offer in Good or better and every other language', async () => {
  const offers = crowdedProduct(), sim = simulatedExtension(offers);
  assert.strictEqual(await sim.run(ITEM, true), 1);
  const got = sim.ingested[0].data.articles, ids = new Set(got.map(a => a[0]));
  assert.strictEqual(ids.size, got.length);
  assert.ok(offers.filter(a => a[1] !== 1).every(a => ids.has(a[0])), 'every German and Japanese offer');
  assert.ok(offers.filter(a => a[1] === 1).every(a => ids.has(a[0])), 'every English offer (40 loads of 50 cover 1,200)');
  assert.ok(sim.navigations <= 3, 'deep mode opens only the cut-off languages in the tab: ' + sim.navigations);
});

test('scraper extension: a normal card is one request', async () => {
  const offers = crowdedProduct().filter(a => a[1] === 7), sim = simulatedExtension(offers);
  assert.strictEqual(await sim.run(ITEM, false), 1);
  assert.strictEqual(sim.requests, 1); assert.strictEqual(sim.navigations, 1); // the tab's first load, then one fetch
  assert.strictEqual(sim.ingested[0].data.articles.length, 50);
});

test('scraper extension run: To watch before the catalog, until the queue is empty; failures reported; pushed at the end; Stop', async () => {
  const vm = require('vm');
  function setup(queues) {
    const calls = [], storage = {};
    const ctx = {
      console, URL, URLSearchParams, Map, Set, JSON, Math, Date, Promise, Object, Array, String, Error, AbortController,
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)), clearTimeout, setInterval: () => 0, clearInterval: () => {},
      importScripts: () => { ctx.PTCG_MATCH = require('../scraper-extension/match.js'); },
      fetch: async (u, o) => {
        const url = new URL(u), b = o && o.body ? JSON.parse(o.body) : null; calls.push([url.pathname, b]);
        const json = d => ({ status: 200, json: async () => d });
        if (url.pathname === '/sites') return json({ watch: 2 });
        if (url.pathname === '/queue') { const q = queues[url.searchParams.get('site')]; return json({ items: q.splice(0, +url.searchParams.get('n')), pace: { gap: 0, conc: 1 } }); }
        return json({ ok: true });
      },
      chrome: {
        storage: { local: { get: async () => ({}), set: async o => Object.assign(storage, o), remove: async () => {} } },
        action: { setBadgeText() {}, setBadgeBackgroundColor() {} }, runtime: { onMessage: { addListener() {} }, getPlatformInfo() {} },
        notifications: { create() {}, clear() {} }, windows: { create: async () => ({ id: 1, tabs: [{ id: 2 }] }), get: async () => ({}), update: async () => {}, remove: async () => {} },
        tabs: { get: async () => ({ status: 'complete' }), create: async () => ({ id: 3 }), update: async () => {} }, scripting: { executeScript: async () => [{ result: '' }] }
      }
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'scraper-extension/background.js'), 'utf8'), ctx);
    const order = [];
    vm.runInContext('SCRAPE', ctx).ebay = async (w, item) => { order.push(item.card); await new Promise(r => setTimeout(r, 2)); if (item.card === 'bad') throw new Error('page broke'); return 1; };
    return { ctx, calls, order, job: () => vm.runInContext('job', ctx), running: () => vm.runInContext('running', ctx) };
  }
  const until = async (f, ms = 3000) => { for (const end = Date.now() + ms; !f(); ) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)); } };
  const it = (card, phase) => ({ site: 'ebay', card, label: card, phase, pages: [] });

  const q = [it('w1', 'watch'), it('w2', 'watch')].concat(Array.from({ length: 23 }, (_, k) => it(k === 4 ? 'bad' : 'c' + k, 'catalog')));
  const A = setup({ ebay: q.slice() });
  await new Promise(r => setImmediate(r));
  const r = await vm.runInContext('start', A.ctx)({ sites: ['ebay'] });
  assert.ok(r.ok);
  await until(() => A.job().status === 'done' && !A.running());
  assert.deepStrictEqual(A.order, q.map(x => x.card), 'every card once, To watch first, until the queue is empty');
  assert.strictEqual(A.calls.filter(c => c[0] === '/queue').length, 4, 'batches of 10, then an empty answer ends the run');
  assert.deepStrictEqual(A.calls.filter(c => c[0] === '/skip').map(c => c[1]), [{ site: 'ebay', card: 'bad', kind: 'fail', reason: 'page broke' }]);
  assert.strictEqual(A.calls[A.calls.length - 1][0], '/publish', 'pushed when the run ends');
  assert.deepStrictEqual([A.job().saved, A.job().failed, A.job().done.watch, A.job().done.catalog], [24, 1, 2, 22]);

  // Stop: the run ends after the card in progress, pushes, and the next Scrape all asks the helper again (the helper
  // knows what was saved, so it continues where this run stopped)
  const B = setup({ ebay: q.slice() });
  await new Promise(r => setImmediate(r));
  await vm.runInContext('start', B.ctx)({ sites: ['ebay'] });
  await until(() => B.order.length >= 3);
  vm.runInContext('job.stop = true', B.ctx);
  await until(() => !B.running());
  assert.strictEqual(B.job().status, 'stopped'); assert.match(B.job().message, /continue where it stopped/);
  assert.ok(B.order.length < q.length);
  assert.strictEqual(B.calls[B.calls.length - 1][0], '/publish');
});

test('data score: weights, freshness, partly collected, not applicable', () => {
  const P = require('../src/prices.js'), at = d => new Date(now - d * 864e5).toISOString();
  const all = { listings: { at: at(0.5) }, sold: { at: at(1) }, guide: { at: at(1) }, ebay: { at: at(0.2) }, graded: { at: at(3) }, tcg: { at: at(1) } };
  assert.strictEqual(P.dataScore(all, now).score, 1);
  assert.strictEqual(P.dataScore({}, now).score, 0);
  // only listings and sold, fresh: 0.25 + 0.20 of 1.00
  assert.strictEqual(P.dataScore({ listings: { at: at(0) }, sold: { at: at(0) } }, now).score, 0.45);
  // eBay for sale 15.5 days old: halfway between 1 and 30 days -> half its 0.15
  const half = P.dataScore({ ebay: { at: at(15.5) } }, now);
  assert.strictEqual(half.score, 0.08); assert.strictEqual(half.parts.find(p => p.key === 'ebay').state, 'aging');
  assert.strictEqual(P.dataScore({ ebay: { at: at(40) } }, now).parts.find(p => p.key === 'ebay').state, 'stale');
  // listings where only the cheapest offers were loaded count partly
  assert.strictEqual(P.dataScore({ listings: { at: at(0), part: 0.6 } }, now).score, 0.15);
  // Japanese print: TCGplayer left out, the rest re-weighted
  const ja = P.dataScore(Object.assign({}, all, { tcg: { na: true } }), now);
  assert.strictEqual(ja.score, 1); assert.strictEqual(ja.parts.find(p => p.key === 'tcg').state, 'n/a');
  assert.strictEqual(P.dataScore({ listings: { at: at(0) }, tcg: { na: true } }, now).score, Math.round(0.25 / 0.9 * 100) / 100);
  assert.deepStrictEqual([0, 0.05, 0.5, 0.99, 1].map(P.scoreBucket), [0, 1, 10, 19, 20]);
});

test('Cardmarket listing completeness (lc) from the views the scraper loaded', () => {
  const { Store } = require('../scripts/lib/store.js'), { applyCardmarket } = require('../scripts/lib/entries.js');
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'ptcg-lc-'))), c = cards.get('base1-4');
  const row = [1, 1, 'NM', 400, 1, 0, 0, 0, 0, 'DE', 's', '', 273699];
  const e = {}; applyCardmarket(store, e, c, [{ cm: 273699, label: 'x', articles: [row], coverage: [[0, 0, 50, 0], [1, 0, 30, 1], [3, 0, 10, 1], [7, 0, 0, 1]] }], new Date().toISOString(), 'scraper');
  assert.strictEqual(e.lc, 0.75);
  applyCardmarket(store, e, c, [{ cm: 273699, label: 'x', articles: [row] }], new Date().toISOString(), 'api');
  assert.strictEqual(e.lc, undefined, 'API listings are complete');
});
