// CPU budget for the scraper: all scraping together stays under scrape.cpuLimitPercent (default 20 %) of the whole
// machine, all cores counted (the "total CPU" Task Manager shows).
//
// A token bucket over CPU time. It refills at limit × cores CPU-milliseconds per wall-millisecond, minus a headroom
// (default 10 %) for the page that is already being read. Every unit of scraping work is charged to it:
//   - reading a fetched page (parsing the HTML and the prices) is timed in the page itself, times an overhead factor
//     for the work around it (downloading, decompressing, garbage collection; scrape.cpuOverhead, default 1.5)
//   - a page loaded normally in a tab (the first page per site, a human check, "load more" clicks) is rendered by
//     Chrome, which the extension can't time: it is charged a fixed cost (scrape.cpuPageLoadMs, default 1500 ms)
// Before each page the scraper asks for a permit; while the bucket is in debt the permit waits. Idle time is not saved
// up for a burst, so averaged over any window the scraping stays at or under the limit.
// Loaded by background.js (importScripts) and by the tests (require).
(function (root) {
  'use strict';
  function createGovernor(opts) {
    opts = opts || {};
    const now = opts.now || (() => Date.now());
    const g = {
      limitPercent: opts.limitPercent == null ? 20 : +opts.limitPercent,
      cores: Math.max(1, opts.cores || 1),
      headroom: opts.headroom == null ? 0.1 : +opts.headroom,
      windowMs: opts.windowMs || 30e3,
      balance: 0, last: now(), samples: [], spentMs: 0, waitedMs: 0
    };
    const rate = () => g.limitPercent / 100 * (1 - g.headroom) * g.cores; // CPU-ms earned per wall-ms
    g.refill = function () { const t = now(); g.balance = Math.min(0, g.balance + (t - g.last) * rate()); g.last = t; };
    g.spend = function (ms) {
      if (!(ms > 0)) return;
      g.refill(); g.balance -= ms; g.spentMs += ms;
      const t = now(); g.samples.push([t, ms]);
      while (g.samples.length && g.samples[0][0] < t - g.windowMs * 4) g.samples.shift();
    };
    // ms to wait before the next unit of work may start (0: go)
    g.debtMs = function () { g.refill(); return g.balance >= 0 || !rate() ? 0 : Math.ceil(-g.balance / rate()); };
    g.waited = function (ms) { g.waitedMs += ms; };
    // share of the whole machine used by scraping over the last `ms`, in percent
    g.usage = function (ms) {
      ms = ms || g.windowMs; const t = now(); let cpu = 0;
      for (const s of g.samples) if (s[0] >= t - ms) cpu += s[1];
      return Math.round(cpu / ms / g.cores * 1000) / 10;
    };
    g.report = function () {
      return { limit: g.limitPercent, usage: g.usage(), cores: g.cores, waitedS: Math.round(g.waitedMs / 1000), cpuS: Math.round(g.spentMs / 100) / 10 };
    };
    g.setLimit = function (p) { if (p > 0 && p <= 100) g.limitPercent = +p; };
    return g;
  }
  root.PTCG_GOVERNOR = { createGovernor };
  if (typeof module !== 'undefined' && module.exports) module.exports = { createGovernor };
})(typeof self !== 'undefined' ? self : this);
