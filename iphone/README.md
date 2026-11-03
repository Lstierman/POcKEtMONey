# Cardmarket from your iPhone

`pocketmoney-cardmarket.user.js` runs in Safari on cardmarket.com. Tap the yellow **€** button on any card's page and it reads every offer of that product. It shows them per language and condition and saves them to POcKEtMONey. From any other Cardmarket page, the same button scrapes your whole **To watch** list.

Because it runs in your own Safari, every request is an ordinary request from your phone, with your cookies. There are no robot checks to fight, and nothing needs to run on your computer.

## Setup (once, about 5 minutes)

1. **Install [Userscripts](https://apps.apple.com/app/userscripts/id1463298887)** from the App Store (free, open source). Open it once and pick any folder for its scripts.
2. **Turn it on:** Settings → Apps → Safari → Extensions → Userscripts → on, and under *Permissions* allow it on `www.cardmarket.com`.
3. **Install the script:** open this address in Safari:
   `https://raw.githubusercontent.com/Lstierman/POcKEtMONey/main/iphone/pocketmoney-cardmarket.user.js`
   Then tap **aA** (or the puzzle icon) in the address bar → **Userscripts** → **Install**. Userscripts installs updates from that address by itself.
4. **Let it save to GitHub:** on github.com, open *Settings → Developer settings → Fine-grained personal access tokens → Generate new token*:
   - Repository access: *Only select repositories* → **POcKEtMONey**
   - Permissions: **Contents: Read and write**, **Actions: Read and write**

   On Cardmarket, tap **€** on a page that is not a product (or long-press it on a product page), paste the token, then tap *Save settings*. The token is kept in the Userscripts extension's storage on your phone, never in the page.

## Using it

- **One card:** open its Cardmarket page and tap **€**. You'll see how many offers were read (and how many copies Cardmarket lists in total), the price trend, the near-mint median, and a table of language × condition (cheapest price and copies per cell). It also lists the near-mint offers priced well below the median. The capture is saved straight away.
- **Your To watch list:** tap **€** on a non-product page → *Scrape my To watch list*. It reads every watched card not read in the last 24 hours (never-read cards first, then the oldest) and keeps the screen awake while it runs. Leave Safari open in front, since iOS pauses background tabs. *Stop* keeps everything read so far.
- **Every card you open:** ⚙ → *Scan every card page I open*.
- **If Cardmarket shows a check:** the scan stops and tells you. Reload the page, complete the check, then tap **€** again.

## How it reads more, and more accurately, than the Chrome scraper

A product page only shows its ~50 cheapest offers, so the script opens filtered views of the same product. Every view is **checked against its own rows**: a "Japanese" view whose rows are English means Cardmarket ignored the filter. The Chrome scraper counted those as real language views. In the stored data for 151 Charizard ex, 8 of 13 language views were the unfiltered list. A view whose rows all match its filter holds exactly that filter's cheapest offers, so a trusted view is always right.

In order, per product:

1. **Price floor paging.** If Cardmarket honours a price-from filter, it pages through every offer, cheapest to dearest: about 400 offers in 9 requests. The working parameter is found once and remembered for a week.
2. **Split by language, then seller country** (values taken from the page's own filter form). A value Cardmarket doesn't filter by, which returns the unfiltered list, is recognised as "no such offers here", not as a hole in the data.
3. **Minimum condition** ("this or better") as a last resort for views still cut off.

Each product reads *Available items* from the page, so the sheet and the stored listing say exactly how many copies were read out of how many are listed. At most 60 pages are read per product (⚙ *Most pages per product*), 1.5 s apart by default.

**Copy diagnostics** (after a scan) puts the scan's details on the clipboard: which filters worked, the page's filter fields, and one raw offer row. If Cardmarket changes its pages, paste that in an issue and the parser can be fixed.

## Where the data goes

```
phone outbox ──(one commit per batch)──▶ branch inbox: cardmarket/<day>/<time>-<product>.json
                                                 │  workflow "Ingest phone captures" (started by the phone; hourly anyway)
                                                 ▼
                                   scripts/ingest-inbox.js ──▶ branch prices (same files and checks as the helper)
```

Captures wait in an outbox on the phone (the red number on the button) until they are committed, so no signal means no loss. The workflow applies them oldest first. It finds the card by its Cardmarket product id, replaces that product's listings, updates summary, markets and history, verifies every file, and publishes. Only then does it remove the handled captures from the inbox. A capture applied twice is recognised and skipped. The local helper (`npm start`) and the hourly collector keep working alongside: all three replay or rebase onto each other's pushes.
