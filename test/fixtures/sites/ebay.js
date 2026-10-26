// A stand-in for platform/scraper/sites/ebay.js in the tests: no Chrome, no network. Every "page" asks for a CPU
// permit, burns CPU for BURN_MS (like a page load would) and returns one fake item.
const BURN_MS = +process.env.POCKET_TEST_BURN_MS || 150;
function burn(ms) { const end = Date.now() + ms; let x = 0; while (Date.now() < end) x += Math.sqrt(x + 1); return x; } // busy for ms of wall time

async function run(ctx, job) {
  if (process.env.POCKET_TEST_FAIL === job.card[0]) throw new Error('simulated failure');
  for (const mp of ['EBAY_DE', 'EBAY_US']) for (const sold of [false, true]) {
    await ctx.permit();
    burn(BURN_MS);
    const item = [mp + (sold ? 's' : 'a') + job.card[0], job.card[2] + ' ' + job.card[3], 10 + (sold ? 1 : 0), 'EUR', 'Used', mp, '2026-10-25', '', 'https://www.ebay.de/itm/1', sold ? 'SOLD' : 'FIXED_PRICE', 1, 'DE', 0];
    ctx.capture({ site: 'ebay', data: { mp, sold, query: job.card[2], items: [item], found: 1 } });
  }
}
module.exports = { run };
