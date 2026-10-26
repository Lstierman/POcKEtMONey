# POcKEtMONey

Every English and Japanese Pokémon TCG card in one page that works offline, searches in about a millisecond, and shows what each card is worth.

- **33,641 cards**: 20,635 English (Base Set through *30th Celebration*) and 13,006 Japanese prints, each language as its own card with its own prices.
- **Prices**: Cardmarket (EUR, per variant, 6 weeks of history), TCGplayer (USD, per variant, 2 weeks of history), and PriceCharting graded prices with recent sold listings (linked) for the cards in `data/pricecharting/`.
- **Hourly prices**: a collector refreshes Cardmarket (price guide and every individual listing, averaged per language and condition), TCGplayer and eBay (for sale and sold) every hour into a separate price store. The cards on screen are also checked live from the browser.
- **Price data label** on every card, from *No data* to *Complete* (all six methods), and **one currency** for everything: euro or dollar, converted at the ECB rate.
- **Watchlist and background scraper**: run the platform on your own computer (`npm start`) and it keeps the cards you watch, cards with missing data and cards with outdated data fresh, one card at a time, never using more than 20 % of the CPU.
- **Search**: names in English, Japanese, German, French, Spanish, Italian and Portuguese (`glurak` finds Charizard), typo-tolerant (`charzard`), plus field queries.

## Quick start

**Just browse:** open `index.html` in a browser, or the GitHub Pages site. It works offline; card images load when online.

**Run the platform** (Node 22 and Google Chrome):

```
npm install
npm start
```

Then open <http://127.0.0.1:8787>. Press **☆ Watch** on any card you want followed; the scraper picks it up right away. The dashboard at <http://127.0.0.1:8787/dashboard> shows what it is doing, the queue and its CPU use. Details: [docs/platform.md](docs/platform.md).

**Hourly prices on GitHub:** add your API keys as repository secrets and the *Collect prices* workflow keeps the `prices` branch up to date. See [docs/prices.md](docs/prices.md).

## Search syntax

| Query | Finds |
|---|---|
| `charizard` | name, attack, ability, set or artist starting with the word |
| `artist:"mitsuhiro arita"` | cards by an illustrator |
| `set:base1`, `set:151` | a set by id, code or name |
| `hp>=200`, `dex:25`, `no:4` | numbers |
| `price>50`, `eur<5`, `usd>=100` | price, in the selected currency |
| `lang:ja pikachu` | Japanese prints only |
| `has:sales` | cards with graded prices and sold listings |
| `is:watched` | cards on your watchlist |
| `has:price`, `-has:price` | cards with / without any known price |
| `data>=4` | cards with at least 4 of the 6 price-data methods |
| `-supporter` | excludes a word |

## Project layout

```
index.html                  the built app (open this; GitHub Pages serves it)
src/                        the app's source: page.html (UI), core.js (storage format, index, search), prices.js (shared price maths)
platform/                   the local platform (npm start): web server, watchlist, background scraper
  scheduler/                planner (watchlist / missing / outdated), job queue, CPU governor
  scraper/                  the scraper process, Chrome driver, one module per site
scripts/
  collect.js                hourly price collector (APIs), run by the Collect prices workflow
  scrape.js                 one-off scrape batch from the command line (same engine as the platform)
  build/                    builds index.html: fetch sources, build catalog, merge sales, assemble
  lib/                      shared: config and watchlist, price store (schemas, atomic writes), entries, API clients
config/
  prices.config.json        intervals, budgets, marketplaces, scraper settings
  watchlist.json            the cards you follow
data/                       card map, TCGdex cache, PriceCharting graded prices and sales
extension/                  browser extension: save the Cardmarket / eBay / PriceCharting page you are looking at
test/                       collector and platform tests with mocked APIs and a fake scraper site (npm test)
docs/                       platform.md, prices.md, architecture.md
.github/workflows/          collect.yml (hourly prices), refresh.yml (daily rebuild), test.yml (tests on every push)
```

## Commands

| | |
|---|---|
| `npm start` | the platform: server on :8787 + background scraper ([docs/platform.md](docs/platform.md)) |
| `npm run scrape -- --cards=base1-4` | scrape a few cards now and exit |
| `npm run collect` | run the hourly API collector into `store/` |
| `npm test` | all tests |
| `npm run refresh` | fetch every source and rebuild `index.html` ([docs/architecture.md](docs/architecture.md)) |
| `npm run assemble` | re-render `index.html` after editing `src/` |

## Data sources

| Data | Source |
|---|---|
| English cards | [PokemonTCG/pokemon-tcg-data](https://github.com/PokemonTCG/pokemon-tcg-data) |
| Japanese cards, Japanese Cardmarket prices | [ZyzyThePizi/pokemon-price-data](https://github.com/ZyzyThePizi/pokemon-price-data) (TCGdex + Cardmarket price guide) |
| Cardmarket prices and history (English cards) | [kazant/pokedex-scanner-data](https://github.com/kazant/pokedex-scanner-data) |
| TCGplayer prices, translated names | [psvanzyl/pokemon-tcg](https://github.com/psvanzyl/pokemon-tcg) (tcgcsv.com) |
| TCGplayer price history | [Tbaker-maker/Catchem-data](https://github.com/Tbaker-maker/Catchem-data) |
| Graded prices, sold listings | [PriceCharting](https://www.pricecharting.com) (collected per card; graded prices refreshed via the API when a token is set) |
| Live Cardmarket prices, card mapping | [TCGdex API](https://tcgdex.dev) |
| Cardmarket price guide (hourly), Cardmarket listings | [Cardmarket](https://www.cardmarket.com) public price guide; API 2.0 with your app keys |
| TCGplayer prices (hourly) | [tcgcsv.com](https://tcgcsv.com) |
| eBay for sale / sold | [eBay Buy APIs](https://developer.ebay.com/api-docs/buy/static/buy-landing.html) (Browse, Marketplace Insights) with your keys |
| Exchange rates | [ECB reference rates](https://www.ecb.europa.eu) via [frankfurter.dev](https://frankfurter.dev) |
| Live TCGplayer prices | [Pokémon TCG API](https://pokemontcg.io) |

Cardmarket's public price guide pools all European languages into one figure, so a German or French copy can sell above or below the euro price shown. Japanese prints are separate Cardmarket products with their own prices. Card data and images belong to their respective owners; Pokémon is a trademark of Nintendo, Creatures and GAME FREAK.
