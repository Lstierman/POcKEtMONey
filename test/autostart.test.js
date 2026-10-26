// The scraper's CPU budget (scraper-extension/governor.js), the helper seeding the To watch list from
// config/watchlist.json, and the extension starting a run by itself while the helper runs.
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), vm = require('vm');
const { createGovernor } = require('../scraper-extension/governor.js');
const root = path.join(__dirname, '..');

test('CPU governor: scraping is held back to the limit, over any window', async () => {
  let t = 0; const g = createGovernor({ limitPercent: 20, cores: 4, now: () => t });
  // pages costing 300 ms of CPU each, read as fast as the governor allows
  for (let i = 0; i < 300; i++) { const wait = g.debtMs(); g.waited(wait); t += wait; g.spend(300); t += 50; }
  const avg = g.spentMs / t / 4 * 100;
  assert.ok(avg <= 20, 'average ' + avg.toFixed(2) + '%');
  assert.ok(avg > 17, 'and the budget is used: ' + avg.toFixed(2) + '%');
  for (const w of [5e3, 10e3, 30e3]) assert.ok(g.usage(w) <= 20, `last ${w / 1000} s: ${g.usage(w)}%`);
  // idle time is not saved up: after an hour of nothing, a burst still waits from the second page on
  t += 3600e3; g.spend(2000);
  assert.ok(g.debtMs() > 0);
  // a lower limit takes effect straight away
  g.setLimit(5); t += 1e6; g.spend(1000); assert.ok(Math.abs(g.debtMs() - 1000 / (0.05 * 0.9 * 4)) < 2);
});

function startHelper(dir, extra) {
  const port = 18900 + Math.floor(Math.random() * 90);
  const proc = cp.spawn(process.execPath, ['--require', path.join(__dirname, 'mock-fetch.js'), path.join(root, 'scripts/ingest-server.js'), '--store=' + dir, '--port=' + port,
    '--journal=' + path.join(dir, '..', path.basename(dir) + '-journal.jsonl')].concat(extra || []),
  { env: Object.assign({}, process.env, { MOCK_LOG: path.join(dir, '..', path.basename(dir) + '-req.json') }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout.on('data', d => { out += d; });
  const ready = new Promise((ok, no) => { proc.stdout.on('data', () => /open the site at/.test(out) && ok()); proc.on('exit', c => no(new Error('helper exited ' + c))); setTimeout(() => no(new Error('helper did not start')), 15000); });
  return { proc, ready, url: 'http://127.0.0.1:' + port, log: () => out };
}

test('helper: config/watchlist.json fills the To watch list once; /sites tells the extension to start and its CPU limit', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ptcg-seed-')), dir = path.join(base, 'store'), wl = path.join(base, 'watchlist.json');
  fs.writeFileSync(wl, JSON.stringify({ cards: [{ id: 'base1-2' }, 'base1-15', { id: 'not-a-card' }] }));
  let h = startHelper(dir, ['--watchlist=' + wl]); t.after(() => h.proc.kill()); await h.ready;
  const get = p => fetch(h.url + p).then(r => r.json());
  let watch = (await get('/watch')).cards.map(c => c.id);
  assert.ok(watch.includes('base1-2') && watch.includes('base1-15') && !watch.includes('not-a-card'), watch.join(' '));
  assert.match(h.log(), /starts scraping by itself/);
  const sites = await get('/sites');
  assert.strictEqual(sites.auto.on, true); assert.ok(sites.auto.session);
  assert.strictEqual(sites.cpu.limitPercent, 20);
  const q = await get('/queue?site=ebay&n=1');
  assert.strictEqual(q.pace.cpuLimit, 20); assert.ok(q.pace.cpuOverhead > 1);
  // removing a seeded card on the site keeps it removed after a restart
  await fetch(h.url + '/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remove: ['base1-2'] }) });
  h.proc.kill(); await new Promise(r => h.proc.once('exit', r));
  h = startHelper(dir, ['--watchlist=' + wl]); await h.ready;
  watch = (await get('/watch')).cards.map(c => c.id);
  assert.ok(!watch.includes('base1-2') && watch.includes('base1-15'), watch.join(' '));
  assert.notStrictEqual((await get('/sites')).auto.session, sites.auto.session, 'a restarted helper is a new session');
});

// the real background.js in a VM: alarms, storage and the helper simulated
function extension(helperSites) {
  const alarms = [], started = [];
  const ctx = {
    console, URL, URLSearchParams, Map, Set, JSON, Math, Date, Promise, Object, Array, String, Error, AbortController,
    setTimeout: fn => setImmediate(fn), clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    importScripts: () => { ctx.PTCG_MATCH = require('../scraper-extension/match.js'); ctx.PTCG_GOVERNOR = require('../scraper-extension/governor.js'); },
    navigator: { hardwareConcurrency: 8 },
    fetch: async u => {
      if (/\/sites$/.test(u)) return { status: 200, json: async () => helperSites() };
      if (/\/queue/.test(u)) { started.push(u); return { status: 200, json: async () => ({ items: [], pace: { cpuLimit: 20 } }) }; }
      return { status: 200, json: async () => ({ ok: true }) };
    },
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} }, notifications: { create() {}, clear() {} },
      runtime: { onMessage: { addListener() {} }, getPlatformInfo() {}, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
      alarms: { create: (n, o) => alarms.push([n, o]), onAlarm: { addListener: fn => { ctx.fire = fn; } } },
      windows: { create: async () => ({ id: 1, tabs: [{ id: 2 }] }), get: async () => ({ id: 1 }), update: async () => {}, remove: async () => {} },
      tabs: { get: async id => ({ id, status: 'complete' }), create: async () => ({ id: 3 }), update: async () => {} },
      scripting: { executeScript: async () => [{ result: null }] }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'scraper-extension/background.js'), 'utf8'), ctx);
  const settle = async () => { for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r)); };
  return { ctx, alarms, started, settle, job: () => vm.runInContext('job', ctx), tick: async () => { ctx.fire({ name: 'autostart' }); await settle(); } };
}

