# The platform and the background scraper

`npm start` runs POcKEtMONey on your own computer. It starts two things:

- a **local web server** on <http://127.0.0.1:8787>: the card index (`/`, reading prices straight from your local store), the scraper **dashboard** (`/dashboard`), the watchlist API, and the capture endpoint for the browser extension (`extension/`);
- the **background scraper**: it keeps the cards you care about fresh by visiting their eBay pages in a Chrome window, one card at a time, without taking more than 20 % of the CPU.

```
npm install                 # once: puppeteer-core, to drive your installed Chrome
npm start                   # server + scraper
npm start -- --paused       # start with the scraper paused (resume on the dashboard)
npm start -- --no-scrape    # server only (what `npm run ingest` was)
npm start -- --publish      # also push new results to the prices branch every 10 minutes
npm run scrape -- --cards=base1-4,sv3pt5-199   # one-off batch from the command line, same engine
```

Chrome is found in its usual install location; set `CHROME_PATH` if yours is elsewhere. On the first start the local store (`store/`, git-ignored) is filled from the `prices` branch, so the scraper knows which cards already have data.

## Which cards get scraped

The scraper works through a queue of **jobs**: one card on one site. Every `scrape.replanMinutes` (15) the planner looks at every card and queues the ones that need a visit, for one of three reasons:

| Reason | When | Order |
|---|---|---|
| **watchlist** | the card is on your watchlist and its data is older than `staleHours.watchlist` (6 h) or missing | always first |
| **missing** | the store has no data from that site for the card yet | most valuable first, then newest prints; at most `missingPerPlan` (20) per plan |
| **outdated** | the data is older than the card's tier allows: hot ≥ €50 → 12 h, warm ≥ €5 → 72 h, cold → 14 days | most overdue × most valuable first; at most `outdatedPerPlan` (40) per plan |

"Last seen" is the newest of every way data reaches the store: the hourly API collector, the browser extension, and the scraper itself. A card the collector refreshed an hour ago is not scraped again.

Adding a card to the watchlist queues it immediately. A job that fails is retried after 15 min, then 30 min, and dropped after `maxAttempts` (3) until the next time it is planned. When a site shows a check ("verify you are human", a login), the scraper waits up to 10 minutes for you to complete it in the Chrome window, then pauses for `humanCheckBackoffMinutes` (30) instead of hammering the site.

## Staying under 20 % CPU

All scraping together (the scraper process, every Chrome process it starts, and the platform's work of writing the results into the store) is held to `scrape.cpuLimitPercent` of the whole machine, all cores counted, the figure Task Manager or `top` shows as total CPU.

- **Measured, not guessed.** The scraper reads the CPU time of each Chrome process through the DevTools protocol (`SystemInfo.getProcessInfo`), adds its own, and reports it to the platform continuously. Results written into the store are timed and charged too.
- **A permit before every page.** A token bucket earns 90 % of the budget per second (the rest is headroom for the page that is already loading). Before each page load the scraper asks for a permit; while the bucket is in debt, it waits. Idle time is not saved up for a burst.
- **Lighter pages.** Images, media and fonts are not downloaded (they come back while a check is showing so you can see it), the page's JavaScript runs throttled (`rendererCpuThrottle`), and the scraper and its Chrome run at low process priority, so anything you do comes first.
- **One card at a time, then rest.** Pages on the same site are at least `secondsBetweenPages` (7) apart; Chrome is closed after `idleCloseMinutes` (5) without work.

The dashboard shows the measured share over the last 30 seconds and how long the scraper waited to stay under the limit. The tests run the whole scheduler against a fake site that burns CPU on every page and check both the scheduler's own figure and the kernel's accounting stay at or below 20 %.

## The watchlist

`config/watchlist.json` holds the cards you follow:

```json
{ "cards": [ { "id": "base1-4", "added": "2026-10-26", "note": "optional" } ] }
```

Change it in any of these ways:

- in the card index: **☆ Watch** in a card's details (the page connects to the platform when it runs; otherwise the star is kept in the browser and synced the next time). Search `is:watched` lists them;
- on the dashboard (`/dashboard`): add by id or name, remove;
- through the API: `POST /watchlist {"id": "base1-4"}`, `POST /watchlist {"id": "base1-4", "remove": true}`, `GET /watchlist`;
- by editing the file (restart the platform to pick it up).

Commit the file to have the hourly collector on GitHub refresh those cards every run as well.

## Settings

Everything lives under `scrape` in `config/prices.config.json`:

| Setting | Default | |
|---|---|---|
| `sites` | `["ebay"]` | scrapers to run (`platform/scraper/sites/<name>.js`) |
| `autoStart` | `true` | start the scraper with the platform |
| `cpuLimitPercent` | `20` | CPU budget for all scraping, % of the whole machine |
| `cpuWindowSeconds` | `30` | window for the reported usage |
| `cpuHeadroom` | `0.1` | share of the budget kept free for the page in progress |
| `headless` | `false` | hide the Chrome window (checks can then not be completed) |
| `rendererCpuThrottle` | `2` | slow down page scripts by this factor |
| `blockResources` | image, media, font | resource types not downloaded |
| `secondsBetweenPages` | `7` | minimum gap between pages of one site |
| `replanMinutes` | `15` | how often the queue is re-planned |
| `saveEverySeconds` | `60` | how often scraped results are saved to the store |
| `idleCloseMinutes` | `5` | close Chrome after this long without work |
| `humanCheckBackoffMinutes` | `30` | pause after a check nobody completed |
| `maxAttempts` | `3` | tries per job before it is dropped |
| `staleHours` | watchlist 6, hot 12, warm 72, cold 336 | when data counts as outdated |
| `missingPerPlan`, `outdatedPerPlan` | `20`, `40` | queue size per plan |
| `ebayMarketplaces`, `ebaySold` | DE, US; `true` | which eBay sites, and sold listings too |

## API

| | |
|---|---|
| `GET /status` | store and scraper summary |
| `GET /scraper` | queue (next 50), current job, recent results, CPU figures |
| `POST /scraper/pause`, `/scraper/resume`, `/scraper/plan` | control |
| `POST /scraper/enqueue {"id"}` | scrape this card next |
| `GET /watchlist`, `POST /watchlist`, `DELETE /watchlist/<id>` | the watchlist, with each card's last scrape |
| `GET /cards?q=`, `GET /resolve?cm=…` | card lookup (used by the extension) |
| `POST /ingest` | a capture from the extension |
| `GET /store/<file>` | the local price store |

## Code

```
platform/index.js            npm start: wires everything together
platform/server.js           HTTP routes
platform/capture.js          writes captures and scrape results into the store; journal; publishing to the prices branch
platform/dashboard.html      the /dashboard page
platform/scheduler/
  planner.js                 which cards need a visit (watchlist, missing, outdated)
  queue.js                   priority queue, retries with backoff
  cpu.js                     CPU governor (token bucket) and CPU meter
  index.js                   the loop: plan, run one job at a time, save, stay in budget
platform/scraper/
  worker.js                  the scraper process (forked at low priority)
  browser.js                 Chrome: one tab, own profile, waits for you on checks
  sites/ebay.js              eBay search pages, read with the extension's parsers
```

A new site is a module in `platform/scraper/sites/` exporting `run(ctx, job)`: load pages with `ctx.visit(url, readySelector)` (which waits for the CPU permit) and hand each result to `ctx.capture({ site, data })` in the extension's capture format.
