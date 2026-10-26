// Runs the scraper in the background while the platform is up.
//
//   plan    every scrape.replanMinutes (and whenever the watchlist changes) the planner picks the cards that need a visit
//           (watchlist, missing data, outdated data) and the queue is updated
//   run     one job at a time (one card on one site) goes to the worker process, which drives Chrome
//   budget  every page load waits for a permit from the CPU governor, so all scraping together stays under
//           scrape.cpuLimitPercent of the machine
//   store   results are written into the store as they arrive (in memory) and saved every scrape.saveEverySeconds;
//           that work is charged to the same CPU budget
//
// Events: 'job' (started), 'done', 'capture', 'state'.
const os = require('os'), path = require('path'), cp = require('child_process'), { EventEmitter } = require('events');
const { plan } = require('./planner.js');
const { JobQueue } = require('./queue.js');
const { CpuGovernor } = require('./cpu.js');

const WORKER = path.join(__dirname, '../scraper/worker.js');

class Scheduler extends EventEmitter {
  constructor({ cfg, capture, watchlist, log = console, once = false, only = null }) {
    super();
    this.cfg = cfg; this.sc = cfg.scrape || {}; this.capture = capture; this.watchlist = watchlist; this.log = log;
    this.once = once; this.only = only; // once: stop when the queue is empty; only: scrape just these card ids
    this.sites = this.sc.sites || ['ebay'];
    this.queue = new JobQueue({ maxAttempts: once ? 1 : this.sc.maxAttempts || 3 });
    this.governor = new CpuGovernor({ limitPercent: this.sc.cpuLimitPercent == null ? 20 : this.sc.cpuLimitPercent, windowSeconds: this.sc.cpuWindowSeconds || 30, headroom: this.sc.cpuHeadroom });
    this.worker = null; this.current = null; this.paused = false; this.stopped = false; this.pauseUntil = 0; this.pauseReason = '';
    this.dirty = new Set(); this.lastSave = Date.now(); this.recent = []; this.counts = { done: 0, failed: 0, captures: 0 };
    this.plannedAt = null; this.wakeup = null; this.idleSince = Date.now();
    if (watchlist) watchlist.on((kind, id) => {
      if (kind === 'add') this.enqueue(id, 'watchlist'); else this.sites.forEach(s => { const j = this.queue.jobs.get(s + ':' + id); if (j && !j.reasons.includes('manual')) this.queue.remove(j.key); });
    });
  }

  // ---------- planning ----------
  plan() {
    const t0 = process.cpuUsage(), now = Date.now();
    let cards = this.capture.map.cards;
    if (this.only) { const want = new Set(this.only); cards = cards.filter(c => want.has(c[0])); }
    const jobs = this.only
      ? cards.flatMap(c => this.sites.map(site => ({ key: site + ':' + c[0], site, id: c[0], band: 0, score: 1, reasons: ['manual'] })))
      : plan({ cards, entries: this.capture.entries(), state: this.capture.state, watch: this.watchlist ? this.watchlist.ids() : [], cfg: this.cfg, now, sites: this.sites });
    this.queue.sync(jobs); this.plannedAt = new Date(now).toISOString();
    this.charge(t0);
    const by = r => jobs.filter(j => j.reasons.includes(r)).length;
    this.log.log(`scrape plan: ${this.queue.size} queued (watchlist ${by('watchlist')}, missing ${by('missing')}, outdated ${by('outdated')})`);
    this.wake(); this.emit('state');
    return jobs;
  }
  enqueue(id, reason = 'manual') {
    if (!this.capture.cards.has(id)) return false;
    for (const site of this.sites) this.queue.upsert({ key: site + ':' + id, site, id, band: 0, score: reason === 'manual' ? 1e9 : 1e6, reasons: [reason] });
    this.wake(); this.emit('state'); return true;
  }

  // ---------- control ----------
  start() {
    this.plan();
    if (!this.once) { this.planTimer = setInterval(() => this.plan(), (this.sc.replanMinutes || 15) * 60e3); this.planTimer.unref(); }
    this.loopDone = this.loop();
    return this;
  }
  pause(reason, ms) {
    if (ms) { this.pauseUntil = Date.now() + ms; this.pauseReason = reason || 'paused'; } else { this.paused = true; this.pauseReason = reason || 'paused by you'; }
    this.emit('state');
  }
  resume() { this.paused = false; this.pauseUntil = 0; this.pauseReason = ''; this.wake(); this.emit('state'); }
  async stop() {
    this.stopped = true; clearInterval(this.planTimer); this.killWorker(); this.wake();
    if (this.loopDone) await this.loopDone;
    this.flush(true);
  }
  wake() { if (this.wakeup) { const w = this.wakeup; this.wakeup = null; w(); } }
  sleep(ms) { return new Promise(r => { const t = setTimeout(() => { this.wakeup = null; r(); }, ms); this.wakeup = () => { clearTimeout(t); r(); }; }); }

  // ---------- the loop ----------
  async loop() {
    while (!this.stopped) {
      this.flush();
      const now = Date.now();
      if (this.paused || now < this.pauseUntil) { await this.sleep(this.paused ? 60e3 : Math.min(this.pauseUntil - now, 60e3)); continue; }
      if (this.pauseUntil) { this.pauseUntil = 0; this.pauseReason = ''; }
      const job = this.queue.next();
      if (!job) {
        if (this.once && this.queue.size === 0) break;
        if (this.worker && Date.now() - this.idleSince > (this.sc.idleCloseMinutes || 5) * 60e3) { this.log.log('scraper idle: closing Chrome'); this.killWorker(); }
        await this.sleep(Math.min(this.queue.nextReadyIn(), 30e3)); continue;
      }
      await this.run(job);
      this.idleSince = Date.now();
    }
    this.flush(true);
  }

