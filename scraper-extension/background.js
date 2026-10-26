// POcKEtMONey scraper: collects Cardmarket, eBay and PriceCharting prices in your own Chrome and sends them to the
// local helper (scripts/ingest-server.js), which writes them into the price store in the same format as the collector.
//
// How it stays fast:
//  - one tab per site, opened once (so any "I'm human" check or login happens once, in a normal page load); every
//    other page is fetched from inside that tab, like the site's own scripts do, and read with parsers.js without
//    being rendered: about a second per page instead of 10-15
//  - the sites run at the same time, each with its own tab and pace
//  - Cardmarket: filtered views (?language=, ?minCondition=) fetched directly instead of pressing "load more" dozens
//    of times; the slow click-through of every single offer is an option ("deep")
// If a site answers with a check or a block, its tab loads that page normally, comes to the front, and the run waits.
'use strict';
importScripts('match.js');
const DEFAULT_HELPER = 'http://127.0.0.1:8787';
const MARK = '#pocketmoney-scrape';           // tells the capture extension's panel to stay out of the way
const LOAD_TIMEOUT = 45e3, CHECK_TIMEOUT = 10 * 60e3;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE_NAME = { cardmarket: 'Cardmarket', ebay: 'eBay', pricecharting: 'PriceCharting' };
const LANG_NAME = { 1: 'English', 2: 'French', 3: 'German', 4: 'Spanish', 5: 'Italian', 6: 'S-Chinese', 7: 'Japanese', 8: 'Portuguese', 9: 'Russian', 10: 'Korean', 11: 'T-Chinese', 12: 'Dutch', 13: 'Polish' };
const COND_NAMES = ['', 'Mint', 'Near Mint', 'Excellent', 'Good', 'Light Played', 'Played', 'Poor'];

// ---------- helper ----------
async function helperUrl() { return (await chrome.storage.local.get('helper')).helper || DEFAULT_HELPER; }
async function helper(path, body) {
  try {
    const r = await fetch((await helperUrl()) + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: r.status, data: await r.json().catch(() => ({})) };
  } catch (e) { return { status: 0, data: { error: 'Helper not running. Start it in the project folder: npm run helper' } }; }
}

// ---------- job state (chrome.storage, so the popup can show it and a restarted worker can resume) ----------
let job = null, running = false, saveTimer = null;
async function save() { clearTimeout(saveTimer); saveTimer = null; await chrome.storage.local.set({ job }); badge(); }
function saveSoon() { if (!saveTimer) saveTimer = setTimeout(save, 250); }
function log(t) { job.log.unshift(new Date().toLocaleTimeString().slice(0, 5) + ' ' + t); job.log.length = Math.min(job.log.length, 60); saveSoon(); }
function badge() {
  const t = !job || ['done', 'stopped', 'error'].includes(job.status) ? '' : job.status === 'waiting' ? '!' : String(job.items.length - job.i);
  chrome.action.setBadgeText({ text: t });
  chrome.action.setBadgeBackgroundColor({ color: job && job.status === 'waiting' ? '#d97706' : '#2149c4' });
}
function stopped() { return !job || job.stop; }
class Stop extends Error {}
// one per site worker: what it is doing right now, shown in the popup
function worker(site) {
  return { site, step(t) { job.steps[site] = t; saveSoon(); }, gap: job.pace.gap, conc: job.pace.conc };
}

// ---------- the scraping window: one tab per site origin ----------
let windowReady = null;
async function ensureWindow() {
  if (job.windowId) try { await chrome.windows.get(job.windowId); return; } catch (e) { job.windowId = null; job.tabs = {}; }
  if (!windowReady) windowReady = (async () => {
    const w = await chrome.windows.create({ url: 'about:blank', focused: false, width: 1200, height: 900 });
    job.windowId = w.id; job.spare = w.tabs[0].id; job.tabs = {}; job.ready = {};
  })().finally(() => { windowReady = null; });
  await windowReady;
}
async function originTab(origin) {
  await ensureWindow();
  const id = job.tabs[origin];
  if (id) try { await chrome.tabs.get(id); return id; } catch (e) { delete job.ready[origin]; }
  let tabId;
  if (job.spare) { tabId = job.spare; job.spare = null; } else tabId = (await chrome.tabs.create({ windowId: job.windowId, url: 'about:blank', active: false })).id;
  job.tabs[origin] = tabId; saveSoon();
  return tabId;
}
async function closeWindow() { if (job && job.windowId) try { await chrome.windows.remove(job.windowId); } catch (e) {} if (job) { job.windowId = null; job.tabs = {}; job.ready = {}; } }

