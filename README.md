# POcKEtMONey

Every English and Japanese Pokémon TCG card in one page that works offline, searches in about a millisecond, and shows what each card is worth.

- **33,641 cards**: 20,635 English (Base Set through *30th Celebration*) and 13,006 Japanese prints, each language as its own card with its own prices.
- **Prices**: Cardmarket (EUR, per variant, 6 weeks of history), TCGplayer (USD, per variant, 2 weeks of history), and PriceCharting graded prices with recent sold listings (linked) for the cards in `data/pricecharting/`.
- **Hourly prices**: a collector refreshes Cardmarket (price guide and every individual listing, averaged per language and condition), TCGplayer and eBay (for sale and sold) every hour into a separate price store. The cards on screen are also checked live from the browser.
- **Price data label** on every card, from *No data* to *Complete* (all six methods), and **one currency** for everything: euro or dollar, converted at the ECB rate.
- **Search**: names in English, Japanese, German, French, Spanish, Italian and Portuguese (`glurak` finds Charizard), typo-tolerant (`charzard`), plus field queries.

Open `index.html` in a browser. Served from GitHub Pages, card images load as well.

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
| `has:price`, `-has:price` | cards with / without any known price |
| `data>=4` | cards with at least 4 of the 6 price-data methods |
| `-supporter` | excludes a word |

## Prices

Every card's price comes from three layers. For each source the newest copy wins:

1. **Snapshot** built into `index.html` by the daily build (works offline).
2. **Price store**: the `prices` branch, refreshed by the hourly collector (`scripts/collect.js`, workflow *Collect prices*). The page reads it on open and again every refresh interval.
3. **Live checks** from the browser for the cards on screen: Cardmarket via `api.tcgdex.net`, TCGplayer via `api.pokemontcg.io`.

### What the collector fetches

| Source | Data | Needs |
|---|---|---|
| ECB exchange rates (frankfurter.dev) | EUR per USD, GBP, … | nothing |
| Cardmarket price guide | trend, low, 1/7/30-day averages per product, all cards | nothing |
| TCGplayer (tcgcsv.com) | market, low, mid, high per finish | nothing |
| **Cardmarket listings** (API 2.0) | **every article**: language, condition, price, quantity, reverse holo / 1st edition / signed / altered, seller country, comment | Cardmarket app keys |
| **eBay for sale** (Browse API) | items per marketplace (DE, US, GB, FR by default), local-language search, other card numbers dropped, graded copies flagged | eBay developer keys |
| **eBay sold** (Marketplace Insights API) | sold items with date and price | eBay must grant this API to your app |

Cardmarket listings are grouped per **language × condition × extras**, with count, min, median, trimmed average (the outer 10% dropped) and max for each group. The page shows them as a matrix, plus a calculator: pick any language and condition (exact, or "or better", optionally reverse holo) and it computes the average from the stored listings.

Paid and limited APIs are spent within a per-run budget (`prices.config.json`). Valuable cards (≥ €50 by default) and the `always` list are refreshed every run, cards ≥ €5 daily, the rest weekly. The most overdue and most valuable cards go first.

### Setting it up

1. Repository → Settings → Secrets and variables → Actions → add the secrets you have:
   - `CARDMARKET_APP_TOKEN`, `CARDMARKET_APP_SECRET`, `CARDMARKET_ACCESS_TOKEN`, `CARDMARKET_ACCESS_SECRET` (a *dedicated app* in your Cardmarket account; Cardmarket only gives API access to some accounts)
   - `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` (developer.ebay.com, production keyset)
   - `PRICECHARTING_TOKEN` (optional, graded prices in the daily build)
2. Actions → *Collect prices* → *Run workflow* (tick *force*) for the first run. After that it runs every hour.
3. The repository must be public so the page can read `raw.githubusercontent.com/<you>/<repo>/prices/…`. To host the store elsewhere, build with `PRICES_URL=https://…/`.

Without keys the collector still runs the free sources, and the page explains for each card why a section is empty.

### Interval

- `intervalMinutes` in `prices.config.json` (default 60), or the repository variable `PRICE_INTERVAL_MINUTES`. The workflow starts hourly and skips a run when the last one is younger than the interval. For intervals under an hour, also change the `cron` line in `.github/workflows/collect.yml`.
- In the page, ⚙ Settings sets how often this browser re-reads the store and re-checks cards on screen (default: the config value).

