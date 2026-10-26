<!-- How prices get into POcKEtMONey: the hourly collector, the price store, and how the page shows them. -->
# Prices

Every card's price comes from three layers. For each source the newest copy wins:

1. **Snapshot** built into `index.html` by the daily build (works offline).
2. **Price store**: the `prices` branch, refreshed by the hourly collector (`scripts/collect.js`, workflow *Collect prices*). The page reads it on open and again every refresh interval.
3. **Live checks** from the browser for the cards on screen: Cardmarket via `api.tcgdex.net`, TCGplayer via `api.pokemontcg.io`.

## What the collector fetches

| Source | Data | Needs |
|---|---|---|
| ECB exchange rates (frankfurter.dev) | EUR per USD, GBP, … | nothing |
| Cardmarket price guide | trend, low, 1/7/30-day averages per product, all cards | nothing |
| TCGplayer (tcgcsv.com) | market, low, mid, high per finish | nothing |
| **Cardmarket listings** (API 2.0) | **every article**: language, condition, price, quantity, reverse holo / 1st edition / signed / altered, seller country, comment | Cardmarket app keys |
| **eBay for sale** (Browse API) | items per marketplace (DE, US, GB, FR by default), local-language search, other card numbers dropped, graded copies flagged | eBay developer keys |
| **eBay sold** (Marketplace Insights API) | sold items with date and price | eBay must grant this API to your app |

Cardmarket listings are grouped per **language × condition × extras**, with count, min, median, trimmed average (the outer 10% dropped) and max for each group. The page shows them as a matrix, plus a calculator: pick any language and condition (exact, or "or better", optionally reverse holo) and it computes the average from the stored listings.

Paid and limited APIs are spent within a per-run budget (`config/prices.config.json`). Valuable cards (≥ €50 by default) and the cards on the watchlist (`config/watchlist.json`) are refreshed every run, cards ≥ €5 daily, the rest weekly. The most overdue and most valuable cards go first.

## Setting it up

1. Repository → Settings → Secrets and variables → Actions → add the secrets you have:
   - `CARDMARKET_APP_TOKEN`, `CARDMARKET_APP_SECRET`, `CARDMARKET_ACCESS_TOKEN`, `CARDMARKET_ACCESS_SECRET` (a *dedicated app* in your Cardmarket account; Cardmarket only gives API access to some accounts)
   - `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` (developer.ebay.com, production keyset)
   - `PRICECHARTING_TOKEN` (optional, graded prices in the daily build)
2. Actions → *Collect prices* → *Run workflow* (tick *force*) for the first run. After that it runs every hour.
3. The repository must be public so the page can read `raw.githubusercontent.com/<you>/<repo>/prices/…`. To host the store elsewhere, build with `PRICES_URL=https://…/`.

Without keys the collector still runs the free sources, and the page explains for each card why a section is empty.

## Interval

- `intervalMinutes` in `config/prices.config.json` (default 60), or the repository variable `PRICE_INTERVAL_MINUTES`. The workflow starts hourly and skips a run when the last one is younger than the interval. For intervals under an hour, also change the `cron` line in `.github/workflows/collect.yml`.
- In the page, ⚙ Settings sets how often this browser re-reads the store and re-checks cards on screen (default: the config value).

## Storage

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

## Evidence

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

## Language bundles

The same card printed in different languages is bundled: one tile per card (badge `EN · JP`), with an **All languages** table in the details. The table lists every print with its price, data label and Cardmarket link, plus Cardmarket listings per language across all prints together. Prints are matched at build time when they share Cardmarket's *metacard* (its id for one card's text across all products, from Cardmarket's public product catalog) and the illustrator. For Pokémon without a Cardmarket id, the match uses Pokédex numbers, name suffix (ex, V, GX…), HP, types and illustrator. Groups with two prints in one language are split by rarity class, so a regular card and its full art stay apart. Same-art reprints are included.

5,753 bundles cover 12,580 prints. Cardmarket ids for about 5,800 English cards come from TCGdex (`scripts/build/fetch-tcgdex-products.js`, cached in `data/tcgdex-products.json`, so only new cards are looked up). The checkbox under *Language* switches bundling off.

## Price data label

Each card carries a label counting which of six methods have data for it: Cardmarket price guide · Cardmarket listings · TCGplayer · eBay for sale · sold listings (eBay or PriceCharting) · graded prices. The tiers run **No data → Thin → Fair → Good → Strong → Rich → Complete**. The label is a chip on the card face, a checklist in the card details, a filter in the side rail, and the `data>=N` query.

## Currency

The € / $ switch in the header (also in ⚙ Settings) shows **every** price in one currency. Dollar figures are converted to euro and back at the ECB reference rate; hover a dotted figure to see the original. The headline price is chosen in this order: Cardmarket trend → Cardmarket listing average (card's language, chosen condition or better) → TCGplayer → eBay sold median → PriceCharting ungraded. Settings can put the listing average first.
