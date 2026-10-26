// One-off scrape from the command line, with the same engine as the platform (npm start): planner, queue, CPU budget,
// worker process. Use it for a quick batch without starting the platform.
//
//   npm run scrape -- [--cards=base1-4,sv3pt5-199] [--set=sv3pt5] [--store=store] [--publish]
//
// Without --cards / --set it scrapes what the platform would: the watchlist, then missing and outdated cards
// (scrape.missingPerPlan / outdatedPerPlan in config/prices.config.json), and stops when the queue is empty.
// --publish fetches the latest "prices" branch into the store first and pushes the result back.
const path = require('path');
const { loadConfig, Watchlist, ROOT } = require('./lib/config.js');
const { Capture } = require('../platform/capture.js');
const { Scheduler } = require('../platform/scheduler/index.js');

const arg = (n, d) => { const a = process.argv.find(x => x === '--' + n || x.startsWith('--' + n + '=')); return a ? (a.includes('=') ? a.split('=').slice(1).join('=') : true) : d; };

(async () => {
  const cfg = loadConfig();
  if (arg('sites')) cfg.scrape.sites = String(arg('sites')).split(',');
  const capture = new Capture({ dir: path.resolve(ROOT, String(arg('store', 'store'))), cfg });
  if (arg('publish')) capture.pull(); else if (!capture.seed()) capture.load();
  await capture.ensureFx();
  let only = null;
  if (arg('cards')) only = String(arg('cards')).split(',').filter(id => capture.cards.has(id) || console.warn('unknown card', id));
  else if (arg('set')) only = capture.map.cards.filter(c => c[1] === arg('set')).map(c => c[0]);
  const s = new Scheduler({ cfg, capture, watchlist: new Watchlist(), once: true, only });
  process.on('SIGINT', () => { console.log('\nstopping…'); s.stop(); });
  s.start(); await s.loopDone; await s.stop();
  const r = s.status();
  console.log(`done: ${r.counts.done} cards, ${r.counts.captures} pages stored, ${r.counts.failed} failed; CPU ${r.cpu.cpuSeconds} s, waited ${r.cpu.throttledSeconds} s to stay under ${r.cpu.limitPercent}%`);
  if (arg('publish')) await capture.publish();
})().catch(e => { console.error(e.message || e); process.exit(1); });