async function run(tabId, func, args, files) {
  if (files) await chrome.scripting.executeScript({ target: { tabId }, files });
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args: args || [] });
  return r && r.result;
}

// page-side: is the site asking for a human check, a login, or saying slow down?
function blockCheck() {
  const t = document.title.toLowerCase(), b = ((document.body && document.body.innerText) || '').slice(0, 4000).toLowerCase();
  if (/just a moment|attention required|nur einen moment|un instant|einen moment bitte/.test(t)) return 'check';
  if (document.querySelector('#challenge-form, #challenge-stage, .cf-turnstile, iframe[src*="challenges.cloudflare.com"], #captcha, #captcha-box, iframe[src*="captcha"], iframe[title*="hCaptcha"]')) return 'check';
  if (/pardon our interruption|verify you are a human|confirm you are human|bestätigen sie, dass sie ein mensch|checking your browser/.test(b)) return 'check';
  if (/too many requests|rate limit/.test(t + ' ' + b.slice(0, 300))) return 'slow down';
  return '';
}

// loads a page normally in its site's tab; waits for you if the site shows a check
async function visit(w, url) {
  const origin = new URL(url).origin, tabId = await originTab(origin);
  w.step('opening ' + new URL(url).host.replace('www.', ''));
  await chrome.tabs.update(tabId, { url: url.split('#')[0] + MARK });
  await sleep(800);
  for (const end = Date.now() + LOAD_TIMEOUT; ;) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') break;
    if (Date.now() > end) throw new Error('page did not finish loading: ' + url);
    if (stopped()) throw new Stop();
    await sleep(300);
  }
  await sleep(700);
  let block = await run(tabId, blockCheck).catch(() => '');
  if (block === 'slow down') { log(SITE_NAME[w.site] + ' asks to slow down: waiting 2 minutes'); w.gap *= 2; await wait(w, 120e3); return visit(w, url); }
  if (block) {
    job.waiting = (job.waiting || 0) + 1; job.status = 'waiting';
    job.message = 'Complete the check in the scraper window (' + new URL(url).host + '), then the run continues by itself.';
    log('waiting for you: ' + new URL(url).host); await save();
    await chrome.windows.update(job.windowId, { focused: true, state: 'normal' });
    await chrome.tabs.update(tabId, { active: true });
    chrome.notifications.create('check', { type: 'basic', iconUrl: 'icon128.png', title: 'POcKEtMONey scraper needs you', message: new URL(url).host + ' wants a human check or login. Complete it in the scraper window.', priority: 2 });
    try {
      for (const end = Date.now() + CHECK_TIMEOUT; block; ) {
        if (stopped()) throw new Stop();
        if (Date.now() > end) throw new Stop('nobody completed the check on ' + new URL(url).host);
        await sleep(2000);
        const t = await chrome.tabs.get(tabId);
        block = t.status === 'complete' ? await run(tabId, blockCheck).catch(() => 'check') : 'check';
      }
    } finally {
      job.waiting--; if (!job.waiting) { job.status = 'running'; job.message = ''; chrome.notifications.clear('check'); }
    }
    log('check done on ' + new URL(url).host + ', continuing'); await save();
    await sleep(1000);
  }
  job.ready[origin] = true;
  return tabId;
}
async function wait(w, ms) { for (const end = Date.now() + ms; Date.now() < end; ) { if (stopped()) throw new Stop(); await sleep(500); } }

