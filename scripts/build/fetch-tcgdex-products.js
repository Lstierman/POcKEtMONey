// Fills in Cardmarket and TCGplayer product ids for English cards the open sources don't map, from TCGdex
// (api.tcgdex.net card -> variants_detailed[].thirdParty). The ids feed the hourly price guide, Cardmarket listings,
// the evidence links and the language bundles.
// Cached in data/tcgdex-products.json, so only cards never looked up (or empty for 30+ days) are requested.
// Run after build-catalog; if anything new was found it rebuilds the catalog so the ids are used.
const fs = require('fs'), path = require('path'), zlib = require('zlib'), cp = require('child_process');
const root = path.join(__dirname, '../..'), cacheF = path.join(root, 'data/tcgdex-products.json');
const S = process.argv[2] || 'build/sources';
const map = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'data/card-map.json.gz')))).cards;
const sets = new Map(JSON.parse(fs.readFileSync(path.join(root, 'build/catalog.json'))).setList.map(s => [s.id, s]));
const cache = fs.existsSync(cacheF) ? JSON.parse(fs.readFileSync(cacheF)) : {};
const now = Date.now(), MONTH = 30 * 86400e3;

const todo = map.filter(c => {
  if (c[5] === 'ja' || c[6].length) return false;
  const s = sets.get(c[1]); if (!s || !s.tx || (s.tn && s.tn[c[0]] === '')) return false;
  const k = cache[c[0]];
  return !k || (!k.cm.length && now - Date.parse(k.at) > MONTH);
});
const TYPE = { normal: 'Normal', holo: 'Holo', reverse: 'Reverse holo' };

async function get(url) {
  for (let a = 1; ; a++) {
    try { const r = await fetch(url, { headers: { 'User-Agent': 'POcKEtMONey-catalog/1.0' } }); if (r.status === 404) return null; if (r.ok) return r.json(); throw new Error('HTTP ' + r.status); }
    catch (e) { if (a >= 3) throw e; await new Promise(r => setTimeout(r, 1000 * a)); }
  }
}

(async () => {
  console.log('tcgdex products:', todo.length, 'cards to look up,', Object.keys(cache).length, 'cached');
  let i = 0, found = 0, failed = 0;
  async function worker() {
    while (i < todo.length) {
      const c = todo[i++], s = sets.get(c[1]), num = s.tn && c[0] in s.tn ? s.tn[c[0]] : c[3];
      try {
        const d = await get('https://api.tcgdex.net/v2/en/sets/' + encodeURIComponent(s.tx) + '/' + encodeURIComponent(num));
        const cm = [], tcg = [];
        for (const v of (d && d.variants_detailed) || []) {
          const tp = v.thirdParty || {}, label = (v.stamp && v.stamp.includes('1st-edition') ? '1st Edition ' : '') + (TYPE[v.type] || v.type || 'Normal') + (v.subtype ? ' ' + String(v.subtype).replace(/-/g, ' ') : '');
          if (tp.cardmarket && !cm.some(x => x[0] === tp.cardmarket)) cm.push([tp.cardmarket, label]);
          if (tp.tcgplayer && !tcg.includes(tp.tcgplayer)) tcg.push(tp.tcgplayer);
        }
        cache[c[0]] = { at: new Date().toISOString(), cm, tcg };
        if (cm.length) found++;
      } catch (e) { failed++; }
      if (i % 500 === 0) process.stdout.write(i + ' ');
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  const sorted = Object.fromEntries(Object.keys(cache).sort().map(k => [k, cache[k]]));
  fs.writeFileSync(cacheF, JSON.stringify(sorted, null, 0).replace(/},"/g, '},\n"') + '\n');
  console.log(`\ntcgdex products: ${found} new cards with Cardmarket ids, ${failed} failed`);
  if (found) {
    console.log('rebuilding the catalog with the new ids');
    cp.execFileSync(process.execPath, [path.join(__dirname, 'build-catalog.js'), S, path.join(root, 'build/catalog.json')], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
})().catch(e => { console.error(e); process.exit(1); });
