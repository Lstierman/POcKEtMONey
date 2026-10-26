// The scraper process. The platform forks it at low priority (so the Chrome it starts is low priority too) and sends it
// one job at a time: { t: 'job', job: { key, site, card } }. It answers with
//   { t: 'permit', cpu }          before every page load: "may I?" plus the CPU seconds used since the last report;
//                                 the platform replies { t: 'permit' } once the CPU budget allows it
//   { t: 'capture', key, m }      a result, in the extension's capture format
//   { t: 'done', key, ok, error, human }
//   { t: 'cpu', cpu }             CPU seconds used, every second while working
//   { t: 'human', host }          a site is showing a check that needs a person
// The browser opens on the first job; the platform ends this process when the queue has been empty a while.
//
// scrape.browser = "none" runs site modules without Chrome (tests); POCKET_SITES_DIR points at other site modules.
const os = require('os'), path = require('path');
const { CpuMeter } = require('../scheduler/cpu.js');
const { Browser } = require('./browser.js');

let cfg = null, browser = null, meter = new CpuMeter(), lastCpu = null, lastMode = null, permitWaiter = null, busy = false;
const SITES = process.env.POCKET_SITES_DIR || path.join(__dirname, 'sites');
const send = m => { if (process.connected) process.send(m); };
try { os.setPriority(os.constants.priority.PRIORITY_LOW); } catch (e) {}

let chain = Promise.resolve(0); // readings one at a time, so two callers never count the same CPU twice
function cpuDelta() { return (chain = chain.then(readDelta, readDelta)); }
async function readDelta() {
  const total = await meter.total();
  if (lastCpu == null || meter.mode !== lastMode) { lastCpu = total; lastMode = meter.mode; return 0; }
  const d = Math.max(0, total - lastCpu); lastCpu = total; return d;
}

async function ensureBrowser() {
  const sc = cfg.scrape || {};
  if (sc.browser === 'none' || browser) return;
  browser = await new Browser({ gapMs: (sc.secondsBetweenPages || 7) * 1000, headless: sc.headless, blockResources: sc.blockResources,
    cpuThrottle: sc.rendererCpuThrottle, onHuman: host => send({ t: 'human', host }) }).open();
  try { meter.attach(await browser.cdp()); } catch (e) { meter.mode = 'system'; }
  lastCpu = null; await cpuDelta();
}

function permit() {
  return new Promise(async ok => { permitWaiter = ok; send({ t: 'permit', cpu: await cpuDelta() }); });
}

async function runJob(job) {
  busy = true;
  try {
    await ensureBrowser();
    const site = require(path.join(SITES, job.site + '.js'));
    const ctx = {
      cfg,
      visit: async (url, ready) => { await permit(); return browser.visit(url, ready); },
      permit, // for site modules that do work without loading pages
      capture: m => send({ t: 'capture', key: job.key, m })
    };
    await site.run(ctx, job);
    send({ t: 'done', key: job.key, ok: true, cpu: await cpuDelta() });
  } catch (e) {
    send({ t: 'done', key: job.key, ok: false, error: e.message, human: !!e.human, cpu: await cpuDelta().catch(() => 0) });
    if (/Target closed|Session closed|Protocol error|browser has disconnected/i.test(e.message)) { await browser?.close(); browser = null; meter.detach(); }
  } finally { busy = false; }
}

setInterval(async () => { if (busy) send({ t: 'cpu', cpu: await cpuDelta() }); }, 1000).unref();

process.on('message', m => {
  if (m.t === 'config') cfg = m.cfg;
  else if (m.t === 'job') runJob(m.job);
  else if (m.t === 'permit' && permitWaiter) { const f = permitWaiter; permitWaiter = null; f(); }
  else if (m.t === 'stop') (browser ? browser.close() : Promise.resolve()).finally(() => process.exit(0));
});
process.on('disconnect', () => { (browser ? browser.close() : Promise.resolve()).finally(() => process.exit(0)); });
