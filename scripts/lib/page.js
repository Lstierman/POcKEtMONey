// Builds the site from src/page.html with the card catalog already embedded in index.html, without the full build
// (npm run refresh). The helper serves it at http://127.0.0.1:8787/, so changes to the page show straight away;
// `npm run page` writes it to index.html.
const fs = require('fs'), path = require('path'), cp = require('child_process');

function pricesUrl(root) {
  if (process.env.PRICES_URL) return process.env.PRICES_URL;
  try {
    const m = /github\.com[/:]([^/]+\/[^/.]+?)(\.git)?$/.exec(cp.execSync('git remote get-url origin', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim());
    if (m) return 'https://raw.githubusercontent.com/' + m[1] + '/prices/';
  } catch (e) {}
  return 'prices/';
}

function buildPage(root) {
  const built = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const gz = /<script type="application\/octet-stream" id="catalog-gz">([^<]*)<\/script>/.exec(built);
  if (!gz) throw new Error('index.html has no embedded catalog; run npm run refresh once');
  const commit = (/var BUNDLE_COMMIT = '([^']*)'/.exec(built) || [])[1] || '';
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'prices.config.json'), 'utf8'));
  return fs.readFileSync(path.join(root, 'src/page.html'), 'utf8')
    .replace('/*__CORE__*/', () => fs.readFileSync(path.join(root, 'src/core.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'src/prices.js'), 'utf8'))
    .replace('__COMMIT__', commit).replace('__GZ__', () => gz[1])
    .replace('"__PRICES_URL__"', () => JSON.stringify(pricesUrl(root)))
    .replace('"__CONFIG__"', () => JSON.stringify({ intervalMinutes: cfg.intervalMinutes, displayCurrency: cfg.displayCurrency, headline: cfg.headline, listingCondition: cfg.listingCondition }));
}

// cached until one of the source files changes
let cache = null, key = '';
function servePage(root) {
  const k = ['index.html', 'src/page.html', 'src/core.js', 'src/prices.js', 'prices.config.json'].map(f => fs.statSync(path.join(root, f)).mtimeMs).join('|');
  if (k !== key) { cache = buildPage(root); key = k; }
  return cache;
}

if (require.main === module) {
  const root = path.join(__dirname, '../..'), page = buildPage(root);
  fs.writeFileSync(path.join(root, 'index.html'), page);
  console.log('index.html rebuilt from src/page.html (' + (page.length / 1e6).toFixed(1) + ' MB)');
}
module.exports = { buildPage, servePage, pricesUrl };