// page-side: fetches pages of this site from inside its tab (same origin, your cookies) and reads them with
// parsers.js without rendering. opts: { conc, gap (s), pageSize, pick: { kind, match } }
async function fetchParse(urls, opts) {
  const out = new Array(urls.length), sleep = ms => new Promise(r => setTimeout(r, ms));
  const BLOCKED = /challenge-platform|cf-turnstile|<title>\s*(just a moment|attention required)|pardon our interruption|verify you are a human|g-recaptcha|hcaptcha/i;
  // fetched pages are not rendered, so "load more" is judged from the markup: a visible-looking, enabled button
  function cmHasMore(doc, p) {
    const btn = Array.prototype.some.call(doc.querySelectorAll('button, a.btn, #loadMore, [id*="loadMore"]'), function (b) {
      return /load more|show more|mehr anzeigen|weitere|plus de résultats|loadMore/i.test(b.id + ' ' + b.textContent) && !b.disabled && !b.closest('.d-none, [hidden], [style*="display: none"], [style*="display:none"]');
    });
    return btn || p.rowsSeen >= (opts.pageSize || 50);
  }
  let next = 0;
  async function lane(k) {
    if (k) await sleep(k * 400);
    while (next < urls.length) {
      const i = next++, url = urls[i];
      try {
        const r = await fetch(url, { credentials: 'include', headers: { Accept: 'text/html,application/xhtml+xml' } });
        const html = await r.text();
        if (r.status === 429) out[i] = { url, slow: true, status: 429 };
        else if ((r.status === 403 || r.status === 503 || BLOCKED.test(html.slice(0, 30000))) && !/data-listingid|articleRow|completed-auctions/.test(html)) out[i] = { url, blocked: true, status: r.status };
        else {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const base = doc.createElement('base'); base.href = r.url; (doc.head || doc.documentElement).prepend(base);
          const p = window.PTCG_PARSE.parsePage(doc, new URL(r.url));
          const res = { url, final: r.url.split('#')[0], status: r.status, title: doc.title };
          if (p) { const d = Object.assign({}, p); delete d.more; res.data = JSON.parse(JSON.stringify(d)); res.more = p.site === 'cardmarket' ? cmHasMore(doc, p) : false; }
          if (opts.pick && !p) {
            const links = Array.prototype.map.call(doc.querySelectorAll('a[href]'), a => ({ href: a.href, text: (a.closest('tr, .row, li, article') || a).textContent.replace(/\s+/g, ' ').trim().slice(0, 300) }));
            res.picked = opts.pick.kind === 'cm' ? window.PTCG_MATCH.cardmarket(links, opts.pick.match) : window.PTCG_MATCH.pricecharting(links, opts.pick.match);
          }
          out[i] = res;
        }
      } catch (e) { out[i] = { url, error: e.message }; }
      if (next < urls.length) await sleep((opts.gap || 1.5) * 1000 * (0.7 + Math.random() * 0.6));
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.conc || 1, urls.length)) }, (_, k) => lane(k)));
  return out;
}

// fetches pages through their site's tab; a block or check makes that tab load the page normally (you complete the
// check there), then the page is fetched again. Results in the order of urls.
async function getPages(w, urls, pick) {
  const out = new Array(urls.length), byOrigin = new Map();
  urls.forEach((u, i) => { const o = new URL(u).origin; if (!byOrigin.has(o)) byOrigin.set(o, []); byOrigin.get(o).push(i); });
  await Promise.all([...byOrigin].map(async ([origin, idx]) => { // eBay.de and eBay.com side by side
    if (!job.ready[origin]) await visit(w, urls[idx[0]]); // first page of this site: a normal load, for cookies and checks
    for (let attempt = 0; attempt < 3; attempt++) {
      if (stopped()) throw new Stop();
      const todo = idx.filter(i => !out[i] || out[i].blocked || out[i].slow);
      if (!todo.length) break;
      const tabId = await originTab(origin);
      const res = await run(tabId, fetchParse, [todo.map(i => urls[i]), { conc: w.conc, gap: w.gap, pageSize: job.pace.pageSize, pick }], ['parsers.js', 'match.js']);
      todo.forEach((i, k) => { out[i] = res[k]; });
      const slow = res.filter(r => r.slow), blocked = res.filter(r => r.blocked);
      if (slow.length) { w.gap = Math.min(10, w.gap * 2); w.conc = 1; log(SITE_NAME[w.site] + ': too many requests, slowing down to one page every ' + w.gap.toFixed(1) + ' s'); await wait(w, 30e3); }
      if (blocked.length) await visit(w, blocked[0].url);
    }
  }));
  return out;
}
async function getPage(w, url, pick) { return (await getPages(w, [url], pick))[0]; }

