// CardTrader API v2 (api.cardtrader.com): marketplace listings per card with language, condition, reverse holo,
// seller and price. Needs CARDTRADER_TOKEN (CardTrader account -> Settings -> API, free).
//   expansions           GET /expansions
//   cards (blueprints)   GET /blueprints/export?expansion_id=…   (carry Cardmarket ids -> mapped to our cards)
//   listings             GET /marketplace/products?expansion_id=…  ({ "<blueprint id>": [product, …] })
const API = 'https://api.cardtrader.com/api/v2';

// CardTrader -> Cardmarket-style language ids and conditions, so both marketplaces share src/prices.js statistics
const LANG = { en: 1, fr: 2, de: 3, es: 4, it: 5, 'zh-cn': 6, zh: 6, jp: 7, ja: 7, pt: 8, ru: 9, kr: 10, ko: 10, 'zh-tw': 11, nl: 12, pl: 13 };
const COND = { 'mint': 'MT', 'near mint': 'NM', 'slightly played': 'EX', 'moderately played': 'GD', 'played': 'LP', 'heavily played': 'PL', 'poor': 'PO' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

class CardTrader {
  constructor(token, budget) { this.token = token; this.budget = budget; this.used = 0; this.lastAt = 0; }
  async get(path) {
    if (this.used >= this.budget) throw Object.assign(new Error('request budget used'), { budget: true });
    const wait = this.lastAt + 250 - Date.now(); if (wait > 0) await sleep(wait); // well under the documented rate limits
    this.used++; this.lastAt = Date.now();
    for (let attempt = 1; ; attempt++) {
      const r = await fetch(API + path, { headers: { Authorization: 'Bearer ' + this.token, Accept: 'application/json' } });
      if (r.ok) return r.json();
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error('CardTrader rejected the token (HTTP ' + r.status + ')'), { fatal: true });
      if (r.status === 429 && attempt < 3) { await sleep(5000 * attempt); continue; }
      if (r.status >= 500 && attempt < 3) { await sleep(1500 * attempt); continue; }
      throw new Error('HTTP ' + r.status + ' ' + path.split('?')[0]);
    }
  }
  async pokemonExpansions() {
    const games = await this.get('/games');
    const list = Array.isArray(games) ? games : games.array || [];
    const g = list.find(x => /pok[eé]mon/i.test(x.name || x.display_name || ''));
    if (!g) throw new Error('CardTrader has no Pokémon game in /games');
    return { game: g.id, expansions: (await this.get('/expansions')).filter(e => e.game_id === g.id) };
  }
  blueprints(expansionId) { return this.get('/blueprints/export?expansion_id=' + expansionId); }
  products(expansionId) { return this.get('/marketplace/products?expansion_id=' + expansionId); }
}

// one CardTrader product -> PRICES.ARTICLE row [id, language, condition, price EUR, quantity, reverse, signed, 1st ed., altered, country, seller, comment, blueprint]
function productRow(p, toEur) {
  const ph = p.properties_hash || {}, price = p.price || {};
  const cents = price.cents != null ? price.cents : p.price_cents, cur = (price.currency || p.price_currency || 'EUR').toUpperCase();
  const eur = cents > 0 ? toEur(cents / 100, cur) : null;
  if (!(eur > 0)) return null;
  const lang = LANG[String(ph.pokemon_language || ph.language || '').toLowerCase()] || 0;
  const cond = COND[String(ph.condition || '').toLowerCase()] || '??';
  const user = p.user || {};
  return [p.id, lang, cond, Math.round(eur * 100) / 100, p.quantity || 1, ph.pokemon_reverse || ph.reverse ? 1 : 0, ph.signed ? 1 : 0,
    ph.first_edition || ph.pokemon_first_edition ? 1 : 0, ph.altered ? 1 : 0, user.country_code || '', user.username || '', String(p.description || '').slice(0, 120), p.blueprint_id];
}

// blueprints -> { blueprint id: our card id }, through Cardmarket ids first, TCGplayer ids second
function mapBlueprints(blueprints, byCm, byTcg) {
  const out = {};
  for (const b of blueprints || []) {
    let id = null;
    for (const cm of b.card_market_ids || (b.card_market_id ? [b.card_market_id] : [])) if (byCm.has(cm)) { id = byCm.get(cm); break; }
    if (!id && b.tcg_player_id && byTcg.has(b.tcg_player_id)) id = byTcg.get(b.tcg_player_id);
    if (id) out[b.id] = id;
  }
  return out;
}

module.exports = { CardTrader, productRow, mapBlueprints, LANG, COND };
