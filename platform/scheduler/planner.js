// Decides which cards the scraper should visit, and in what order. Pure: no I/O, so it is easy to test.
//
// A job is one card on one site. A card gets a job for three reasons:
//   watchlist  the card is in config/watchlist.json; refreshed every scrape.staleHours.watchlist hours, always first
//   missing    the store has no data from that site for the card yet (most valuable cards first, then newest)
//   outdated   the data is older than the card's tier allows: hot (≥ schedule.hotEur), warm (≥ warmEur) or cold
//
// "When was this card last seen on a site" takes the newest of: the summary entry's own timestamp for that source
// (written by the hourly API collector, the extension and the scraper alike) and the scraper's own stamps in
// state.json, so a card the API collector refreshed an hour ago is not scraped again.

const FIELD = { // summary entry field holding the time of the site's last data
  ebay: e => e.et,
  cardmarket: e => e.lt,
  pricecharting: e => e.pc && e.pc.at
};
const API_STAMPS = { ebay: 'eb', cardmarket: 'cm' }; // state.json stamps written by scripts/collect.js

function lastSeen(site, id, entry, state) {
  const times = [entry && FIELD[site] ? FIELD[site](entry) : null];
  for (const k of ['scrape', 'capture']) times.push(state && state[k] && state[k][site] && state[k][site][id]);
  if (API_STAMPS[site] && state && state[API_STAMPS[site]]) times.push(state[API_STAMPS[site]][id]);
  let best = 0;
  for (const t of times) { const ms = t ? Date.parse(t) : NaN; if (ms > best) best = ms; }
  return best || null;
}

function tierOf(value, watched, schedule) {
  if (watched) return 'watchlist';
  if (value >= (schedule.hotEur || 50)) return 'hot';
  if (value >= (schedule.warmEur || 5)) return 'warm';
  return 'cold';
}

const DEFAULT_STALE = { watchlist: 6, hot: 12, warm: 72, cold: 336 };
function staleHours(sc) {
  const s = sc.staleHours;
  if (typeof s === 'number') return { watchlist: Math.min(s, DEFAULT_STALE.watchlist), hot: s, warm: s * 6, cold: s * 28 }; // old single-number config
  return Object.assign({}, DEFAULT_STALE, s || {});
}

// cards: card-map tuples [id, set, name, …] in catalog order (oldest set first)
// entries: summary.cards; state: state.json; watch: watched card ids
// returns jobs sorted best first: { key, site, id, band, score, reasons, tier, lastAt }
function plan({ cards, entries, state, watch, cfg, now, sites }) {
  const sc = cfg.scrape || {}, schedule = cfg.schedule || {}, stale = staleHours(sc);
  const watched = new Set(watch || []);
  sites = sites || sc.sites || ['ebay'];
  const out = [], missing = [], outdated = [];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i], id = c[0], e = entries[id], value = (e && e.h) || 0, w = watched.has(id);
    const tier = tierOf(value, w, schedule), period = stale[tier] * 3600e3;
    for (const site of sites) {
      const last = lastSeen(site, id, e, state);
      const job = { key: site + ':' + id, site, id, tier, lastAt: last ? new Date(last).toISOString() : null, reasons: [] };
      if (w) job.reasons.push('watchlist');
      if (!last) {
        job.reasons.push('missing');
        job.score = 2 * (1 + Math.log1p(value)) + i / cards.length; // valuable first, then newer prints
        (w ? out : missing).push(job);
      } else if (now - last >= period) {
        const overdue = Math.min((now - last) / period, 10);
        job.reasons.push('outdated');
        job.score = overdue * (1 + Math.log1p(value));
        (w ? out : outdated).push(job);
      }
    }
  }
  const best = (a, b) => b.score - a.score;
  out.forEach(j => { j.band = 0; });
  missing.sort(best).splice(sc.missingPerPlan == null ? 20 : sc.missingPerPlan);
  outdated.sort(best).splice(sc.outdatedPerPlan == null ? 40 : sc.outdatedPerPlan);
  for (const j of missing.concat(outdated)) { j.band = 1; out.push(j); }
  return out.sort((a, b) => a.band - b.band || b.score - a.score);
}

module.exports = { plan, lastSeen, tierOf, staleHours };