async function ingest(site, page, cardId, extra) {
  const r = await helper('/ingest', Object.assign({ site, url: page.final || page.url, cardId: cardId || undefined, data: page.data, via: 'scraper' }, extra));
  if (r.status === 200) return r.data;
  if (r.status === 0) throw new Stop(r.data.error);
  throw new Error(r.data.error || 'helper said ' + r.status);
}

// ---------- eBay: every search of the card in parallel ----------
async function scrapeEbay(w, item) {
  w.step('eBay: ' + item.pages.length + ' searches');
  const pages = await getPages(w, item.pages.map(p => p.url));
  let n = 0;
  for (let k = 0; k < pages.length; k++) {
    const p = item.pages[k], page = pages[k];
    if (!page || !page.data || page.data.site !== 'ebay') { log('eBay ' + p.mp.replace('EBAY_', '') + ': ' + (page && (page.error || page.title) || 'no results page')); continue; }
    const res = await ingest('ebay', page, item.card, { empty: page.data.found === 0 });
    n++; log('eBay ' + p.mp.replace('EBAY_', '') + (p.sold ? ' sold' : ' for sale') + ': ' + res.report);
  }
  if (!n) throw new Error('no eBay results page could be read');
  return n;
}

// ---------- Cardmarket ----------
// Every listing per language and condition. One request shows a product's cheapest offers (about 50). When there are
// more, the product is fetched per language (?language=), and a language that is still cut off per condition
// threshold (?minCondition=1 Mint … 6 Played, "this or better"), so each language × condition has its cheapest offers.
// With "deep" on, views that are still cut off are opened in the tab and "load more" is pressed until the end.
function offerKey(a) { return a[0] > 99999 ? 'id' + a[0] : JSON.stringify(a.slice(1, 12)); } // real article ids, else the row's content
const viewName = (lang, cond) => (lang ? LANG_NAME[lang] || 'language ' + lang : 'all languages') + (cond ? ', ' + COND_NAMES[cond] + ' or better' : '');
const viewUrl = (base, lang, cond) => { const q = new URLSearchParams(); if (lang) q.set('language', lang); if (cond) q.set('minCondition', cond); return base + (q.toString() ? '?' + q : ''); };

// page-side (deep mode): the rendered page's offers, and pressing Cardmarket's own "load more"
function readPage() {
  const r = window.PTCG_PARSE.parsePage(document, location);
  if (!r) return { none: true, url: location.href, title: document.title };
  const o = Object.assign({}, r); delete o.more;
  return { data: JSON.parse(JSON.stringify(o)), url: location.href.split('#')[0], more: !!r.more };
}
async function loadAllOffers(maxClicks) {
  for (let i = 0; i < maxClicks; i++) {
    const r = window.PTCG_PARSE.cardmarket(document, location); if (!r.more) return i;
    const before = r.rowsSeen; r.more.click();
    for (let t = 0; t < 40 && window.PTCG_PARSE.cardmarket(document, location).rowsSeen === before; t++) await new Promise(ok => setTimeout(ok, 250));
    await new Promise(ok => setTimeout(ok, 800 + Math.random() * 700));
  }
  return maxClicks;
}
async function deepView(w, url, max, what) {
  const tabId = await visit(w, url);
  await run(tabId, () => 0, [], ['parsers.js']);
  let page = await run(tabId, readPage);
  for (let done = 0; page.more && done < max; ) {
    w.step(what + ': loading every offer… ' + page.data.found);
    const n = Math.min(5, max - done); await run(tabId, loadAllOffers, [n]); done += n;
    if (stopped()) throw new Stop();
    page = await run(tabId, readPage);
  }
  return page;
}