  async run(job) {
    const card = this.capture.cards.get(job.id);
    if (!card) return;
    this.current = Object.assign({ startedAt: new Date().toISOString() }, job); this.emit('job', this.current); this.emit('state');
    this.log.log(`scrape ${job.site} ${job.id} ${card[2]} [${job.reasons.join(', ')}]`);
    let res;
    try { res = await this.send(Object.assign({}, job, { card })); }
    catch (e) { res = { ok: false, error: e.message, restart: true }; }
    const at = new Date().toISOString();
    if (res.ok) { this.queue.succeeded(job.key); this.counts.done++; }
    else if (res.human && this.once) { this.counts.failed++; this.stopped = true; this.log.warn('stopping: ' + res.error); } // nobody completed the check
    else if (res.human) {
      const mins = this.sc.humanCheckBackoffMinutes || 30;
      this.queue.requeue(job); this.pause(`${job.site} wants a person to complete a check; trying again in ${mins} min`, mins * 60e3);
      this.log.warn('scraper paused: ' + res.error);
    } else if (res.restart) { this.queue.requeue(job); this.killWorker(); if (!this.stopped) await this.sleep(5000); }
    else { const f = this.queue.failed(job, res.error); this.counts.failed++; this.log.warn(`  failed (${f.n}/${this.queue.maxAttempts}): ${res.error}`); }
    this.recent.unshift({ key: job.key, id: job.id, name: card[2], site: job.site, reasons: job.reasons, ok: !!res.ok, error: res.error, at, captures: res.captures || 0 });
    this.recent.length = Math.min(this.recent.length, 30);
    this.current = null; this.emit('done', this.recent[0]); this.emit('state');
  }

  // ---------- worker process ----------
  spawn() {
    const w = cp.fork(WORKER, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    try { os.setPriority(w.pid, os.constants.priority.PRIORITY_LOW); } catch (e) {}
    w.send({ t: 'config', cfg: this.cfg });
    w.on('message', m => this.onMessage(m, w));
    w.on('exit', code => { if (this.worker === w) { this.worker = null; if (this.pendingJob) { const p = this.pendingJob; this.pendingJob = null; p.reject(new Error('scraper process ended (' + code + ')')); } } });
    return (this.worker = w);
  }
  killWorker() {
    const w = this.worker; if (!w) return; this.worker = null;
    if (this.pendingJob) { const p = this.pendingJob; this.pendingJob = null; p.reject(new Error('scraper stopped')); }
    try { w.send({ t: 'stop' }); } catch (e) {}
    setTimeout(() => { try { w.kill(); } catch (e) {} }, 15000).unref();
  }
  send(job) {
    const w = this.worker || this.spawn();
    return new Promise((resolve, reject) => { this.pendingJob = { key: job.key, resolve, reject, captures: 0 }; w.send({ t: 'job', job }); });
  }
  async onMessage(m, w) {
    if (m.cpu) this.governor.spend(m.cpu, 'scraper');
    const p = this.pendingJob;
    if (m.t === 'permit') {
      try { await this.governor.acquire(); } catch (e) { return; }
      if (this.worker === w && w.connected) w.send({ t: 'permit' });
    } else if (m.t === 'capture' && p && m.key === p.key) {
      const t0 = process.cpuUsage(), id = m.key.slice(m.key.indexOf(':') + 1);
      try { await this.capture.ensureFx(); const r = this.capture.record(Object.assign({ source: 'scrape' }, m.m), id); this.dirty.add(id); p.captures++; this.counts.captures++; this.log.log('  ' + r); }
      catch (e) { this.log.warn('  could not store result: ' + e.message); }
      this.charge(t0); this.emit('capture', { id, site: m.m.site });
    } else if (m.t === 'done' && p && m.key === p.key) {
      this.pendingJob = null; p.resolve(Object.assign({ captures: p.captures }, m));
    } else if (m.t === 'human') { this.pauseReason = m.host + ' is waiting for you to complete a check in the Chrome window'; this.emit('state'); }
  }

  // ---------- saving ----------
  flush(force) {
    if (!this.dirty.size || (!force && Date.now() - this.lastSave < (this.sc.saveEverySeconds || 60) * 1000)) return;
    const t0 = process.cpuUsage(), ids = [...this.dirty]; this.dirty.clear(); this.lastSave = Date.now();
    try { this.capture.saveAll(ids); this.log.log(`scrape results saved for ${ids.length} card(s)`); }
    catch (e) { this.log.error('saving scrape results failed: ' + e.message); ids.forEach(id => this.dirty.add(id)); }
    this.charge(t0);
  }
  charge(t0) { const u = process.cpuUsage(t0); this.governor.spend((u.user + u.system) / 1e6, 'platform'); }

  status() {
    return {
      running: !this.stopped, paused: this.paused || Date.now() < this.pauseUntil, pauseReason: this.pauseReason || null,
      resumesAt: this.pauseUntil > Date.now() ? new Date(this.pauseUntil).toISOString() : null,
      sites: this.sites, cpu: this.governor.report(), plannedAt: this.plannedAt, current: this.current,
      queued: this.queue.size, queue: this.queue.list(50), recent: this.recent, counts: this.counts, unsaved: this.dirty.size
    };
  }
}

module.exports = { Scheduler };
