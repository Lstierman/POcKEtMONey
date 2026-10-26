// The price store: a folder (the `prices` branch in CI) that the collector updates every run and the page reads.
//
//   meta.json                                   last run, exchange rates, per-source status
//   state.json                                  scheduling: when each card was last fetched per source
//   summary.json.gz                             one entry per card:
//       g  Cardmarket guide per product [id, trend, low, avg1, avg7, avg30, reverse trend, reverse low, variant] EUR
//       t  TCGplayer per product/finish [product id, finish, market, low, mid, high] USD
//       l  Cardmarket listing stats { "<language id>|<condition>|<flags>": [n, min, median, avg, max] } EUR, lt time, ln count
//       c  CardTrader listing stats, same keys as l; ctt time, ctn count
//       ea / es  eBay for sale / sold, raw copies only [n, min, median, avg, max] EUR; en [for sale, sold] counts; et time
//       h / hs   headline EUR and its source (trend, listings, tcg, sold)
//       b  every listing and sale by source, for sale / sold, language and grade (src/prices.js segments):
//          { "eb|S|3|PSA 10": [n, min, median, avg, max] EUR, "cm|L|1|": …, … }
//   history/<set>.json.gz                       { card id: [[hour, headline, trend, listing avg, tcgplayer, sold median] (EUR)] }
//   listings/cardmarket/<set>/<card>.json       every Cardmarket article of the card's products (PRICES.ARTICLE rows)
//   listings/ebay/<set>/<card>.json             eBay items for sale and sold items, per marketplace
//   listings/cardtrader/<set>/<card>.json       every CardTrader listing of the card (same row format as Cardmarket)
//   listings/pricecharting/<set>/<card>.json    PriceCharting graded prices and sales, captured with the extension
//   cardtrader-map.json                        CardTrader blueprint id -> card id per expansion, refreshed weekly
//   watchlist.json                             the To watch list: [[card id, added at]], edited on the site / in the scraper
//
// Every write is validated first and goes to a temp file that is renamed into place, so a crash never leaves half a file.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { SEG_KEY } = require('../../src/prices.js');
const SCHEMA = 1;

const safe = s => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
const isNum = x => x === null || (typeof x === 'number' && isFinite(x));
const isStats = s => Array.isArray(s) && s.length === 5 && s.every(isNum) && s[0] >= 1;
const isIso = s => typeof s === 'string' && !isNaN(Date.parse(s));

class Store {
  constructor(dir) { this.dir = dir; this.written = []; }
  path(rel) { return path.join(this.dir, rel); }
  exists(rel) { return fs.existsSync(this.path(rel)); }

  read(rel, fallback) {
    const f = this.path(rel);
    if (!fs.existsSync(f)) return fallback;
    let buf = fs.readFileSync(f);
    if (rel.endsWith('.gz')) buf = zlib.gunzipSync(buf);
    return JSON.parse(buf.toString('utf8'));
  }

  write(rel, obj, kind) {
    const err = validate(kind, obj);
    if (err) throw new Error(`refusing to write invalid ${kind} ${rel}: ${err}`);
    const f = this.path(rel), tmp = f + '.tmp-' + process.pid;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    let buf = Buffer.from(JSON.stringify(obj));
    if (rel.endsWith('.gz')) buf = zlib.gzipSync(buf, { level: 9 });
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, f);
    this.written.push([rel, kind]);
  }

  listingFile(kind, setId, cardId) { return `listings/${kind}/${safe(setId)}/${safe(cardId)}.json`; }
  historyFile(setId) { return `history/${safe(setId)}.json.gz`; }

  // re-reads every file written in this run and validates it again
  verify() {
    const bad = [];
    for (const [rel, kind] of this.written) {
      try { const e = validate(kind, this.read(rel)); if (e) bad.push(rel + ': ' + e); } catch (e) { bad.push(rel + ': ' + e.message); }
    }
    return bad;
  }
}

