// Platform tests: which cards get scraped (planner), in what order (queue), the CPU budget (governor), and a full
// background-scraper run with a fake site module (no Chrome, no network) that must stay under the CPU limit.
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { plan, lastSeen } = require('../platform/scheduler/planner.js');
const { JobQueue } = require('../platform/scheduler/queue.js');
const { CpuGovernor } = require('../platform/scheduler/cpu.js');
const { Capture } = require('../platform/capture.js');
const { Scheduler } = require('../platform/scheduler/index.js');
const { createServer } = require('../platform/server.js');
const { Watchlist, loadConfig } = require('../scripts/lib/config.js');

const H = 3600e3, NOW = Date.parse('2026-10-26T12:00:00Z'), iso = ms => new Date(ms).toISOString();
const card = (id, i) => [id, 'set1', 'Card ' + i, String(i), 100, 'en', [], [], {}, null, 'S1', 'Set One'];
const cfg = { schedule: { hotEur: 50, warmEur: 5 }, scrape: { sites: ['ebay'], staleHours: { watchlist: 6, hot: 12, warm: 72, cold: 336 }, missingPerPlan: 2, outdatedPerPlan: 2 } };
const quiet = { log() {}, warn() {}, error() {} };

test('planner: watchlist first, then missing and outdated by value; fresh cards are left alone', () => {
  const cards = ['w-fresh', 'w-old', 'w-new', 'hot-old', 'hot-fresh', 'cold-old', 'cold-recent', 'miss-cheap', 'miss-rich', 'miss-mid'].map(card);
  const entries = {
    'w-fresh': { h: 1, et: iso(NOW - 2 * H) }, 'w-old': { h: 1, et: iso(NOW - 7 * H) },
    'hot-old': { h: 100, et: iso(NOW - 13 * H) }, 'hot-fresh': { h: 100, et: iso(NOW - H) },
    'cold-old': { h: 1, et: iso(NOW - 400 * H) }, 'cold-recent': { h: 1, et: iso(NOW - 100 * H) },
    'miss-cheap': { h: 1 }, 'miss-rich': { h: 300 }, 'miss-mid': { h: 20 }
  };
  const jobs = plan({ cards, entries, state: { cm: {}, eb: {} }, watch: ['w-fresh', 'w-old', 'w-new'], cfg, now: NOW });
  const ids = jobs.map(j => j.id);
  assert.deepStrictEqual(ids.slice(0, 2).sort(), ['w-new', 'w-old']); // watched and due; w-fresh is fresh
  assert.ok(!ids.includes('w-fresh') && !ids.includes('hot-fresh') && !ids.includes('cold-recent'));
  assert.deepStrictEqual(jobs.find(j => j.id === 'w-new').reasons, ['watchlist', 'missing']);
  assert.deepStrictEqual(jobs.find(j => j.id === 'hot-old').reasons, ['outdated']);
  // at most 2 missing (the two most valuable) and 2 outdated
  assert.ok(ids.includes('miss-rich') && ids.includes('miss-mid') && !ids.includes('miss-cheap'));
  assert.ok(ids.includes('hot-old') && ids.includes('cold-old'));
  assert.ok(ids.indexOf('hot-old') < ids.indexOf('cold-old'), 'valuable outdated card first');
  assert.ok(jobs.every((j, i) => i === 0 || jobs[i - 1].band <= j.band));
});

test('planner: a card the hourly collector or the extension refreshed is not scraped again', () => {
  const state = { cm: {}, eb: { a: iso(NOW - H) }, capture: { ebay: { b: iso(NOW - H) } }, scrape: { ebay: { c: iso(NOW - H) } } };
  for (const id of ['a', 'b', 'c']) assert.strictEqual(lastSeen('ebay', id, {}, state), NOW - H);
  const jobs = plan({ cards: ['a', 'b', 'c', 'd'].map(card), entries: {}, state, watch: ['a', 'b', 'c', 'd'], cfg, now: NOW });
  assert.deepStrictEqual(jobs.map(j => j.id), ['d']);
});