test('extension: starts by itself while the helper runs, stays stopped after Stop until the helper restarts', async () => {
  let session = 'S1', on = true;
  const ext = extension(() => ({ watch: 3, auto: { on, session }, cpu: { limitPercent: 20 }, sites: {} }));
  await ext.settle();
  assert.strictEqual(JSON.stringify(ext.alarms[0]), JSON.stringify(['autostart', { periodInMinutes: 1 }]));
  await ext.tick();
  let job = ext.job();
  assert.ok(job && job.auto && job.session === 'S1', 'started by itself');
  assert.strictEqual(job.cpu.limit, 20); assert.strictEqual(job.cpu.cores, 8);
  assert.ok(ext.started.length >= 1, 'asked the helper for cards');
  assert.strictEqual(job.status, 'done'); // the simulated helper has nothing to scrape

  // finished the catalog a moment ago: no new run straight away
  const before = ext.started.length; await ext.tick();
  assert.strictEqual(ext.started.length, before);

  // Stop in this helper session: stays stopped
  vm.runInContext("job.status = 'done'; job.endedAt = new Date(0).toISOString();", ext.ctx);
  await vm.runInContext('stop()', ext.ctx); await ext.tick();
  assert.strictEqual(ext.job().stop, true, 'not restarted after Stop');
  // the helper restarts (new session): scraping starts again
  session = 'S2'; await ext.tick();
  job = ext.job(); assert.ok(!job.stop && job.session === 'S2');
  // autoStart off in the config: nothing starts
  on = false; vm.runInContext("job.status = 'stopped'; job.stop = true; job.stoppedSession = 'old';", ext.ctx);
  const n = ext.started.length; await ext.tick(); assert.strictEqual(ext.started.length, n);
});
