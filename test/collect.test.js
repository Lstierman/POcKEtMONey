// node --test test/ — collector (free feeds), statistics, store
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const P = require('../src/prices.js');
const { Store, validate, addPoint } = require('../scripts/lib/store.js');
const EB = require('../scripts/lib/ebay.js');

const root = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ptcg-store-'));
function collect(dir, args, env) {
  const logF = path.join(dir, '..', path.basename(dir) + '-requests.json');
  const r = cp.spawnSync(process.execPath, ['--require', path.join(__dirname, 'mock-fetch.js'), path.join(root, 'scripts/collect.js'), dir, ...args],
    { env: Object.assign({}, process.env, { MOCK_LOG: logF }, env), encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr, requests: fs.existsSync(logF) ? JSON.parse(fs.readFileSync(logF)) : [] };
}

test('listing statistics: trimmed mean, median, quantities, groups', () => {
  assert.deepStrictEqual(P.stats([10, 20, 30]), [3, 10, 20, 20, 30]);
  // one absurd asking price is trimmed from the average but still the max
  const s = P.stats([10, 10, 10, 10, 10, 10, 10, 10, 10, 9999]);
  assert.strictEqual(s[3], 10); assert.strictEqual(s[4], 9999);
  const rows = [[1, 1, 'NM', 10, 2, 0, 0, 0, 0, 'DE', 'x', '', 5], [2, 1, 'NM', 20, 1, 0, 0, 0, 0, 'DE', 'y', '', 5], [3, 1, 'NM', 50, 1, 1, 0, 0, 0, 'FR', 'z', '', 5], [4, 3, 'EX', 7, 1, 0, 0, 0, 0, 'DE', 'q', '', 5]];
  const g = P.aggregateArticles(rows);
  assert.deepStrictEqual(Object.keys(g).sort(), ['1|NM|', '1|NM|f', '3|EX|']);
  assert.deepStrictEqual(g['1|NM|'], [3, 10, 10, 13.33, 20]); // quantity 2 counts twice
  assert.deepStrictEqual(P.listingAvg(g, 1, 'NM'), { n: 3, avg: 13.33, min: 10 }); // foil excluded
  assert.strictEqual(P.listingAvg(g, 3, 'NM'), null); // EX is worse than NM
  assert.strictEqual(P.listingAvg(g, 3, 'EX').avg, 7);
});

test('currency conversion', () => {
  const fx = { EUR: 1, USD: 0.9 };
  assert.strictEqual(P.toEur(100, 'USD', fx), 90); assert.strictEqual(P.fromEur(90, 'USD', fx), 100); assert.strictEqual(P.toEur(5, 'EUR', fx), 5);
  assert.strictEqual(P.toEur(5, 'XYZ', fx), null);
});

test('eBay queries are localized and irrelevant items dropped', () => {
  const c = ['base1-4', 'base1', 'Charizard', '4', 102, 'en', [], [], { de: 'Glurak' }, null, 'BS', 'Base'];
  assert.strictEqual(EB.query(c, 'EBAY_DE'), 'Glurak 4/102');
  assert.strictEqual(EB.query(c, 'EBAY_US'), 'Charizard 4/102');
  const rows = [['1', 'Charizard 4/102 holo'], ['2', 'Charizard 6/102'], ['3', 'Glurak 4/102'], ['4', 'Blastoise 4/102']];
  assert.deepStrictEqual(EB.relevant(c, rows).map(r => r[0]), ['1', '3']);
  assert.ok(P.isGraded('Charizard PSA 10 4/102')); assert.ok(P.isGraded('CGC 8.5 Charizard')); assert.ok(!P.isGraded('Charizard 4/102 NM'));
});

test('store refuses invalid data and never leaves a half-written file', () => {
  const s = new Store(tmp());
  s.write('meta.json', { v: 1, at: new Date().toISOString(), fx: { EUR: 1, USD: 0.9 } }, 'meta');
  assert.throws(() => s.write('meta.json', { v: 1, at: 'yesterday', fx: { EUR: 1, USD: 0.9 } }, 'meta'), /invalid meta/);
  assert.strictEqual(s.read('meta.json').fx.USD, 0.9); // old file intact
  assert.throws(() => s.write('summary.json.gz', { v: 1, at: new Date().toISOString(), fx: { USD: 1 }, cards: { x: { l: { '1|NM|': [0, 1, 1, 1, 1] }, lt: 'x' } } }, 'summary'), /invalid summary/);
  assert.deepStrictEqual(fs.readdirSync(s.dir).filter(f => f.includes('.tmp-')), []);
  assert.deepStrictEqual(s.verify(), []);
});

test('history keeps hourly points for the window, then one per day', () => {
  const cfg = { hourlyPoints: 72, dailyDays: 180 }, now = Date.parse('2026-10-22T12:00:00Z');
  let h = [];
  for (let d = 10; d >= 0; d--) for (const hr of ['06', '18']) {
    const t = new Date(now - d * 86400e3).toISOString().slice(0, 11) + hr;
    h = addPoint(h, [t, d * 10 + +hr, null, null, null, null], cfg, now);
  }
  const old = h.filter(p => p[0] < '2026-10-19T12'), recent = h.filter(p => p[0] >= '2026-10-19T12');
  assert.strictEqual(new Set(old.map(p => p[0].slice(0, 10))).size, old.length); // one per day
  assert.ok(recent.length >= 5);
  assert.strictEqual(addPoint(h.slice(), [h[h.length - 1][0].slice(0, 11) + '23'].concat(h[h.length - 1].slice(1)), cfg, now).length, h.length); // unchanged value: no new point
  assert.strictEqual(validate('history', { x: h }), null);
});

test('collector: price guide, TCGplayer, exchange rates, headline, history, interval gate', () => {
  const dir = tmp();
  const r = collect(dir, ['--force']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /verified/);
  assert.ok(!r.requests.some(([u]) => /cardmarket\.com\/ws|api\.ebay|cardtrader/.test(u)), 'no API calls');
  const s = new Store(dir), sum = s.read('summary.json.gz'), e = sum.cards['base1-4'];
  assert.strictEqual(e.g[0][1], 280); assert.strictEqual(typeof e.g[0][8], 'string'); assert.strictEqual(e.t[0][2], 954.65);
  assert.strictEqual(e.h, 280); assert.strictEqual(e.hs, 'trend');
  const hist = s.read(s.historyFile('base1'))['base1-4'];
  assert.strictEqual(hist.length, 1); assert.strictEqual(hist[0][1], 280);
  assert.ok(sum.fx.USD > 0.89 && sum.fx.USD < 0.9);
  assert.deepStrictEqual(Object.keys(s.read('meta.json').sources).sort(), ['fx', 'guide', 'tcg']);
  // second run inside the interval does nothing
  const r2 = collect(dir, []);
  assert.match(r2.out, /not due/); assert.strictEqual(r2.requests.length, 0);
});

test('collector keeps what the scraper saved and uses it for the headline', () => {
  const dir = tmp(), s = new Store(dir), at = new Date().toISOString();
  const l = P.aggregateArticles([[1, 1, 'NM', 300, 1, 0, 0, 0, 0, 'DE', 's', '', 1]]);
  s.write('summary.json.gz', { v: 1, at, fx: { EUR: 1, USD: 0.9 }, sources: { listings: { at, ok: false } }, cards: { 'base1-2': { l, lt: at, ln: 1, ea: [1, 50, 50, 50, 50], et: at, en: [1, 0] } } }, 'summary');
  s.write('meta.json', { v: 1, at: '2020-01-01T00:00:00Z', fx: { EUR: 1, USD: 0.9 }, sources: { listings: { at, ok: false } } }, 'meta');
  const r = collect(dir, []);
  assert.strictEqual(r.code, 0, r.out);
  const e = new Store(dir).read('summary.json.gz').cards['base1-2'];
  assert.deepStrictEqual(e.l, l); assert.deepStrictEqual(e.ea, [1, 50, 50, 50, 50]);
  assert.strictEqual(e.h, 300); assert.strictEqual(e.hs, 'listings');
  assert.ok(!new Store(dir).read('meta.json').sources.listings, 'replaced sources are no longer reported');
});