### Storage

The `prices` branch is one commit, replaced every run. History lives inside the files, so git doesn't grow:

```
meta.json                              last run, exchange rates, status of every source
state.json                             when each card was last fetched, per source
summary.json.gz                        one entry per card (guide, TCGplayer, listing stats, eBay stats, headline)
history/<set>.json.gz                  headline, trend, listing average, TCGplayer, sold median (EUR): hourly for 72 h, then daily for 180 days
listings/cardmarket/<set>/<card>.json  every Cardmarket listing of the card
listings/ebay/<set>/<card>.json        eBay items for sale and sold
```

Every file is validated against its schema before it is written. It goes to a temporary file that is renamed into place, so a crash never leaves half a file. After the run every file is read back and validated again; if anything fails, the workflow stops before publishing. `npm test` covers the OAuth signature (RFC 5849 vector), listing statistics, eBay filtering and currency conversion, the store's refusal of bad data, history compaction, and full collector runs against mocked APIs.

### Every price: graded, language, for sale and sold

Every listing and sale, from every marketplace, is classified the same way (`src/prices.js`) and kept apart along four lines:

| Split | How |
|---|---|
| **Raw or graded** | The title (eBay, PriceCharting) or seller comment (Cardmarket, CardTrader) is read for a grading company and grade: `PSA 10`, `BGS 9.5`, `BGS 10 Black Label`, `CGC 10 Pristine`, also SGC, ACE, TAG, PCA and others. "PSA 10 candidate" or "ready to grade" stays raw; eBay's own Graded / Ungraded condition is used too. A grade without a named company is `Graded 9`. |
| **Language** | Cardmarket and CardTrader state it per listing. On eBay the title is read (“japanese”, “deutsch”, “VF”…), then the card name it uses (Glurak: German), then the language the site was searched in. PriceCharting sales are in the print's language. |
| **For sale or sold** | Current listings (Cardmarket, CardTrader, eBay) and completed sales (eBay, PriceCharting) are never mixed. |
| **Source** | Each figure keeps its marketplace. |

The store keeps this per card as `b` in `summary.json.gz`: `"eb|S|3|PSA 10": [n, min, median, avg, max]` (source, L for sale / S sold, Cardmarket language id, grade; EUR). Headline figures (the Cardmarket listing average, eBay `ea` / `es`) use raw copies in the print's own language only, so a German copy or a slab never moves an English card's price.

A card's details open with **Every price**: one table across all its prints, raw copies per language first, then every grade, with the median for sale and sold, how many, and which marketplaces. The Cardmarket price guide (European languages pooled) and TCGplayer (English, raw) can't be split this way and stay in their own sections.

### To watch and the scraper

For the data the APIs don't give (every Cardmarket listing, eBay for sale and sold, PriceCharting graded prices), the **scraper extension** (`scraper-extension/`) collects them in your own Chrome, where the "are you a robot" checks see a normal browser.

**Setup, once:** in the project folder run `npm run helper` (leave it running), then Chrome → `chrome://extensions` → *Developer mode* → *Load unpacked* → pick `scraper-extension/`.

**To watch:** the cards you care about most. Add them with **☆ Watch** on a card on the site, or by searching in the extension's popup; remove them the same way. The site's filter rail has *★ Only cards I watch*. The list is kept in the price store (`watchlist.json`), so it is pushed with the prices and shows on every device. Changes made on the site while the helper isn't running wait in that browser and are sent the next time it is. The hourly collector also refreshes watched cards on every run.

**Scrape all:** one button. Each site works through:
1. the To watch list: every watched card not scraped on that site in the last hour (`scrape.watchStaleHours`);
2. then the whole catalog: cards that have never been scraped there first, most valuable first; after that the oldest, once older than a week (`scrape.staleHours`).

It keeps going until the catalog is done or you press *Stop*. Every card is saved the moment it is finished, and the helper pushes to the `prices` branch every 15 minutes, when a run ends, and when you stop it with Ctrl+C. A stop, a crash or a closed browser loses at most the card in progress; the next *Scrape all* continues where it stopped. Cards a site has no match for are tried again after a week (watched cards after a day), cards that failed after 12 hours. The popup shows, per site, how much of the catalog has prices and how many watched cards are up to date. *Advanced* has a field to scrape only some cards or sets (for testing) and the slow every-single-Cardmarket-offer mode.

