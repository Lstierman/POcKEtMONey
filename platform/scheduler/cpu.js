// Keeps scraping under a CPU budget (scrape.cpuLimitPercent, default 20 % of the whole machine, all cores together,
// the way Task Manager / top show "total CPU").
//
// CpuGovernor is a token bucket over CPU-seconds. The budget refills at limit × cores CPU-seconds per wall-second and
// everything the scraping spends is charged to it: the worker process, its Chrome (every Chrome process, measured
// through the DevTools protocol) and the platform's own work of writing scraped results into the store. Before every
// page load the worker asks for a permit; while the bucket is in debt the permit waits. Idle time is not saved up
// for a burst (the bucket never goes above zero), and the bucket refills at 90 % of the limit (scrape.cpuHeadroom,
// default 0.1), which leaves room for the one page that is always allowed to finish. Measured over the window the
// scraping stays under the limit.
//
// CpuMeter measures the cumulative CPU time of the scraping process tree (used inside the worker).
const os = require('os');

class CpuGovernor {
  constructor(opts = {}) {
    this.limit = (opts.limitPercent == null ? 20 : opts.limitPercent) / 100;
    this.cores = opts.cores || os.cpus().length || 1;
    this.windowMs = (opts.windowSeconds || 30) * 1000;
    this.now = opts.now || (() => Date.now());
    this.sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    this.headroom = opts.headroom == null ? 0.1 : opts.headroom;
    this.rate = this.limit * (1 - this.headroom) * this.cores / 1000; // CPU-seconds earned per wall-millisecond
    this.cap = this.rate * (opts.burstMs || 0);
    this.balance = 0; this.last = this.now();
    this.samples = []; // [time, cpu seconds, source] for the usage report
    this.waitedMs = 0; this.spent = 0;
  }
  refill() {
    const t = this.now(); this.balance = Math.min(this.cap, this.balance + (t - this.last) * this.rate); this.last = t;
  }
  spend(cpuSeconds, source) {
    if (!(cpuSeconds > 0)) return;
    this.refill(); this.balance -= cpuSeconds; this.spent += cpuSeconds;
    this.samples.push([this.now(), cpuSeconds, source || 'scrape']);
    const cut = this.now() - this.windowMs * 4; while (this.samples.length && this.samples[0][0] < cut) this.samples.shift();
  }
  debtMs() { this.refill(); return this.balance >= 0 ? 0 : Math.ceil(-this.balance / this.rate); }
  // resolves when scraping may do the next unit of work
  async acquire(signal) {
    for (;;) {
      const ms = this.debtMs(); if (!ms) return;
      if (signal && signal.aborted) throw new Error('aborted');
      this.waitedMs += ms; await this.sleep(Math.min(ms, 5000));
    }
  }
  // average share of the whole machine used by scraping over the last `ms` (default: the window), in percent
  usage(ms) {
    ms = ms || this.windowMs; const t = this.now(), from = t - ms;
    let cpu = 0; for (const [at, s] of this.samples) if (at >= from) cpu += s;
    return Math.round(cpu / (ms / 1000) / this.cores * 1000) / 10;
  }
  report() {
    return { limitPercent: Math.round(this.limit * 1000) / 10, cores: this.cores, usagePercent: this.usage(), windowSeconds: this.windowMs / 1000,
      throttledSeconds: Math.round(this.waitedMs / 100) / 10, cpuSeconds: Math.round(this.spent * 10) / 10 };
  }
}

// cumulative CPU seconds of this process + its Chrome. Chrome processes come and go (tabs, renderers), so each one's
// last reading is kept: the total never goes backwards.
class CpuMeter {
  constructor() { this.chrome = new Map(); this.cdp = null; this.mode = 'process'; this.base = null; }
  attach(cdpSession) { this.cdp = cdpSession; this.mode = 'cdp'; }
  detach() { this.cdp = null; this.mode = 'process'; }
  own() { const u = process.cpuUsage(); return (u.user + u.system) / 1e6; }
  async chromeSeconds() {
    if (!this.cdp) return 0;
    try {
      const { processInfo } = await this.cdp.send('SystemInfo.getProcessInfo');
      for (const p of processInfo) this.chrome.set(p.id, Math.max(this.chrome.get(p.id) || 0, p.cpuTime || 0));
    } catch (e) { // DevTools can't report it: fall back to the whole machine's CPU (conservative, see systemSeconds)
      this.cdp = null; this.mode = 'system';
    }
    let s = 0; for (const v of this.chrome.values()) s += v; return s;
  }
  // whole-machine busy CPU seconds; used only when Chrome's own figures are unavailable
  systemSeconds() {
    let busy = 0; for (const c of os.cpus()) { const t = c.times; busy += t.user + t.nice + t.sys + t.irq; }
    return busy / 1000;
  }
  async total() {
    if (this.mode === 'system') return this.systemSeconds();
    return this.own() + await this.chromeSeconds();
  }
}

module.exports = { CpuGovernor, CpuMeter };
