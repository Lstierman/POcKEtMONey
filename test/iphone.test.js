// The iPhone script's scan logic (iphone/pocketmoney-cardmarket.user.js) against a simulated Cardmarket product:
// pages of the 50 cheapest offers, filters that work or are silently ignored, ties at one price.
const test = require('node:test'), assert = require('node:assert');
const C = require('../iphone/pocketmoney-cardmarket.user.js');

const CONDS = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'], COUNTRIES = ['Germany', 'France', 'Italy', 'Spain', 'Netherlands'];
function product(n, opts = {}) {
  let seed = opts.seed || 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const langs = opts.langs || [1, 1, 1, 3, 2, 5, 4];
  return Array.from({ length: n }, (_, i) => [100000 + i, langs[Math.floor(rnd() * langs.length)], CONDS[Math.floor(rnd() * 5)],
    opts.price ? opts.price(i, rnd) : Math.round((5 + rnd() * 200) * 100) / 100, 1, 0, 0, 0, 0, COUNTRIES[Math.floor(rnd() * 5)], 's' + i, '', 42]);
}
// Cardmarket as simulated: the cheapest PAGE offers of the filter, cheapest first. Unknown filters and values are ignored.
function site(offers, { price = null, languages = [1, 2, 3, 4, 5, 8], conditions = true } = {}) {
  const calls = [];
  const fetchView = async params => {
    calls.push(C.qs(params));
    let rows = offers.slice();
    if (params.language && languages.includes(+params.language)) rows = rows.filter(a => a[1] === +params.language);
    if (params.minCondition && conditions) rows = rows.filter(a => CONDS.indexOf(a[2]) + 1 <= +params.minCondition);
    if (price && params[price] != null) rows = rows.filter(a => a[3] >= +params[price]);
    rows.sort((a, b) => a[3] - b[3] || a[0] - b[0]);
    return { idProduct: 42, title: 'Charizard', info: { available: offers.length }, form: { languages: [], countries: [], fields: [] }, articles: rows.slice(0, 50), more: rows.length > 50 };
  };
  return { fetchView, calls };
}
const ids = arts => new Set(arts.map(a => a[0]));

test('iphone: a product with one page of offers takes one request', async () => {
  const s = site(product(30)), r = await C.scanProduct(s.fetchView, {});
  assert.strictEqual(s.calls.length, 1); assert.ok(r.complete); assert.strictEqual(r.articles.length, 30);
  assert.deepStrictEqual(r.coverage, [[0, 0, 30, 1]]);
});

test('iphone: price floor paging reads every offer when Cardmarket filters by price', async () => {
  const offers = product(420), s = site(offers, { price: 'minPrice' });
  const r = await C.scanProduct(s.fetchView, { priceParams: ['minPrice'] });
  assert.ok(r.complete, JSON.stringify(r.diag)); assert.strictEqual(r.articles.length, 420);
  assert.deepStrictEqual(ids(r.articles), ids(offers));
  assert.strictEqual(r.diag.priceParam, 'minPrice'); assert.ok(s.calls.length <= 11, s.calls.length + ' requests');
});

test('iphone: a price parameter Cardmarket ignores is detected, then languages and conditions are used', async () => {
  const offers = product(420), s = site(offers, { price: null });
  const r = await C.scanProduct(s.fetchView, { priceParams: ['minPrice', 'priceMin'] });
  assert.strictEqual(r.diag.priceParam, 'none'); assert.deepStrictEqual(r.diag.priceTried, ['minPrice', 'priceMin']);
  // every stored offer is a real offer; every trusted view's rows match its filter
  for (const a of r.articles) assert.ok(ids(offers).has(a[0]));
  for (const [lang, cond, , ] of r.coverage) assert.ok(lang === 0 || [1, 2, 3, 4, 5].includes(lang) || lang === 8, 'no view trusted for a language Cardmarket ignores: ' + lang);
  // languages Cardmarket ignores here (Chinese, Japanese, …) return the unfiltered list: no offers missed, not counted as views
  assert.ok(r.diag.dims.language.ignoredValues >= 6);
  // a language with under 50 offers is read completely; one with more is cut and read per condition
  const count = {}; offers.forEach(a => { count[a[1]] = (count[a[1]] || 0) + 1; });
  for (const l of Object.keys(count).map(Number)) {
    const v = r.coverage.find(c => c[0] === l && c[1] === 0);
    assert.ok(v, 'language ' + l + ' viewed'); assert.strictEqual(v[3], count[l] < 50 ? 1 : 0, 'language ' + l);
    if (count[l] < 50) assert.strictEqual(r.articles.filter(a => a[1] === l).length, count[l]);
    else assert.ok(r.coverage.some(c => c[0] === l && c[1] === 1), 'language ' + l + ' per condition');
  }
  assert.ok(r.articles.length > 250, r.articles.length + ' offers');
});

test('iphone: a filter whose rows do not match is never trusted (the old scraper stored those as language views)', () => {
  const rows = product(50, { langs: [1] });
  assert.strictEqual(C.viewOk({ language: 7 }, rows, {}), false);
  assert.strictEqual(C.viewOk({ language: 1 }, rows, {}), true);
  assert.strictEqual(C.viewOk({ minCondition: 1 }, rows.filter(a => a[2] === 'MT'), {}), true);
  assert.strictEqual(C.viewOk({ minCondition: 2 }, rows.filter(a => a[2] === 'EX'), {}), false);
  assert.strictEqual(C.viewOk({ minPrice: 50 }, rows, { priceParam: 'minPrice' }), rows.every(a => a[3] >= 50));
});