async function cmProduct(w, first, item) { // first: the product page as fetched (unfiltered or not)
  const base = first.final.split('?')[0], f = item.filters || {}, offers = new Map(), coverage = [];
  const add = (p, lang, cond) => {
    if (!p || !p.data || p.data.site !== 'cardmarket') return null;
    p.data.articles.forEach(a => offers.set(offerKey(a), a));
    coverage.push([lang, cond, p.data.found, p.more ? 0 : 1]);
    return !p.more;
  };
  const all = /\?/.test(first.final) ? await getPage(w, viewUrl(base, 0, 0)) : first;
  if (!add(all, 0, 0)) {
    // per language: the configured ones plus any seen on the first page
    const langs = [...new Set((f.languages || []).concat(all.data.articles.map(a => a[1]).filter(Boolean)))];
    w.step('Cardmarket: ' + all.data.found + '+ offers, fetching ' + langs.length + ' languages');
    const lv = await getPages(w, langs.map(l => viewUrl(base, l, 0)));
    const cut = langs.filter((l, k) => add(lv[k], l, 0) === false);
    if (cut.length && f.conditions !== false) {
      const views = []; cut.forEach(l => { for (let c = 1; c <= 6; c++) views.push([l, c]); });
      w.step('Cardmarket: ' + cut.map(l => LANG_NAME[l]).join(', ') + ' per condition (' + views.length + ' views)');
      const cv = await getPages(w, views.map(([l, c]) => viewUrl(base, l, c)));
      views.forEach(([l, c], k) => add(cv[k], l, c));
    }
    if (job.deep) { // every single offer: languages still cut off, clicked through in the tab
      for (const l of cut) {
        const p = await deepView(w, viewUrl(base, l, 0), (f.maxLoadMore || 40), 'Cardmarket ' + viewName(l, 0));
        if (p && !p.none) add(p, l, 0);
      }
    }
    const left = coverage.filter(c => !c[3]).length;
    log('Cardmarket ' + item.label + ': ' + offers.size + ' offers from ' + coverage.length + ' views' + (left ? ' (' + left + ' views show the cheapest only' + (job.deep ? '' : '; "every single offer" loads the rest') + ')' : ', complete'));
  }
  return Object.assign({}, all.data, { articles: [...offers.values()], found: offers.size, coverage });
}