// ---------- schemas ----------
function validate(kind, o) {
  if (!o || typeof o !== 'object') return 'not an object';
  switch (kind) {
    case 'meta':
      if (o.v !== SCHEMA) return 'schema version';
      if (!isIso(o.at)) return 'at';
      if (!o.fx || o.fx.EUR !== 1 || !(o.fx.USD > 0)) return 'fx table needs EUR=1 and USD';
      return null;
    case 'state':
      if (o.v !== SCHEMA) return 'schema version';
      for (const k of ['cm', 'eb']) if (!o[k] || typeof o[k] !== 'object') return k;
      return null;
    case 'summary': {
      if (o.v !== SCHEMA || !isIso(o.at) || !o.cards) return 'header';
      if (!(o.fx && o.fx.USD > 0)) return 'fx';
      for (const id in o.cards) { const e = summaryEntryError(o.cards[id]); if (e) return id + ': ' + e; }
      return null;
    }
    case 'cmListing':
      if (o.v !== SCHEMA || !o.id || !isIso(o.at) || !Array.isArray(o.products)) return 'header';
      for (const p of o.products) {
        if (!Number.isInteger(p.cm) || !Array.isArray(p.articles)) return 'product';
        for (const a of p.articles) if (!Array.isArray(a) || a.length !== 13 || !(a[3] > 0) || !Number.isInteger(a[1]) || typeof a[2] !== 'string') return 'article ' + JSON.stringify(a).slice(0, 80);
      }
      return null;
    case 'ctListing':
      if (o.v !== SCHEMA || !o.id || !isIso(o.at) || !Array.isArray(o.blueprints)) return 'header';
      for (const b of o.blueprints) {
        if (!Number.isInteger(b.bp) || !Array.isArray(b.articles)) return 'blueprint';
        for (const a of b.articles) if (!Array.isArray(a) || a.length !== 13 || !(a[3] > 0) || !Number.isInteger(a[1]) || typeof a[2] !== 'string') return 'article ' + JSON.stringify(a).slice(0, 80);
      }
      return null;
    case 'pcListing':
      if (o.v !== SCHEMA || !o.id || !isIso(o.at) || !Array.isArray(o.g) || o.g.length !== 6 || !o.g.every(isNum) || !Array.isArray(o.sold)) return 'header';
      for (const s of o.sold) if (!Array.isArray(s) || s.length !== 5 || !/^\d{4}-\d{2}-\d{2}$/.test(s[0]) || !(s[3] > 0)) return 'sale ' + JSON.stringify(s).slice(0, 80);
      return null;
    case 'watchlist':
      if (o.v !== SCHEMA || !isIso(o.at) || !Array.isArray(o.cards)) return 'header';
      for (const w of o.cards) if (!Array.isArray(w) || typeof w[0] !== 'string' || !isIso(w[1])) return 'card ' + JSON.stringify(w).slice(0, 60);
      return null;
    case 'ctMap':
      if (o.v !== SCHEMA || !o.expansions || typeof o.expansions !== 'object') return 'header';
      return null;
    case 'ebayListing':
      if (o.v !== SCHEMA || !o.id || !isIso(o.at) || !Array.isArray(o.active) || !Array.isArray(o.sold)) return 'header';
      for (const it of o.active.concat(o.sold)) if (!Array.isArray(it) || it.length !== 13 || typeof it[1] !== 'string' || !(it[2] > 0) || typeof it[3] !== 'string') return 'item ' + JSON.stringify(it).slice(0, 80);
      return null;
    case 'history':
      for (const id in o) {
        if (!Array.isArray(o[id])) return id;
        for (const p of o[id]) if (!Array.isArray(p) || p.length !== 6 || typeof p[0] !== 'string' || !p.slice(1).every(isNum)) return id + ' point';
      }
      return null;
  }
  return 'unknown kind ' + kind;
}
function summaryEntryError(e) {
  if (e.g && !(Array.isArray(e.g) && e.g.every(r => Array.isArray(r) && r.length === 9 && r.slice(0, 8).every(isNum) && typeof r[8] === 'string'))) return 'g';
  if (e.t && !(Array.isArray(e.t) && e.t.every(r => Array.isArray(r) && r.length === 6 && typeof r[1] === 'string' && [0, 2, 3, 4, 5].every(i => isNum(r[i]))))) return 't';
  if (e.l) { for (const k in e.l) if (!/^\d+\|[A-Z]{2}\|[f1sa]*$/.test(k) || !isStats(e.l[k])) return 'l ' + k; if (!isIso(e.lt)) return 'lt'; }
  if (e.c) { for (const k in e.c) if (!/^\d+\|[A-Z?]{2}\|[f1sa]*$/.test(k) || !isStats(e.c[k])) return 'c ' + k; if (!isIso(e.ctt)) return 'ctt'; }
  for (const k of ['ea', 'es']) if (e[k] && !isStats(e[k])) return k;
  if (e.b) { if (typeof e.b !== 'object') return 'b'; for (const k in e.b) if (!SEG_KEY.test(k) || !isStats(e.b[k])) return 'b ' + k; }
  if ((e.ea || e.es) && !isIso(e.et)) return 'et';
  if (!isNum(e.h === undefined ? null : e.h)) return 'h';
  return null;
}

// ---------- history ----------
// keeps every distinct point for the last `hourlyPoints` hours, then the last point of each day for `dailyDays`
function addPoint(series, point, cfg, now) {
  const last = series[series.length - 1];
  if (last && last.slice(1).every((v, i) => v === point[i + 1])) return series; // unchanged
  if (last && last[0] === point[0]) series[series.length - 1] = point; else series.push(point);
  const hourCut = new Date(now - cfg.hourlyPoints * 3600e3).toISOString().slice(0, 13);
  const dayCut = new Date(now - cfg.dailyDays * 86400e3).toISOString().slice(0, 10);
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const p = series[i], next = series[i + 1];
    if (p[0].slice(0, 10) < dayCut) continue;
    if (p[0] < hourCut && next && next[0].slice(0, 10) === p[0].slice(0, 10)) continue; // older than the hourly window: last of the day only
    out.push(p);
  }
  return out;
}

module.exports = { Store, SCHEMA, validate, addPoint, safe };
