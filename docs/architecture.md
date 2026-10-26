# How it works

## Storage and search

- **Compact storage.** Each card is a positional tuple with no repeated field names, and image URLs are shortened to a two-letter host code. The whole catalog (about 22 MB of JSON) ships gzip-compressed and base64-inlined in `index.html` (about 6 MB), so the page needs no network request to open.
- **Inverted index.** On load the page builds a sorted term dictionary with one `Uint32Array` posting list per term. A prefix lookup is a binary search plus a contiguous scan; results are cached in a small LRU.
- **Bitmap filters.** Every filter value (type, set, rarity, language, legality…) is a bitmap with one bit per card. Combining filters is a word-by-word AND over about 1,050 32-bit words, and the live counts on the filter chips are popcounts.
- **Typo fallback.** A word with no prefix match falls back to a bounded edit-distance scan of the dictionary.

## Building the page

Requires Node 22 and git.

```
npm run refresh   # fetch sources + graded prices + build index.html
npm run build     # rebuild from already-fetched sources
npm run assemble  # re-render index.html after editing src/ (reuses the catalog already in index.html)
```

The **Refresh catalog and prices** workflow runs the same thing daily and commits the new `index.html`. To refresh graded prices too, add a PriceCharting API token as the repository secret `PRICECHARTING_TOKEN`. Turn on GitHub Pages (Settings → Pages → Deploy from branch → `main`, `/ (root)`) to get a public link.

## Adding cards to the sales data

Append one line per card to a file in `data/pricecharting/` (`.jsonl`):

```json
{"id":"base1-4","pc":"https://www.pricecharting.com/game/pokemon-base-set/charizard-4","prices":{"ungraded":471.92,"grade7":823.79,"grade8":1266.11,"grade9":3451.01,"grade9_5":8540,"psa10":18162.69},"sold":[["2026-10-22","PSA 8","1999 Base Set Unlimited #4 Charizard PSA 8",1300,"https://www.ebay.com/itm/307229523055"]]}
```

`id` is the pokemontcg.io card id (Japanese cards: `ja:<TCGdex id>`, e.g. `ja:SM9-105`).
