// Downloads the English TCGdex set list and each set's card numbers, so the build can map pokemontcg.io cards to
// TCGdex cards (the page fetches live Cardmarket prices from api.tcgdex.net by TCGdex set id + card number).
// Writes <out>: { sets: [{ id, name }], cards: { <set id>: [[localId, name], ...] } }
const fs = require('fs');
const out = process.argv[2] || 'build/sources/tcgdex-en.json', API = 'https://api.tcgdex.net/v2/en/';

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try { const r = await fetch(url); if (r.ok) return r.json(); throw new Error('HTTP ' + r.status + ' ' + url); }
    catch (e) { if (attempt >= 3) throw e; await new Promise(r => setTimeout(r, 1000 * attempt)); }
  }
}

(async () => {
  const sets = (await get(API + 'sets')).map(s => ({ id: s.id, name: s.name })), cards = {};
  let i = 0;
  async function worker() {
    while (i < sets.length) {
      const s = sets[i++], d = await get(API + 'sets/' + encodeURIComponent(s.id));
      cards[s.id] = (d.cards || []).map(c => [c.localId, c.name]);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  fs.writeFileSync(out, JSON.stringify({ sets, cards }));
  console.log('tcgdex:', sets.length, 'sets,', Object.values(cards).reduce((a, c) => a + c.length, 0), 'cards');
})().catch(e => { console.error(e); process.exit(1); });
