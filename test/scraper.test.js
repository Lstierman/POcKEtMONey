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

test('the scraper extension ships the same page parsers as the capture extension', () => {
  assert.strictEqual(fs.readFileSync(path.join(root, 'scraper-extension/parsers.js'), 'utf8'), fs.readFileSync(path.join(root, 'extension/parsers.js'), 'utf8'),
    'copy extension/parsers.js to scraper-extension/parsers.js');
});

test('plan: URLs per site', () => {
  const c = cards.get('base1-4');
  const cm = PLAN.plan('cardmarket', c, { cfg, urls: { cardmarket: { [c[6][0][0]]: 'https://www.cardmarket.com/en/Pokemon/Products/Singles/Base-Set/Charizard' } } });
  assert.deepStrictEqual(cm.products.map(p => p.cm), c[6].map(x => x[0]));
  assert.ok(cm.products[0].url && !cm.products[1].url, 'learned URL used for the product it belongs to');
  assert.strictEqual(cm.redirect, 'https://prices.pokemontcg.io/cardmarket/base1-4');
  assert.match(cm.search, /searchString=Charizard$/);
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

test('pickCards: always list first, recent captures skipped, misses rechecked after a week', () => {
  const entries = { 'base1-2': { h: 900 }, 'base1-3': { h: 500 } };
  const base = { cards, entries, cfg, n: 5, now };
  let list = PLAN.pickCards('ebay', Object.assign({ state: {} }, base)).map(c => c[0]);
  assert.deepStrictEqual(list.slice(0, 5), [...cfg.schedule.always, 'base1-2', 'base1-3'].slice(0, 5));

  const state = { capture: { ebay: { 'base1-2': ago(2) } }, misses: { ebay: { 'base1-3': ago(24) } } };
  list = PLAN.pickCards('ebay', Object.assign({ state }, base)).map(c => c[0]);
  assert.ok(!list.includes('base1-2'), 'captured 2 h ago: fresh');
  assert.ok(!list.includes('base1-3'), 'no match a day ago: skipped for a week');

  state.misses.ebay['base1-3'] = ago(8 * 24);
  assert.ok(PLAN.pickCards('ebay', Object.assign({ state }, base)).some(c => c[0] === 'base1-3'), 'no match 8 days ago: tried again');

  state.capture.ebay['base1-2'] = ago(20); state.misses.ebay['base1-2'] = ago(30);
  assert.ok(PLAN.pickCards('ebay', Object.assign({ state }, base)).some(c => c[0] === 'base1-2'), 'a miss older than the last capture does not hold the card back');

  const set = PLAN.pickCards('cardmarket', Object.assign({ state }, base, { n: 500, only: 'base1' }));
  assert.ok(set.length > 50 && set.every(c => c[1] === 'base1' && c[6].length), '"only" expands a set, Cardmarket needs a product id');
  assert.deepStrictEqual(PLAN.pickCards('ebay', Object.assign({ state }, base, { only: 'base1-2, base1-4' })).map(c => c[0]).sort(), ['base1-2', 'base1-4'], '"only" ignores freshness');
});

test('siteStatus: last scrape per site, removed cards ignored', () => {
  const s = PLAN.siteStatus({ capture: { ebay: { 'base1-4': ago(3), 'base1-2': ago(1), 'gone-1': ago(0) } }, scrape: { ebay: { 'base1-5': ago(10) } } }, cards);
  assert.strictEqual(s.ebay.cards, 3); assert.strictEqual(s.ebay.lastAt, ago(1));
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
  const proc = cp.spawn(process.execPath, ['--require', path.join(__dirname, 'mock-fetch.js'), path.join(root, 'scripts/ingest-server.js'), '--store=' + dir, '--port=' + port],
    { env: Object.assign({}, process.env, { MOCK_LOG: path.join(dir, '..', path.basename(dir) + '-req.json') }), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => proc.kill());
  await new Promise((ok, no) => { proc.stdout.on('data', d => /capture helper on/.test(d) && ok()); proc.on('exit', c => no(new Error('helper exited ' + c))); setTimeout(() => no(new Error('helper did not start')), 15000); });
  const url = 'http://127.0.0.1:' + port, get = p => fetch(url + p).then(r => r.json());
  const post = (p, b) => fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, data: await r.json() }));

  let sites = await get('/sites');
  assert.strictEqual(sites.sites.ebay.lastAt, null); assert.strictEqual(sites.publish, false);

  let q = await get('/queue?site=ebay&n=3');
  assert.strictEqual(q.items.length, 3); assert.strictEqual(q.items[0].card, cfg.schedule.always[0]);
  assert.ok(q.items[0].pages.length >= 2 && q.secondsBetweenPages > 0);
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

test('scraper extension: Cardmarket offers per language and condition when a product has too many to load', async () => {
  const vm = require('vm');
  // a product with 1,400 offers: English (many, mostly cheap Poor/Played copies), German, Japanese
  const conds = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'], offers = [];
  let id = 1000000;
  for (let i = 0; i < 900; i++) offers.push([id++, 1, conds[6 - (i % 3)], 5 + i * 0.1, 1, 0, 0, 0, 0, 'DE', 's', '', 5]); // Poor, Played, Light Played
  for (let i = 0; i < 300; i++) offers.push([id++, 1, conds[i % 2], 200 + i, 1, 0, 0, 0, 0, 'DE', 's', '', 5]);         // Mint, Near Mint: pricier
  for (let i = 0; i < 150; i++) offers.push([id++, 3, conds[1], 150 + i, 1, 0, 0, 0, 0, 'DE', 's', '', 5]);
  for (let i = 0; i < 50; i++) offers.push([id++, 7, conds[1], 300 + i, 1, 0, 0, 0, 0, 'JP', 's', '', 5]);
  const PER = 50, base = 'https://www.cardmarket.com/en/Pokemon/Products/Singles/Base-Set/Charizard';
  let url = '', clicks = 0, loads = 0, ingested = null;
  function view() {
    const u = new URL(url), lang = +u.searchParams.get('language') || 0, cond = +u.searchParams.get('minCondition') || 7;
    const all = offers.filter(a => (!lang || a[1] === lang) && conds.indexOf(a[2]) + 1 <= cond).sort((a, b) => a[3] - b[3]);
    const shown = all.slice(0, PER * (1 + clicks));
    return { none: false, url: url.split('#')[0], more: shown.length < all.length, data: { site: 'cardmarket', idProduct: 5, title: 'Charizard', articles: shown, found: shown.length, rowsSeen: shown.length } };
  }
  const ctx = {
    console, URL, URLSearchParams, Map, Set, JSON, Math, Date, Promise, Object, Array, String, Error,
    setTimeout: fn => setImmediate(fn), setInterval: () => 0, clearInterval: () => {},
    importScripts: () => { ctx.PTCG_MATCH = require('../scraper-extension/match.js'); },
    fetch: async (u, o) => { if (/\/ingest$/.test(u)) { ingested = JSON.parse(o.body); return { status: 200, json: async () => ({ report: 'ok', card: { id: 'base1-4' } }) }; } return { status: 200, json: async () => ({}) }; },
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} }, runtime: { onMessage: { addListener() {} }, getPlatformInfo() {} },
      notifications: { create() {}, clear() {} }, windows: { create: async () => ({ id: 1, tabs: [{ id: 2 }] }), update: async () => {}, remove: async () => {} },
      tabs: { get: async () => ({ status: 'complete' }), update: async (t, o) => { url = o.url; clicks = 0; loads++; } },
      scripting: { executeScript: async ({ func, args }) => {
        if (!func) return [{}];
        if (func.name === 'readPage') return [{ result: view() }];
        if (func.name === 'loadAllOffers') { const max = args[0]; while (clicks < max && view().more) clicks++; return [{ result: clicks }]; }
        if (func.name === 'blockCheck') return [{ result: '' }];
        return [{ result: null }];
      } }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'scraper-extension/background.js'), 'utf8'), ctx);
  await new Promise(r => setImmediate(r));
  vm.runInContext('job = { items: [], i: 0, saved: 0, skipped: 0, failed: 0, gap: 0, log: [], status: "running" }; pause = async () => {};', ctx);
  const item = { site: 'cardmarket', card: 'base1-4', label: 'Charizard', products: [{ cm: 5, url: base }], filters: { maxLoadMore: 5, languages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], conditions: true }, match: {} };
  const n = await vm.runInContext('scrapeCardmarket', ctx)(item);
  assert.strictEqual(n, 1);
  const got = ingested.data.articles, byLC = {};
  for (const a of got) byLC[a[1] + a[2]] = (byLC[a[1] + a[2]] || 0) + 1;
  assert.strictEqual(new Set(got.map(a => a[0])).size, got.length, 'each offer once');
  assert.ok(got.length > 300, 'more than the 300 a single cut-off view shows: ' + got.length);
  assert.strictEqual(byLC['1MT'], 150, 'every English Mint offer'); assert.strictEqual(byLC['1NM'], 150, 'every English Near Mint offer');
  assert.strictEqual(byLC['3NM'], 150, 'every German offer'); assert.strictEqual(byLC['7NM'], 50, 'Japanese offers, too expensive to show in the first view');
  const cov = ingested.data.coverage;
  assert.deepStrictEqual(cov[0].slice(0, 2).concat(cov[0][3]), [0, 0, 0], 'all languages: cut off');
  assert.ok(cov.some(c => c[0] === 1 && c[1] && c[3]), 'English complete at some condition threshold');
  assert.ok(cov.some(c => c[0] === 3 && c[1] === 0 && c[3]), 'German complete without a condition filter');
  assert.deepStrictEqual(cov.find(c => c[0] === 2), [2, 0, 0, 1], 'French: checked, no offers');
  // Cardmarket's condition filter is "this or better", so the worst conditions can't be isolated: beyond the load
  // limit their most expensive offers stay out (the coverage says which views were cut off); the cheapest are all in
  const ids = new Set(got.map(a => a[0])), cheapEn = offers.filter(a => a[1] === 1).sort((x, y) => x[3] - y[3]).slice(0, 300);
  assert.ok(cheapEn.every(a => ids.has(a[0])), 'the cheapest English offers of any condition');
  assert.ok(offers.filter(a => ['MT', 'NM', 'EX', 'GD'].includes(a[2]) || a[1] !== 1).every(a => ids.has(a[0])), 'every offer in Good or better, and in every other language');
});
