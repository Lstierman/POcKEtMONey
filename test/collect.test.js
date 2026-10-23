// node --test test/
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const P = require('../src/prices.js');
const { Store, validate, addPoint } = require('../scripts/lib/store.js');
const { authHeader } = require('../scripts/lib/cardmarket.js');
const EB = require('../scripts/lib/ebay.js');

const root = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ptcg-store-'));
const creds = { CARDTRADER_TOKEN: 'ct', CARDMARKET_APP_TOKEN: 'a', CARDMARKET_APP_SECRET: 'b', CARDMARKET_ACCESS_TOKEN: 'c', CARDMARKET_ACCESS_SECRET: 'd', EBAY_CLIENT_ID: 'e', EBAY_CLIENT_SECRET: 'f' };
function collect(dir, args, env) {
  const logF = path.join(dir, '..', path.basename(dir) + '-requests.json');
  const r = cp.spawnSync(process.execPath, ['--require', path.join(__dirname, 'mock-fetch.js'), path.join(root, 'scripts/collect.js'), dir, ...args],
    { env: Object.assign({}, process.env, creds, { MOCK_LOG: logF }, env), encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr, requests: fs.existsSync(logF) ? JSON.parse(fs.readFileSync(logF)) : [] };
}

test('OAuth 1.0a signature matches the RFC 5849 example', () => {
  const h = authHeader('GET', 'http://photos.example.net/photos?file=vacation.jpg&size=original',
    { appToken: 'dpf43f3p2l4k3l03', appSecret: 'kd94hf93k423kf44', accessToken: 'nnch734d00sl2jdk', accessSecret: 'pfkkdhi9sl3r4s00' }, 'kllo9940pd9333jh', 1191242096);
  assert.match(h, /oauth_signature="tR3%2BTy81lMeYAr%2FFid0kMTYa%2FWM%3D"/);
  assert.match(h, /^OAuth realm="http:\/\/photos\.example\.net\/photos", /);
});

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

test('currency conversion and coverage tiers', () => {
  const fx = { EUR: 1, USD: 0.9 };
  assert.strictEqual(P.toEur(100, 'USD', fx), 90); assert.strictEqual(P.fromEur(90, 'USD', fx), 100); assert.strictEqual(P.toEur(5, 'EUR', fx), 5);
  assert.strictEqual(P.toEur(5, 'XYZ', fx), null);
  assert.strictEqual(P.coverage({}).tier, 'No data');
  assert.strictEqual(P.coverage({ guide: 1, listings: 1, tcg: 1, ebayActive: 1, ebaySold: 1, graded: 1 }).tier, 'Complete');
  assert.strictEqual(P.coverage({ guide: 1, tcg: 1, graded: 1 }).n, 3);
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

test('collector end to end: listings, eBay, summary, history, interval gate', () => {
  const dir = tmp();
  const r = collect(dir, ['--force', '--cards=base1-4']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /verified/);
  const s = new Store(dir), sum = s.read('summary.json.gz'), e = sum.cards['base1-4'];
  // Cardmarket: every product paged through (206 then 200), all articles kept
  const cm = s.read(s.listingFile('cardmarket', 'base1', 'base1-4'));
  assert.ok(cm.products.length >= 1);
  for (const p of cm.products) assert.strictEqual(p.articles.length, 1037);
  assert.ok(r.requests.some(([u, a]) => u.includes('start=1000') && /^OAuth realm="https:\/\/apiv2\.cardmarket\.com\/ws\/v2\.0\/output\.json\/articles\/\d+", oauth_consumer_key="a"/.test(a)));
  const all = cm.products.flatMap(p => p.articles);
  assert.deepStrictEqual(e.l, P.aggregateArticles(all));
  assert.ok(e.l['1|NM|'] && e.l['3|NM|'] && e.l['1|NM|f']);
  // eBay: wrong card number dropped, graded kept but flagged, everything stored per marketplace
  const eb = s.read(s.listingFile('ebay', 'base1', 'base1-4'));
  assert.ok(!eb.active.some(x => /6\/102/.test(x[1])));
  assert.strictEqual(eb.active.filter(x => x[12]).length, 4); // the PSA 9, once per marketplace
  assert.strictEqual(eb.active.find(x => x[0] === 'EBAY_DE-4')[2], 350); // auction: current bid
  assert.strictEqual(eb.sold.length, 8);
  assert.deepStrictEqual(eb.queries, { EBAY_DE: 'Glurak 4/102', EBAY_US: 'Charizard 4/102', EBAY_GB: 'Charizard 4/102', EBAY_FR: 'Dracaufeu 4/102' });
  // headline stats are EUR, raw copies in the card's language: 400 EUR, 400 USD, 400 GBP, 400 EUR (FR); the
  // "Glurak" auctions are German copies and the PSA 9 is graded, so both are only in the breakdown
  const usd = 400 / 1.12, gbp = 400 / 0.84;
  assert.deepStrictEqual(e.ea, P.stats([400, usd, gbp, 400]));
  assert.deepStrictEqual(e.b['eb|L|3|'], P.stats([350, 350 / 1.12, 350 / 0.84, 350]), 'German copies, for sale');
  assert.strictEqual(e.b['eb|L|1|PSA 9'][0], 4, 'PSA 9, once per marketplace');
  assert.ok(e.b['eb|S|1|CGC 8.5'] && e.b['eb|S|1|'], 'sold: graded and raw apart');
  assert.ok(Object.keys(e.b).some(k => /^cm\|L\|3\|$/.test(k)) && Object.keys(e.b).some(k => /^cm\|L\|1\|$/.test(k)), 'Cardmarket listings per language');
  assert.ok(Object.keys(e.b).every(k => P.SEG_KEY.test(k)));
  assert.deepStrictEqual(e.es, P.stats([420, 420 / 1.12, 420, 420]));
  // guide, TCGplayer, headline and history
  assert.strictEqual(e.g[0][1], 280); assert.strictEqual(typeof e.g[0][8], 'string'); assert.strictEqual(e.t[0][2], 954.65);
  assert.strictEqual(e.h, 280); assert.strictEqual(e.hs, 'trend');
  const hist = s.read(s.historyFile('base1'))['base1-4'];
  assert.strictEqual(hist.length, 1); assert.strictEqual(hist[0][1], 280);
  assert.strictEqual(hist[0][3], P.listingAvg(e.l, 1, 'NM').avg);
  assert.ok(sum.fx.USD > 0.89 && sum.fx.USD < 0.9);
  // second run inside the interval does nothing
  const r2 = collect(dir, []);
  assert.match(r2.out, /not due/); assert.strictEqual(r2.requests.length, 0);
});

test('collector without Insights access still stores listings for sale', () => {
  const dir = tmp();
  const r = collect(dir, ['--force', '--cards=base1-4', '--only=ebay'], { MOCK_NO_INSIGHTS: '1' });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /sold: eBay token: The requested scope is invalid/);
  const s = new Store(dir), eb = s.read(s.listingFile('ebay', 'base1', 'base1-4'));
  assert.strictEqual(eb.sold.length, 0); assert.ok(eb.active.length > 0);
  assert.ok(s.read('state.json').insightsBlockedUntil);
});

test('collector without credentials skips the paid sources and says why', () => {
  const dir = tmp();
  const r = cp.spawnSync(process.execPath, ['--require', path.join(__dirname, 'mock-fetch.js'), path.join(root, 'scripts/collect.js'), dir, '--force'],
    { env: Object.assign({}, process.env, { CARDMARKET_APP_TOKEN: '', EBAY_CLIENT_ID: '' }), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /listings: skipped \(no Cardmarket API credentials/);
  assert.match(r.stdout, /ebay: skipped \(no eBay API credentials/);
  assert.ok(new Store(dir).read('summary.json.gz').cards['base1-4'].g);
});

test('CardTrader: blueprints mapped by Cardmarket id, listings converted and stored', () => {
  const dir = tmp();
  const r = collect(dir, ['--force', '--only=cardtrader']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /cardtrader: ok \(requests 4\/120, 1 expansions mapped\), 1 cards/);
  const s = new Store(dir), f = s.read(s.listingFile('cardtrader', 'base1', 'base1-4'));
  assert.strictEqual(f.blueprints.length, 1); assert.strictEqual(f.blueprints[0].bp, 9001);
  const rows = f.blueprints[0].articles;
  assert.strictEqual(rows.length, 3); // the 0-cent listing is dropped
  assert.deepStrictEqual(rows[1].slice(0, 5).concat(rows[1].slice(9, 12)), [2, 3, 'EX', 250, 2, 'DE', 'misty', 'small whitening']); // German, Slightly Played -> EX
  assert.strictEqual(rows[2][3], 300); // 336 USD at 1.12 per EUR
  const e = s.read('summary.json.gz').cards['base1-4'];
  assert.deepStrictEqual(e.c, P.aggregateArticles(rows)); assert.strictEqual(e.ctn, 3);
  assert.ok(!r.requests.some(([u]) => u.includes('expansion_id=7'))); // not a Pokémon expansion
  // the mapping is cached for a week: a second run only fetches listings
  const r2 = collect(dir, ['--force', '--only=cardtrader']);
  assert.ok(!r2.requests.some(([u]) => u.includes('/blueprints/') || u.endsWith('/expansions')), 'mapping refetched');
  assert.ok(r2.requests.some(([u]) => u.includes('/marketplace/products?expansion_id=100')));
  assert.ok(r.requests.filter(([u]) => u.includes('cardtrader')).every(([, a]) => a === 'Bearer ct'));
});
