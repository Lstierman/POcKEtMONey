// eBay search result pages (for sale and sold) -> the collector's eBay item rows, using the extension's parser
// (extension/parsers.js), so the scraper and the browser extension read pages the same way.
//
// A site module exports run(ctx, job): it loads pages with ctx.visit (each load waits for the CPU budget first) and
// hands every result to ctx.capture in the same format the extension sends, so the platform stores both the same way.
// One capture per marketplace and list (for sale / sold): an interrupted job keeps what it already read.
const path = require('path');
const PARSERS = path.join(__dirname, '../../../extension/parsers.js');
const { parsePrice, parseDate } = require(PARSERS);
const EBQ = require('../../../scripts/lib/ebay.js');

const HOST = { EBAY_US: 'www.ebay.com', EBAY_GB: 'www.ebay.co.uk', EBAY_DE: 'www.ebay.de', EBAY_FR: 'www.ebay.fr', EBAY_IT: 'www.ebay.it', EBAY_ES: 'www.ebay.es', EBAY_AT: 'www.ebay.at' };
const CATEGORY = '183454'; // CCG Individual Cards
function searchUrl(mp, q, sold) {
  return 'https://' + (HOST[mp] || HOST.EBAY_US) + '/sch/i.html?_nkw=' + encodeURIComponent(q).replace(/%20/g, '+') + '&_sacat=' + CATEGORY + '&_ipg=60' + (sold ? '&LH_Sold=1&LH_Complete=1' : '');
}

async function page(ctx, mp, q, sold) {
  const p = await ctx.visit(searchUrl(mp, q, sold), 'li[data-listingid], .srp-results');
  await p.addScriptTag({ path: PARSERS });
  return (await p.evaluate(() => window.PTCG_PARSE.ebay(document, location))).items;
}

async function run(ctx, job) {
  const sc = ctx.cfg.scrape || {}, card = job.card;
  for (const mp of sc.ebayMarketplaces || ctx.cfg.ebay.marketplaces) {
    const q = EBQ.query(card, mp);
    for (const sold of sc.ebaySold === false ? [false] : [false, true]) {
      const items = EBQ.relevant(card, await page(ctx, mp, q, sold));
      ctx.capture({ site: 'ebay', data: { mp, sold, query: q, items, found: items.length } });
    }
  }
}

module.exports = { run, searchUrl, parsePrice, parseSoldDate: parseDate };
