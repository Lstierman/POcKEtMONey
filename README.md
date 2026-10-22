# POcKEtMONey

Every English and Japanese Pokémon TCG card in one page that works offline, searches in about a millisecond, and shows what each card is worth.

- **33,641 cards**: 20,635 English (Base Set through *30th Celebration*) and 13,006 Japanese prints, each language as its own card with its own prices.
- **Prices**: Cardmarket (EUR, per variant, 6 weeks of history), TCGplayer (USD, per variant, 2 weeks of history), and PriceCharting graded prices with recent sold listings (linked) for the cards in `data/pricecharting/`.
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
| `-supporter` | excludes a word |

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
scripts/build-catalog.js       builds the compact catalog with prices and history
scripts/merge-pricecharting.js normalises the PriceCharting sales files
scripts/assemble.js            inlines everything into index.html
data/pricecharting/            graded prices and sold listings, one card per line
.github/workflows/refresh.yml  rebuilds index.html every day
```

## Build

Requires Node 22 and git.

```
npm run refresh   # fetch sources + build index.html
npm run build     # rebuild from already-fetched sources
```

The **Refresh catalog and prices** workflow runs the same thing daily and commits the new `index.html`. Turn on GitHub Pages (Settings → Pages → Deploy from branch → `main`, `/ (root)`) to get a public link.

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
| Graded prices, sold listings | [PriceCharting](https://www.pricecharting.com) (collected per card) |

Cardmarket's public price guide pools all European languages into one figure, so a German or French copy can sell above or below the euro price shown. Japanese prints are separate Cardmarket products with their own prices. Card data and images belong to their respective owners; Pokémon is a trademark of Nintendo, Creatures and GAME FREAK.
