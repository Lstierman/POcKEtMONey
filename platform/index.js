// POcKEtMONey platform: run it on your own computer with `npm start`.
//
//   npm start -- [--port=8787] [--store=store] [--publish] [--publish-minutes=10] [--no-scrape] [--paused]
//
// It starts
//   - the local web server: the card index at http://127.0.0.1:8787/, the scraper dashboard at /dashboard, the
//     watchlist API, and the capture endpoint for the browser extension (extension/)
//   - the background scraper: it keeps the cards on your watchlist, cards with missing data and cards with outdated
//     data fresh, one card at a time, under a CPU budget (scrape.cpuLimitPercent in config/prices.config.json)
//
// --publish makes the store a worktree of the "prices" branch and pushes new results every few minutes.
// --no-scrape runs only the server (what `npm run ingest` used to be). --paused starts with the scraper paused.
const path = require('path');
const { loadConfig, Watchlist, ROOT } = require('../scripts/lib/config.js');
const { Capture } = require('./capture.js');
const { Scheduler } = require('./scheduler/index.js');
const { createServer } = require('./server.js');

const arg = (n, d) => { const a = process.argv.find(x => x === '--' + n || x.startsWith('--' + n + '=')); return a ? (a.includes('=') ? a.split('=').slice(1).join('=') : true) : d; };

(async () => {
  const cfg = loadConfig(), sc = cfg.scrape;
  const dir = path.resolve(ROOT, String(arg('store', 'store'))), port = +arg('port', process.env.PORT || 8787);
  const publish = !!arg('publish'), scrape = !arg('no-scrape') && sc.autoStart !== false;

  const capture = new Capture({ dir, cfg });
  if (publish) capture.pull(); else if (!capture.seed()) capture.load();
  try { await capture.ensureFx(); } catch (e) { console.warn('no exchange rates yet: ' + e.message); }

  const watchlist = new Watchlist();
  const scheduler = scrape ? new Scheduler({ cfg, capture, watchlist }) : null;
  if (scheduler && arg('paused')) scheduler.pause();

  const server = createServer({ capture, scheduler, watchlist, root: ROOT, publish });
  server.listen(port, '127.0.0.1', () => {
    console.log(`POcKEtMONey platform on http://127.0.0.1:${port}  (dashboard: /dashboard)  store: ${dir}${publish ? '  (publishing every ' + arg('publish-minutes', 10) + ' min)' : ''}`);
    if (scheduler) {
      console.log(`scraper: ${scheduler.sites.join(', ')}, CPU limit ${scheduler.governor.report().limitPercent}% of ${scheduler.governor.cores} cores, watchlist ${watchlist.ids().length} cards`);
      scheduler.start();
    } else console.log('scraper off');
  });
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `port ${port} is in use: is the platform already running? (or use --port=…)` : e.message); process.exit(1); });

  let publishTimer = null;
  if (publish) { publishTimer = setInterval(() => capture.publish(), (+arg('publish-minutes', 10)) * 60e3); }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return process.exit(1); stopping = true;
    console.log('\nstopping…');
    clearInterval(publishTimer); server.close();
    if (scheduler) await scheduler.stop();
    if (publish) await capture.publish();
    process.exit(0);
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
})().catch(e => { console.error(e.message || e); process.exit(1); });
