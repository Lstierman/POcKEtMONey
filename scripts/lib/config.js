// Shared configuration: config/prices.config.json (intervals, budgets, scraper settings) and config/watchlist.json
// (the cards you follow). Used by the collector, the build, the platform and the scraper CLI.
const fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '../..');
const CONFIG_FILE = path.join(ROOT, 'config/prices.config.json');
const WATCHLIST_FILE = path.join(ROOT, 'config/watchlist.json');

function loadConfig(file = CONFIG_FILE) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (process.env.PRICE_INTERVAL_MINUTES) cfg.intervalMinutes = +process.env.PRICE_INTERVAL_MINUTES;
  cfg.schedule = cfg.schedule || {};
  cfg.scrape = cfg.scrape || {};
  return cfg;
}

// The watchlist file: { "cards": [{ "id": "base1-4", "added": "2026-10-26", "note": "…" }] }.
// Plain strings are accepted too. Writes go to a temp file that is renamed into place.
class Watchlist {
  constructor(file = WATCHLIST_FILE) { this.file = file; this.items = []; this.listeners = []; this.load(); }
  load() {
    let raw = { cards: [] };
    try { if (fs.existsSync(this.file)) raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) { console.warn('watchlist unreadable (' + e.message + '), starting empty'); }
    const list = Array.isArray(raw) ? raw : raw.cards || [];
    const seen = new Set();
    this.items = list.map(x => (typeof x === 'string' ? { id: x } : x)).filter(x => x && x.id && !seen.has(x.id) && seen.add(x.id));
    return this;
  }
  ids() { return this.items.map(x => x.id); }
  has(id) { return this.items.some(x => x.id === id); }
  add(id, note) {
    if (this.has(id)) return false;
    this.items.push(Object.assign({ id, added: new Date().toISOString().slice(0, 10) }, note ? { note } : {}));
    this.save(); this.emit('add', id); return true;
  }
  remove(id) {
    const n = this.items.length; this.items = this.items.filter(x => x.id !== id);
    if (this.items.length === n) return false;
    this.save(); this.emit('remove', id); return true;
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ cards: this.items }, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
  on(fn) { this.listeners.push(fn); }
  emit(kind, id) { for (const fn of this.listeners) try { fn(kind, id); } catch (e) { console.warn(e); } }
}

// every card id the collector and the scraper should treat as "always refresh": the watchlist plus the legacy
// schedule.always list in prices.config.json
function alwaysIds(cfg, watchlist) {
  return [...new Set([...(cfg.schedule && cfg.schedule.always) || [], ...(watchlist || new Watchlist()).ids()])];
}

module.exports = { ROOT, CONFIG_FILE, WATCHLIST_FILE, loadConfig, Watchlist, alwaysIds };
