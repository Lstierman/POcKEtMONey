// Attaches PriceCharting sales to the catalog and inlines everything into index.html.
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const root = path.join(__dirname, '..');
const cat = JSON.parse(fs.readFileSync(path.join(root, 'build/catalog.json')));
const pc = JSON.parse(fs.readFileSync(path.join(root, 'build/pc_data.json')));
let n = 0;
for (const r of cat.records) for (const t of r.c) {
  const x = pc[t[0]]; if (!x) continue;
  while (t.length < 26) t.push(t.length === 22 ? (t[0].startsWith('ja:') ? 'ja' : 'en') : null);
  t[26] = x; n++;
}
const raw = Buffer.from(JSON.stringify(cat));
const gz = zlib.gzipSync(raw, { level: 9 }).toString('base64');
const page = fs.readFileSync(path.join(root, 'src/page.html'), 'utf8')
  .replace('/*__CORE__*/', () => fs.readFileSync(path.join(root, 'src/core.js'), 'utf8'))
  .replace('__COMMIT__', cat.commit).replace('__GZ__', gz);
fs.writeFileSync(path.join(root, 'index.html'), page);
console.log(`index.html written: ${(page.length / 1e6).toFixed(1)} MB, ${n} cards with sales data`);