test('iphone: more offers at one price than a page holds stops the price paging, the rest is split by language', async () => {
  const offers = product(200, { price: i => (i < 120 ? 1 : 2 + i / 10) }), s = site(offers, { price: 'minPrice' });
  const r = await C.scanProduct(s.fetchView, { priceParam: 'minPrice' });
  assert.ok(r.diag.dims.language && r.diag.dims.language.trusted > 0);
  for (const a of r.articles) assert.ok(ids(offers).has(a[0]));
});

test('iphone: the request budget is respected and reported', async () => {
  const s = site(product(2000, { langs: [1] }), { price: null });
  const r = await C.scanProduct(s.fetchView, { priceParams: [], maxViews: 8 });
  assert.ok(s.calls.length <= 8); assert.strictEqual(r.complete, false); assert.ok(r.diag.budgetHit);
});

test('iphone: prices, statistics and the language × condition matrix', () => {
  assert.strictEqual(C.parsePrice('1.234,56 €'), 1234.56); assert.strictEqual(C.parsePrice('12,50 €'), 12.5);
  assert.strictEqual(C.parsePrice('1,234.56 €'), 1234.56); assert.strictEqual(C.parsePrice('$5.00'), null);
  assert.deepStrictEqual(C.stats([1, 2, 3, 4, 100]), { n: 5, min: 1, median: 3, avg: 22, max: 100 });
  const m = C.matrix([[1, 1, 'NM', 10, 2, 0, 0, 0, 0, '', '', '', 1], [2, 1, 'NM', 8, 1, 0, 0, 0, 0, '', '', '', 1], [3, 3, 'EX', 5, 1, 0, 0, 0, 0, '', '', '', 1], [4, 1, 'NM', 1, 1, 0, 1, 0, 0, '', '', '', 1]]);
  assert.deepStrictEqual(m[1].cells.NM, { n: 3, min: 8 }); assert.strictEqual(m[1].nm.n, 3); assert.deepStrictEqual(m[3].cells.EX, { n: 1, min: 5 });
});

// ---------- the inbox: captures from the phone filed into the price store (scripts/ingest-inbox.js) ----------
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib'), cp = require('child_process');
const root = path.join(__dirname, '..');
const map = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'data/card-map.json.gz'))));
function ingest(dir, inbox, done) {
  return cp.spawnSync(process.execPath, ['--require', path.join(__dirname, 'mock-fetch.js'), path.join(root, 'scripts/ingest-inbox.js'), '--store=' + dir, '--inbox=' + inbox, '--done=' + done], { encoding: 'utf8' });
}
function put(inbox, name, cap) { const f = path.join(inbox, 'cardmarket/2026-11-02', name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(cap)); }

test('inbox: phone captures are filed into the store, once, and bad ones are rejected alone', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptcg-inbox-')), dir = path.join(tmp, 'store'), inbox = path.join(tmp, 'inbox'), done = path.join(tmp, 'done.txt');
  const card = map.cards.find(c => c[0] === 'base1-4'), cm = card[6][0][0];
  const row = (id, lang, cond, price) => [id, lang, cond, price, 1, 0, 0, 0, 0, 'Germany', 'seller' + id, '', cm];
  const cap = (at, articles, extra) => Object.assign({ v: 1, site: 'cardmarket', via: 'iphone', at, url: 'https://www.cardmarket.com/en/Pokemon/Products/Singles/Base-Set/Charizard-V1-BS4',
    data: { idProduct: cm, title: 'Charizard', articles, found: articles.length, coverage: [[0, 0, articles.length, 1]], complete: true, available: 3 } }, extra);
  put(inbox, 'a.json', cap('2026-11-02T10:00:00.000Z', [row(5000001, 1, 'NM', 400), row(5000002, 3, 'EX', 300), row(5000003, 1, 'NM', 420)]));
  put(inbox, 'b.json', cap('2026-11-02T09:00:00.000Z', [row(5000001, 1, 'NM', -5)]));                  // invalid price
  put(inbox, 'c.json', cap('2026-11-02T09:30:00.000Z', [row(5000009, 1, 'NM', 5)], { data: { idProduct: 1, articles: [] } })); // not a catalog card
  let r = ingest(dir, inbox, done);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /1 applied to 1 cards, 0 already applied, 1 not in the catalog, 1 rejected/);
  assert.deepStrictEqual(fs.readFileSync(done, 'utf8').trim().split('\n').sort(), ['cardmarket/2026-11-02/a.json', 'cardmarket/2026-11-02/b.json', 'cardmarket/2026-11-02/c.json']);

  const listing = JSON.parse(fs.readFileSync(path.join(dir, 'listings/cardmarket', card[1], 'base1-4.json')));
  const p = listing.products.find(x => x.cm === cm);
  assert.strictEqual(p.articles.length, 3); assert.strictEqual(p.via, 'iphone'); assert.strictEqual(p.available, 3);
  const sum = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'summary.json.gz'))));
  assert.ok(sum.cards['base1-4'].l['1|NM|'], 'listing statistics'); assert.strictEqual(sum.cards['base1-4'].lc, 1);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
  assert.strictEqual(state.capture.cardmarket['base1-4'], '2026-11-02T10:00:00.000Z');
  assert.strictEqual(state.urls.cardmarket[cm], 'https://www.cardmarket.com/en/Pokemon/Products/Singles/Base-Set/Charizard-V1-BS4');

  // the same capture again (the inbox could not be emptied last time): recognised, nothing changes
  r = ingest(dir, inbox, done);
  assert.match(r.stdout, /0 applied to 0 cards, 1 already applied/);
});