**How it stays fast:** one tab per site in a separate window loads the first page normally (any check or login happens there, once). Every other page is fetched from inside that tab, with your cookies, and read without rendering: about a second per page, two at a time per site (`scrape.secondsBetweenRequests`, `scrape.parallelRequests`). The three sites run at the same time. A "too many requests" answer halves the pace; a check or block loads the page in the tab for you to complete, with a notification.

**Cardmarket: every language and condition.** One request shows a product's cheapest offers (about 50), which is all of them for most cards. When there are more, the product is fetched per language (`?language=`, all 13 Cardmarket languages), and a language that is still cut off per condition (`?minCondition=` Mint … Played, "this or better"), so every language × condition has its cheapest offers. A crowded card like Base Set Charizard takes about 25 requests, under a minute. *Every single Cardmarket offer (slow)* also opens the cut-off languages and presses "load more" to the end (`scrape.cardmarket.maxLoadMore`, 40). The listing file records every view and whether it was complete (`coverage`).

How it finds each card: eBay uses the same localized searches as the API collector and keeps only items naming the card and its number. Cardmarket opens product pages it has seen before, else the pokemontcg.io redirect (English prints), else a search for the product's exact name within its expansion (from Cardmarket's public product catalog), else a name search; a page only counts for a card when its product id is one of that card's Cardmarket ids. PriceCharting uses the known page, else a search, and accepts a page only when its URL has the card's name, number and language. Found page addresses are remembered in `state.json`. The helper re-reads `data/card-map.json.gz` when the daily build changes it, so added cards are queued and removed cards are forgotten.

### Evidence

Every price section in a card's details ends with an **Evidence** line of links to where its figures come from:

| Section | Links |
|---|---|
| Cardmarket price guide | the card's Cardmarket product page (English prints, through pokemontcg.io's redirect; Japanese prints get a Cardmarket search), the TCGdex API response for a live check, Cardmarket's price guide file with the product ids for the hourly figure, the snapshot's source repository |
| Cardmarket listings | the product page, the stored file with every listing as collected, and per listing the seller's Cardmarket page |
| TCGplayer | the TCGplayer product page, each finish linked to its product, the pokemontcg.io API response or tcgcsv.com |
| eBay for sale / Sold | the exact search the collector ran on each eBay site (sold searches filtered to completed sales), the stored item file, each item's own listing, the PriceCharting sales page |
| Graded prices | the PriceCharting page |
| Headline | which section it came from, and the ECB exchange rate used for conversion |

Each section also holds its own history graphs: the snapshot history of that source plus the price-store history of that column (Cardmarket trend, listing average, TCGplayer market, sold median).

### Language bundles

The same card printed in different languages is bundled: one tile per card (badge `EN · JP`), with an **All languages** table in the details. The table lists every print with its price, data label and Cardmarket link, plus Cardmarket listings per language across all prints together. Prints are matched at build time when they share Cardmarket's *metacard* (its id for one card's text across all products, from Cardmarket's public product catalog) and the illustrator. For Pokémon without a Cardmarket id, the match uses Pokédex numbers, name suffix (ex, V, GX…), HP, types and illustrator. Groups with two prints in one language are split by rarity class, so a regular card and its full art stay apart. Same-art reprints are included.

5,753 bundles cover 12,580 prints. Cardmarket ids for about 5,800 English cards come from TCGdex (`scripts/fetch-tcgdex-products.js`, cached in `data/tcgdex-products.json`, so only new cards are looked up). The checkbox under *Language* switches bundling off.

### Price data label

Each card carries a label counting which of six methods have data for it: Cardmarket price guide · Cardmarket listings · TCGplayer · eBay for sale · sold listings (eBay or PriceCharting) · graded prices. The tiers run **No data → Thin → Fair → Good → Strong → Rich → Complete**. The label is a chip on the card face, a checklist in the card details, a filter in the side rail, and the `data>=N` query.

### Currency