test('queue: one job per card and site, manual jobs survive re-planning, failures back off', () => {
  const q = new JobQueue({ maxAttempts: 2, backoffMs: 1000 });
  const j = (id, band, score, reasons) => ({ key: 'ebay:' + id, site: 'ebay', id, band, score, reasons });
  q.sync([j('a', 1, 5, ['outdated']), j('b', 1, 9, ['missing']), j('w', 0, 1, ['watchlist'])]);
  q.upsert(j('a', 1, 3, ['outdated']));
  assert.strictEqual(q.size, 3);
  q.upsert(j('m', 0, 1e9, ['manual']));
  q.sync([j('b', 1, 9, ['missing'])]); // a and w are no longer planned; m was added by hand
  assert.deepStrictEqual(q.list().map(x => x.id), ['m', 'b']);
  assert.strictEqual(q.next(0).id, 'm');
  const b = q.next(0); q.failed(b, 'boom', 0);
  assert.strictEqual(q.next(500), null, 'waits out the backoff');
  assert.strictEqual(q.next(1500).id, 'b');
  q.failed(b, 'boom again', 1500);
  assert.strictEqual(q.size, 0, 'dropped after maxAttempts');
});

test('CPU governor: work is held back so the average stays at the limit', async () => {
  let t = 0; const g = new CpuGovernor({ limitPercent: 20, cores: 2, now: () => t, sleep: async ms => { t += ms; } });
  // each unit of work costs 0.2 CPU-seconds; the budget is 0.4 CPU-s per second
  for (let i = 0; i < 50; i++) { await g.acquire(); t += 50; g.spend(0.2); }
  const avg = g.spent / (t / 1000) / 2;
  assert.ok(avg <= 0.2, 'average ' + avg);
  assert.ok(avg > 0.15, 'and the budget is actually used: ' + avg);
  for (const w of [5e3, 10e3, 30e3]) assert.ok(g.usage(w) <= 20, `usage over the last ${w / 1000} s: ${g.usage(w)}`);
});

function setup(watch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptcg-platform-'));
  const c = loadConfig();
  c.scrape = Object.assign({}, c.scrape, { browser: 'none', sites: ['ebay'], cpuLimitPercent: 20, saveEverySeconds: 0, missingPerPlan: 0, outdatedPerPlan: 0, maxAttempts: 1 });
  const capture = new Capture({ dir: path.join(dir, 'store'), cfg: c, log: quiet }).load();
  capture.journalF = path.join(dir, 'journal.jsonl');
  capture.fx = { EUR: 1, USD: 0.9, GBP: 1.15 }; capture.fxDate = '2026-10-23';
  const wl = new Watchlist(path.join(dir, 'watchlist.json')); for (const id of watch) wl.add(id);
  return { dir, cfg: c, capture, wl };
}

test('background scraper: watchlist cards are scraped into the store under the CPU limit', async () => {
  process.env.POCKET_SITES_DIR = path.join(__dirname, 'fixtures/sites');
  const ids = ['base1-4', 'base1-2', 'base1-15'];
  const { cfg: c, capture, wl } = setup(ids);
  const s = new Scheduler({ cfg: c, capture, watchlist: wl, log: quiet, once: true });
  // independent check on Linux: the kernel's CPU accounting for this process and its (exited) children
  const kernel = () => { try { const f = fs.readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' '); return (+f[11] + +f[12] + +f[13] + +f[14]) / 100; } catch (e) { return null; } };
  const k0 = kernel(), t0 = Date.now();
  s.start(); await s.loopDone; await s.stop();
  const wall = (Date.now() - t0) / 1000, st = s.status();
  await new Promise(r => setTimeout(r, 1500)); // the worker exits and is accounted to us
  assert.strictEqual(st.counts.done, 3); assert.strictEqual(st.counts.captures, 12);
  // everything the scraping used, measured by the governor, averaged over the run
  const pct = st.cpu.cpuSeconds / wall / st.cpu.cores * 100;
  assert.ok(st.cpu.cpuSeconds >= 1.5, 'the fake pages burned CPU: ' + st.cpu.cpuSeconds);
  assert.ok(pct <= 20, `scraping used ${pct.toFixed(1)}% of the machine over ${wall.toFixed(1)} s`);
  assert.ok(st.cpu.usagePercent <= 20, 'last-30-s figure: ' + st.cpu.usagePercent);
  assert.ok(st.cpu.throttledSeconds > 0, 'the governor had to hold work back');
  if (k0 != null) {
    const k = (kernel() - k0) / (wall + 1.5) / st.cpu.cores * 100;
    console.log(`  scraping CPU ${pct.toFixed(1)}% by the governor, ${k.toFixed(1)}% by the kernel (incl. the test runner), over ${wall.toFixed(1)} s`);
    assert.ok(k <= 20, 'kernel-measured ' + k.toFixed(1) + '%');
  }
  // results are in the store, in the collector's format
  const sum = capture.store.read('summary.json.gz');
  for (const id of ids) {
    assert.deepStrictEqual(sum.cards[id].en, [2, 2]);
    assert.ok(capture.state.scrape.ebay[id]);
    assert.ok(capture.store.exists(capture.store.listingFile('ebay', 'base1', id)));
  }
  assert.strictEqual(capture.store.read('state.json').scrape.ebay['base1-4'], capture.state.scrape.ebay['base1-4']);
  // and planning again finds nothing to do for them
  const again = plan({ cards: capture.map.cards, entries: capture.entries(), state: capture.state, watch: ids, cfg: c, now: Date.now() });
  assert.ok(!again.some(j => ids.includes(j.id)));
});