async function scrapeCardmarket(w, item) {
  const want = new Set(item.products.map(p => p.cm)), got = new Set(), tried = new Set(), errors = [];
  async function product(page) {
    if (!page || !page.data || page.data.site !== 'cardmarket') return;
    const key = page.final.split('?')[0]; if (tried.has(key)) return; tried.add(key);
    const id = page.data.idProduct;
    if (!id) { log('Cardmarket: no product id on ' + page.final); return; }
    if (!want.has(id)) { // another card's product: store what this page shows
      const res = await ingest('cardmarket', page, null, { empty: page.data.found === 0 }).catch(e => { log('Cardmarket ' + id + ': ' + e.message); return null; });
      if (res) log('Cardmarket: ' + res.report + ' → ' + res.card.id);
      return;
    }
    const data = await cmProduct(w, page, item);
    const odd = data.articles.filter(a => a[2] === '??').length;
    if (odd) log('Cardmarket ' + id + ': ' + odd + ' of ' + data.articles.length + ' offers without a readable condition (kept, left out of the condition prices)');
    const res = await ingest('cardmarket', { final: page.final, data }, item.card, { empty: data.found === 0 }).catch(e => { errors.push(e.message); log('✗ Cardmarket ' + id + ': ' + e.message); return null; });
    if (res) { log('Cardmarket: ' + res.report); got.add(id); }
    else { want.delete(id); tried.add('failed:' + id); } // found but not saved: don't look for it elsewhere
  }
  w.step('Cardmarket: finding the product');
  const known = item.products.filter(p => p.url).map(p => p.url);
  if (known.length) for (const page of await getPages(w, known)) await product(page);
  if (got.size < want.size && item.redirect) { // pokemontcg.io redirects to the product page; only the address is needed
    try {
      const ctl = new AbortController(), r = await fetch(item.redirect, { signal: ctl.signal }); ctl.abort();
      if (/cardmarket\.com\/.+\/Products\/Singles\//.test(r.url)) await product(await getPage(w, r.url.split('?')[0]));
      else log('Cardmarket: pokemontcg.io sent ' + item.card + ' to ' + (r.url || 'nowhere') + ' (HTTP ' + r.status + ')');
    } catch (e) { if (e instanceof Stop) throw e; log('Cardmarket: pokemontcg.io redirect failed: ' + e.message); }
  }
  // each product still missing: search its exact name within its expansion (from Cardmarket's catalog)
  for (const p of item.products) {
    if (got.has(p.cm) || !want.has(p.cm) || !p.search) continue;
    w.step('Cardmarket: searching ' + (p.variant || 'product ' + p.cm));
    const s = await getPage(w, p.search, { kind: 'cm', match: item.match });
    if (s && s.data) await product(s); // a single hit opens the product directly
    else if (s && s.picked) for (const u of s.picked) { if (got.has(p.cm)) break; if (!tried.has(u.split('?')[0])) await product(await getPage(w, u)); }
  }
  if (got.size < want.size) {
    const s = await getPage(w, item.search, { kind: 'cm', match: item.match });
    if (s && s.data) await product(s); // a single hit opens the product directly
    else if (s && s.picked) for (const u of s.picked.slice(0, want.size - got.size + 2)) { if (got.size === want.size) break; if (!tried.has(u.split('?')[0])) await product(await getPage(w, u)); }
  }
  if (!got.size && errors.length) throw new Error('found, but the helper could not save it: ' + errors[0]); // not a "not found": retried next run
  if (!got.size) { await helper('/skip', { site: 'cardmarket', card: item.card, reason: 'no matching product found' }); log('Cardmarket: nothing found for ' + item.label); }
  return got.size;
}

// ---------- PriceCharting ----------
async function scrapePricecharting(w, item) {
  w.step('PriceCharting: ' + (item.url ? 'card page' : 'searching'));
  const ok = p => p && p.data && p.data.site === 'pricecharting' && (item.url || PTCG_MATCH.pricechartingPageOk(p.final, item.match));
  let page = await getPage(w, item.url || item.search, { kind: 'pc', match: item.match });
  if (!ok(page)) {
    const cands = (page && page.picked) || []; page = null;
    for (const u of cands.slice(0, 2)) { const p = await getPage(w, u); if (ok(p)) { page = p; break; } }
  }
  if (!page) { await helper('/skip', { site: 'pricecharting', card: item.card, reason: 'no matching PriceCharting page' }); log('PriceCharting: nothing found for ' + item.label); return 0; }
  const res = await ingest('pricecharting', page, item.card, { empty: page.data.found === 0 });
  log('PriceCharting: ' + res.report);
  return 1;
}

// ---------- the run: one worker per site, all at the same time ----------
const SCRAPE = { ebay: scrapeEbay, cardmarket: scrapeCardmarket, pricecharting: scrapePricecharting };
async function siteWorker(site) {
  const w = worker(site);
  for (;;) {
    if (stopped()) throw new Stop();
    const k = job.items.findIndex((it, x) => it.site === site && !job.st[x]);
    if (k < 0) { delete job.cur[site]; delete job.steps[site]; saveSoon(); return; }
    const item = job.items[k]; job.st[k] = 'busy'; job.cur[site] = item.label; job.steps[site] = ''; saveSoon();
    try {
      const n = await SCRAPE[site](w, item);
      job.st[k] = n ? 'saved' : 'skipped'; if (n) job.saved++; else job.skipped++;
    } catch (e) {
      if (e instanceof Stop) { job.st[k] = null; throw e; }
      job.st[k] = 'failed'; job.failed++; log('✗ ' + SITE_NAME[site] + ' ' + item.label + ': ' + e.message);
    }
    job.i++; saveSoon();
  }
}

async function loop() {
  if (running || !job) return; running = true;
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20e3);
  try {
    job.status = 'running'; job.waiting = 0; job.cur = {}; job.steps = {};
    job.st = job.st || []; job.st.forEach((s, k) => { if (s === 'busy') job.st[k] = null; });
    job.ready = {}; await save();
    const sites = [...new Set(job.items.map(i => i.site))];
    const results = await Promise.allSettled(sites.map(siteWorker));
    const errs = results.map((r, k) => r.status === 'rejected' && !job.stop ? SITE_NAME[sites[k]] + ': ' + (r.reason && r.reason.message || 'stopped') : null).filter(Boolean);
    if (job.stop) { job.status = 'stopped'; job.message = `Stopped after ${job.i} of ${job.items.length} cards.`; }
    else if (errs.length) { job.status = 'error'; job.message = 'Paused: ' + errs.join('; '); }
    else {
      job.status = 'done'; job.message = `Finished in ${Math.max(1, Math.round((Date.now() - Date.parse(job.startedAt)) / 60e3))} min: ${job.saved} saved, ${job.skipped} not found, ${job.failed} failed.`;
      chrome.notifications.create('done', { type: 'basic', iconUrl: 'icon128.png', title: 'POcKEtMONey scraper finished', message: job.message });
    }
    log(job.message);
  } finally {
    clearInterval(keepAlive); running = false; job.cur = {}; job.steps = {};
    await closeWindow(); await save();
  }
}