The € / $ switch in the header (also in ⚙ Settings) shows **every** price in one currency. Dollar figures are converted to euro and back at the ECB reference rate; hover a dotted figure to see the original. The headline price is chosen in this order: Cardmarket trend → Cardmarket listing average (card's language, chosen condition or better) → TCGplayer → eBay sold median → PriceCharting ungraded. Settings can put the listing average first.

## How the data is stored and searched

- **Compact storage.** Each card is a positional tuple with no repeated field names, and image URLs are shortened to a two-letter host code. The whole catalog (about 22 MB of JSON) ships gzip-compressed and base64-inlined in `index.html` (about 6 MB), so the page needs no network request to open.
- **Inverted index.** On load the page builds a sorted term dictionary with one `Uint32Array` posting list per term. A prefix lookup is a binary search plus a contiguous scan; results are cached in a small LRU.
- **Bitmap filters.** Every filter value (type, set, rarity, language, legality…) is a bitmap with one bit per card. Combining filters is a word-by-word AND over about 1,050 32-bit words, and the live counts on the filter chips are popcounts.
- **Typo fallback.** A word with no prefix match falls back to a bounded edit-distance scan of the dictionary.

## Project layout

```
index.html                     the built app (open this)
src/core.js                    storage format, index and search engine
src/page.html                  UI template (core + data are inlined at build time)
scripts/fetch-sources.sh       shallow-clones the open data sources
scripts/fetch-tcgdex-sets.js   TCGdex set and card numbers, for mapping cards to the live API
scripts/fetch-tcgdex-products.js Cardmarket ids TCGdex knows for English cards (cached, incremental)
scripts/fetch-pricecharting.js refreshes graded prices from the PriceCharting API (optional token)
scripts/collect.js             hourly price collector (writes the price store)
scripts/ingest-server.js       the scraper's local helper (npm run helper): To watch list, what to scrape next, stores and pushes
scripts/lib/scrape-plan.js     which cards and URLs the scraper visits next (To watch first, then the catalog)
scraper-extension/             scraper extension: collects prices in your own Chrome
scripts/lib/                   store (schemas, atomic writes, history), public sources, Cardmarket and eBay clients
src/prices.js                  listing statistics, currency conversion, data-coverage label (page + collector)
prices.config.json             interval, budgets, marketplaces, schedule
data/card-map.json.gz          card -> Cardmarket / TCGplayer product ids and names (built daily, read by the collector)
data/tcgdex-products.json      cache of TCGdex card -> Cardmarket / TCGplayer ids
test/                          collector and scraper-helper tests with mocked APIs (npm test)
.github/workflows/collect.yml  runs the collector every hour and publishes the prices branch
scripts/build-catalog.js       builds the compact catalog with prices and history
scripts/merge-pricecharting.js normalises the PriceCharting sales files
scripts/assemble.js            inlines everything into index.html
data/pricecharting/            graded prices and sold listings, one card per line
data/pricecharting-live.json   graded prices refreshed by the API fetcher (written by the workflow)
.github/workflows/refresh.yml  rebuilds index.html every day
```

## Build

Requires Node 22 and git.

```
npm run refresh   # fetch sources + graded prices + build index.html
npm run build     # rebuild from already-fetched sources
```

The **Refresh catalog and prices** workflow runs the same thing daily and commits the new `index.html`. To refresh graded prices too, add a PriceCharting API token as the repository secret `PRICECHARTING_TOKEN`. Turn on GitHub Pages (Settings → Pages → Deploy from branch → `main`, `/ (root)`) to get a public link.

## Adding cards to the sales data

Append one line per card to a file in `data/pricecharting/` (`.jsonl`):

```json
{"id":"base1-4","pc":"https://www.pricecharting.com/game/pokemon-base-set/charizard-4","prices":{"ungraded":471.92,"grade7":823.79,"grade8":1266.11,"grade9":3451.01,"grade9_5":8540,"psa10":18162.69},"sold":[["2026-10-22","PSA 8","1999 Base Set Unlimited #4 Charizard PSA 8",1300,"https://www.ebay.com/itm/307229523055"]]}
```

`id` is the pokemontcg.io card id (Japanese cards: `ja:<TCGdex id>`, e.g. `ja:SM9-105`).

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
