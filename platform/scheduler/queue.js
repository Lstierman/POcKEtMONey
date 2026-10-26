// Priority queue of scrape jobs (one card on one site each). Keyed by "<site>:<card id>", so a card is never queued
// twice; re-planning updates its priority and reasons instead. Band 0 (watchlist, manual "scrape now") always runs
// before band 1 (missing / outdated); within a band the higher score goes first.
// Failed jobs come back after an exponential backoff (15 min, 30 min, 1 h…) and are dropped after maxAttempts.

class JobQueue {
  constructor(opts = {}) {
    this.jobs = new Map(); this.failures = new Map();
    this.maxAttempts = opts.maxAttempts || 3; this.backoffMs = opts.backoffMs || 15 * 60e3;
  }
  get size() { return this.jobs.size; }

  upsert(job) {
    const old = this.jobs.get(job.key);
    if (old) {
      old.band = Math.min(old.band, job.band); old.score = Math.max(old.score, job.score);
      old.reasons = [...new Set(old.reasons.concat(job.reasons))];
      if (job.lastAt !== undefined) old.lastAt = job.lastAt;
      return old;
    }
    const j = Object.assign({ queuedAt: new Date().toISOString() }, job);
    this.jobs.set(j.key, j); return j;
  }

  // replaces the planned jobs with a new plan; jobs added by hand ("manual") stay until they ran
  sync(planned) {
    const keep = new Set(planned.map(j => j.key));
    for (const [k, j] of this.jobs) if (!keep.has(k) && !j.reasons.includes('manual')) this.jobs.delete(k);
    for (const j of planned) {
      const f = this.failures.get(j.key);
      if (f && f.n >= this.maxAttempts) continue; // given up on until it succeeds some other way
      const cur = this.jobs.get(j.key);
      if (!cur) { this.upsert(j); continue; }
      const manual = cur.reasons.includes('manual');
      cur.band = manual ? 0 : j.band; cur.score = j.score; cur.lastAt = j.lastAt;
      cur.reasons = manual ? [...new Set(['manual'].concat(j.reasons))] : j.reasons.slice();
    }
  }

  // the best job that is not waiting out a backoff; removes it from the queue
  next(now = Date.now()) {
    let best = null;
    for (const j of this.jobs.values()) {
      const f = this.failures.get(j.key);
      if (f && f.notBefore > now) continue;
      if (!best || j.band < best.band || (j.band === best.band && j.score > best.score)) best = j;
    }
    if (best) this.jobs.delete(best.key);
    return best;
  }

  // ms until the earliest backed-off job may run (Infinity when none waits)
  nextReadyIn(now = Date.now()) {
    let t = Infinity;
    for (const j of this.jobs.values()) { const f = this.failures.get(j.key); t = Math.min(t, f && f.notBefore > now ? f.notBefore - now : 0); }
    return t;
  }

  succeeded(key) { this.failures.delete(key); }
  failed(job, error, now = Date.now()) {
    const f = this.failures.get(job.key) || { n: 0 };
    f.n++; f.error = String(error); f.notBefore = now + this.backoffMs * 2 ** (f.n - 1);
    this.failures.set(job.key, f);
    if (f.n < this.maxAttempts) this.upsert(job);
    return f;
  }
  // a job that could not start (site check, worker restart): put back without counting an attempt
  requeue(job) { this.upsert(job); }
  remove(key) { return this.jobs.delete(key); }
  list(n) {
    return [...this.jobs.values()].sort((a, b) => a.band - b.band || b.score - a.score).slice(0, n || Infinity)
      .map(j => Object.assign({}, j, this.failures.has(j.key) ? { attempts: this.failures.get(j.key).n, retryAt: new Date(this.failures.get(j.key).notBefore).toISOString() } : {}));
  }
}

module.exports = { JobQueue };
