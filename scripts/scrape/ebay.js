// eBay search result pages (for sale and sold) -> the collector's eBay item rows, using the extension's parser
// (extension/parsers.js), so the scraper and the browser extension read pages the same way.
const path = require('path');
const PARSERS = path.join(__dirname, '../../extension/parsers.js');
const { parsePrice, parseDate } = require(PARSERS);

const HOST = { EBAY_US: 'www.ebay.com', EBAY_GB: 'www.ebay.co.uk', EBAY_DE: 'www.ebay.de', EBAY_FR: 'www.ebay.fr', EBAY_IT: 'www.ebay.it', EBAY_ES: 'www.ebay.es', EBAY_AT: 'www.ebay.at' };
const CATEGORY = '183454'; // CCG Individual Cards
function searchUrl(mp, q, sold) {
  return 'https://' + (HOST[mp] || HOST.EBAY_US) + '/sch/i.html?_nkw=' + encodeURIComponent(q).replace(/%20/g, '+') + '&_sacat=' + CATEGORY + '&_ipg=60' + (sold ? '&LH_Sold=1&LH_Complete=1' : '');
}

async function scrape(browser, mp, q, sold) {
  const p = await browser.visit(searchUrl(mp, q, sold), 'li[data-listingid], .srp-results');
  await p.addScriptTag({ path: PARSERS });
  return (await p.evaluate(() => window.PTCG_PARSE.ebay(document, location))).items;
}

module.exports = { scrape, searchUrl, parsePrice, parseSoldDate: parseDate };