test('background scraper: a failing card does not stop the others', async () => {
  process.env.POCKET_SITES_DIR = path.join(__dirname, 'fixtures/sites');
  process.env.POCKET_TEST_FAIL = 'base1-2'; process.env.POCKET_TEST_BURN_MS = '5';
  try {
    const { cfg: c, capture, wl } = setup(['base1-2', 'base1-4']);
    const s = new Scheduler({ cfg: c, capture, watchlist: wl, log: quiet, once: true });
    s.start(); await s.loopDone; await s.stop();
    const st = s.status();
    assert.strictEqual(st.counts.done, 1); assert.strictEqual(st.counts.failed, 1);
    assert.match(st.recent.find(r => r.id === 'base1-2').error, /simulated failure/);
    assert.ok(capture.entries()['base1-4'].et);
  } finally { delete process.env.POCKET_TEST_FAIL; delete process.env.POCKET_TEST_BURN_MS; }
});

test('server: watchlist API adds (and queues) and removes cards; page points at the local store', async () => {
  const { cfg: c, capture, wl, dir } = setup([]);
  const s = new Scheduler({ cfg: c, capture, watchlist: wl, log: quiet });
  fs.writeFileSync(path.join(dir, 'index.html'), '<script>var CONFIG = {}, PRICES_URL = "https://raw.githubusercontent.com/x/y/prices/";</script>');
  capture.saveAll([]); // the store now has a summary
  const srv = createServer({ capture, scheduler: s, watchlist: wl, root: dir }).listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json().then(j => [r.status, j]));
  try {
    let [code, r] = await post('/watchlist', { id: 'base1-4' });
    assert.strictEqual(code, 200); assert.deepStrictEqual(r.cards, ['base1-4']);
    assert.ok(s.queue.jobs.has('ebay:base1-4'), 'a newly watched card is queued right away');
    [code, r] = await post('/watchlist', { id: 'nope-1' });
    assert.strictEqual(code, 404);
    const list = await (await fetch(base + '/watchlist')).json();
    assert.strictEqual(list.cards[0].name, 'Charizard'); assert.strictEqual(list.cards[0].queued, true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'watchlist.json'))).cards.map(x => x.id), ['base1-4']);
    r = await (await fetch(base + '/watchlist/base1-4', { method: 'DELETE' })).json();
    assert.deepStrictEqual(r.cards, []); assert.ok(!s.queue.jobs.has('ebay:base1-4'));
    const st = await (await fetch(base + '/scraper')).json();
    assert.strictEqual(st.cpu.limitPercent, 20);
    assert.match(await (await fetch(base + '/')).text(), /PRICES_URL = "\/store\/"/);
    assert.strictEqual((await fetch(base + '/store/../../etc/passwd')).status, 404);
  } finally { srv.close(); }
});