async function start(sites, n, only, deep) {
  if (running) return { error: 'A run is already going. Stop it first.' };
  const items = []; let pace = { gap: 1.5, conc: 2, pageSize: 50 };
  for (const site of sites) {
    const r = await helper('/queue?' + new URLSearchParams({ site, n, only: only || '' }));
    if (r.status !== 200) return { error: r.data.error || 'helper said ' + r.status };
    items.push(...r.data.items); if (r.data.pace) pace = Object.assign(pace, r.data.pace);
  }
  if (!items.length) return { error: 'Nothing to scrape: every card was scraped recently.' };
  job = { sites, items, st: [], i: 0, saved: 0, skipped: 0, failed: 0, pace, deep: !!deep, log: [], status: 'running', startedAt: new Date().toISOString(), cur: {}, steps: {}, message: '', tabs: {}, ready: {} };
  log('started: ' + items.length + ' cards on ' + sites.map(s => SITE_NAME[s]).join(', ') + (deep ? ' (every single Cardmarket offer)' : ''));
  await save();
  loop();
  return { ok: true, count: items.length };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === 'start') return start(msg.sites, msg.n, msg.only, msg.deep);
    if (msg.type === 'stop') { if (job) { job.stop = true; if (!running) { job.status = 'stopped'; await save(); } } return { ok: true }; }
    if (msg.type === 'resume') { if (job && !running && job.i < job.items.length) { job.stop = false; loop(); } return { ok: true }; }
    if (msg.type === 'clear') { if (!running) { job = null; await chrome.storage.local.remove('job'); badge(); } return { ok: true }; }
    if (msg.type === 'helper') return helper(msg.path, msg.body);
    return { error: 'unknown request' };
  })().then(reply);
  return true;
});

// a restarted service worker picks up a run that was going
(async () => {
  job = (await chrome.storage.local.get('job')).job || null;
  if (job && !job.st) job = null; // a run from the older version of the extension
  if (job && (job.status === 'running' || job.status === 'waiting') && !job.stop) loop(); else badge();
})();
