// POcKEtMONey scraper: opens Cardmarket, eBay and PriceCharting pages in a window of your own Chrome, one at a time at
// a human pace, reads the prices with parsers.js and sends them to the local helper (scripts/ingest-server.js), which
// writes them into the price store in the same format as the hourly collector.
//
// The helper decides what to visit (GET /queue). This file only drives the tab. If a site shows an "I'm human" check
// or a login, the window is brought to the front and the run waits until you have dealt with it.
'use strict';
importScripts('match.js');
const DEFAULT_HELPER = 'http://127.0.0.1:8787';
const MARK = '#pocketmoney-scrape';           // tells the capture extension's panel to stay out of the way
const LOAD_TIMEOUT = 45e3, CHECK_TIMEOUT = 10 * 60e3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- helper ----------
async function helperUrl() { return (await chrome.storage.local.get('helper')).helper || DEFAULT_HELPER; }
async function helper(path, body) {
  try {
    const r = await fetch((await helperUrl()) + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: r.status, data: await r.json().catch(() => ({})) };
  } catch (e) { return { status: 0, data: { error: 'Helper not running. Start it in the project folder: npm run helper' } }; }
}

// ---------- job state (chrome.storage, so the popup can show it and a restarted worker can resume) ----------
let job = null, running = false;
async function save() { await chrome.storage.local.set({ job }); badge(); }
function log(t) { job.log.unshift(new Date().toLocaleTimeString().slice(0, 5) + ' ' + t); job.log.length = Math.min(job.log.length, 40); }
function badge() {
  const t = !job || ['done', 'stopped', 'error'].includes(job.status) ? '' : job.status === 'waiting' ? '!' : String(job.items.length - job.i);
  chrome.action.setBadgeText({ text: t });
  chrome.action.setBadgeBackgroundColor({ color: job && job.status === 'waiting' ? '#d97706' : '#2149c4' });
}
function stopped() { return !job || job.stop; }
class Stop extends Error {}

// ---------- the scraping window ----------
async function tab() {
  if (job.tabId) try { await chrome.tabs.get(job.tabId); return job.tabId; } catch (e) {}
  const w = await chrome.windows.create({ url: 'about:blank', focused: false, width: 1200, height: 900 });
  job.windowId = w.id; job.tabId = w.tabs[0].id; await save();
  return job.tabId;
}
async function closeWindow() { if (job && job.windowId) try { await chrome.windows.remove(job.windowId); } catch (e) {} if (job) { job.windowId = job.tabId = null; } }

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

async function visit(url) {
  const tabId = await tab();
  await chrome.tabs.update(tabId, { url: url.split('#')[0] + MARK });
  await sleep(800);
  for (const end = Date.now() + LOAD_TIMEOUT; ;) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') break;
    if (Date.now() > end) throw new Error('page did not finish loading: ' + url);
    if (stopped()) throw new Stop();
    await sleep(500);
  }
  await sleep(1200 + Math.random() * 800); // let late scripts render the listings
  let block = await run(tabId, blockCheck).catch(() => '');
  if (block === 'slow down') throw new Stop('the site asks to slow down; try again later or raise the pause between pages');
  if (block) {
    job.status = 'waiting'; job.message = 'Complete the check in the scraper window, then the run continues by itself.'; log('waiting for you: ' + new URL(url).host);
    await save();
    await chrome.windows.update(job.windowId, { focused: true, state: 'normal' });
    chrome.notifications.create('check', { type: 'basic', iconUrl: 'icon128.png', title: 'POcKEtMONey scraper needs you', message: new URL(url).host + ' wants a human check or login. Complete it in the scraper window.', priority: 2 });
    for (const end = Date.now() + CHECK_TIMEOUT; block; ) {
      if (stopped()) throw new Stop();
      if (Date.now() > end) throw new Stop('nobody completed the check on ' + new URL(url).host);
      await sleep(3000);
      const t = await chrome.tabs.get(tabId);
      block = t.status === 'complete' ? await run(tabId, blockCheck).catch(() => 'check') : 'check';
    }
    chrome.notifications.clear('check');
    job.status = 'running'; job.message = ''; log('check done, continuing'); await save();
    await sleep(1500);
  }
  return tabId;
}

async function pause() { // between pages: the configured pace plus a little randomness
  const ms = (job.gap || 7) * 1000 + Math.random() * 3000;
  for (const end = Date.now() + ms; Date.now() < end; ) { if (stopped()) throw new Stop(); await sleep(500); chrome.runtime.getPlatformInfo(); }
}

// page-side: everything parsers.js recognises on this page
function readPage() {
  const r = window.PTCG_PARSE.parsePage(document, location);
  if (!r) return { none: true, url: location.href, title: document.title };
  const o = Object.assign({}, r); delete o.more;
  return { data: JSON.parse(JSON.stringify(o)), url: location.href.split('#')[0], more: !!r.more };
}
// page-side: Cardmarket shows the first offers only; press its own "load more" at a calm pace
async function loadAllOffers(maxClicks) {
  for (let i = 0; i < maxClicks; i++) {
    const r = window.PTCG_PARSE.cardmarket(document, location); if (!r.more) return i;
    const before = r.rowsSeen; r.more.click();
    for (let t = 0; t < 40 && window.PTCG_PARSE.cardmarket(document, location).rowsSeen === before; t++) await new Promise(ok => setTimeout(ok, 250));
    await new Promise(ok => setTimeout(ok, 1500 + Math.random() * 1500));
  }
  return maxClicks;
}
// page-side: candidate result links on a search page, ranked by match.js
function pickInPage(kind, m) {
  const l = Array.prototype.map.call(document.querySelectorAll('a[href]'), a => ({ href: a.href, text: (a.closest('tr, .row, li, article') || a).textContent.replace(/\s+/g, ' ').trim().slice(0, 300) }));
  return kind === 'cm' ? window.PTCG_MATCH.cardmarket(l, m) : window.PTCG_MATCH.pricecharting(l, m);
}
const pick = (tabId, kind, match) => run(tabId, pickInPage, [kind, match], ['match.js']);

async function ingest(site, page, cardId, extra) {
  const r = await helper('/ingest', Object.assign({ site, url: page.url, cardId: cardId || undefined, data: page.data, via: 'scraper' }, extra));
  if (r.status === 200) return r.data;
  if (r.status === 0) throw new Stop(r.data.error);
  throw new Error(r.data.error || 'helper said ' + r.status);
}

// ---------- one card ----------
async function scrapeEbay(item) {
  let n = 0;
  for (const p of item.pages) {
    const tabId = await visit(p.url);
    const page = await run(tabId, readPage, [], ['parsers.js']);
    if (page.none || page.data.site !== 'ebay') throw new Error('not an eBay results page: ' + (page.title || page.url));
    const res = await ingest('ebay', page, item.card, { empty: page.data.found === 0 });
    n++; log('eBay ' + p.mp.replace('EBAY_', '') + (p.sold ? ' sold' : ' for sale') + ': ' + res.report);
    await pause();
  }
  return n;
}

async function scrapeCardmarket(item) {
  const want = new Set(item.products.map(p => p.cm)), got = new Set(), tried = new Set();
  async function product(url) {
    if (tried.has(url.split('#')[0]) || got.size === want.size) return;
    tried.add(url.split('#')[0]);
    const tabId = await visit(url);
    let page = await run(tabId, readPage, [], ['parsers.js']);
    if (page.none || page.data.site !== 'cardmarket') return page;
    if (page.more) { await run(tabId, loadAllOffers, [30]); page = await run(tabId, readPage); }
    const id = page.data.idProduct, mine = want.has(id);
    if (!id) { log('Cardmarket: no product id on ' + page.url); return page; }
    const res = await ingest('cardmarket', page, mine ? item.card : null, { empty: page.data.found === 0 }).catch(e => { log('Cardmarket ' + id + ': ' + e.message); return null; });
    if (res) { log('Cardmarket: ' + res.report + (mine ? '' : ' → ' + res.card.id)); if (mine) got.add(id); }
    await pause();
    return page;
  }
  for (const p of item.products) if (p.url) await product(p.url);
  if (got.size < want.size && item.redirect) await product(item.redirect);
  if (got.size < want.size) {
    const tabId = await visit(item.search);
    const page = await run(tabId, readPage, [], ['parsers.js']);
    if (!page.none && page.data.site === 'cardmarket') { tried.delete(page.url); await product(page.url); } // a single hit opens the product directly
    else {
      const cands = await pick(tabId, 'cm', item.match);
      await pause();
      for (const u of cands.slice(0, want.size - got.size + 2)) await product(u);
    }
  }
  if (!got.size) { await helper('/skip', { site: 'cardmarket', card: item.card, reason: 'no matching product found' }); log('Cardmarket: nothing found for ' + item.label); }
  return got.size;
}

async function scrapePricecharting(item) {
  let tabId = await visit(item.url || item.search), page = await run(tabId, readPage, [], ['parsers.js']);
  const ok = p => !p.none && p.data.site === 'pricecharting' && (item.url || PTCG_MATCH.pricechartingPageOk(p.url, item.match));
  if (!ok(page)) {
    const cands = page.none ? await pick(tabId, 'pc', item.match) : [];
    page = null;
    for (const u of cands.slice(0, 2)) {
      await pause();
      tabId = await visit(u); const p = await run(tabId, readPage, [], ['parsers.js']);
      if (ok(p)) { page = p; break; }
    }
  }
  if (!page) { await helper('/skip', { site: 'pricecharting', card: item.card, reason: 'no matching PriceCharting page' }); log('PriceCharting: nothing found for ' + item.label); await pause(); return 0; }
  const res = await ingest('pricecharting', page, item.card, { empty: page.data.found === 0 });
  log('PriceCharting: ' + res.report); await pause();
  return 1;
}
// ---------- the run ----------
async function loop() {
  if (running || !job) return; running = true;
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20e3);
  try {
    job.status = 'running'; await save();
    while (job.i < job.items.length) {
      if (stopped()) throw new Stop();
      const item = job.items[job.i];
      job.current = item.site + ' · ' + item.label; job.message = ''; await save();
      try {
        const n = item.site === 'ebay' ? await scrapeEbay(item) : item.site === 'cardmarket' ? await scrapeCardmarket(item) : await scrapePricecharting(item);
        if (n) job.saved++; else job.skipped++;
      } catch (e) {
        if (e instanceof Stop) throw e;
        job.failed++; log('✗ ' + item.label + ': ' + e.message);
        await pause().catch(() => {});
      }
      job.i++; await save();
    }
    job.status = 'done'; job.current = ''; job.message = `Finished: ${job.saved} cards saved, ${job.skipped} not found, ${job.failed} failed.`;
    chrome.notifications.create('done', { type: 'basic', iconUrl: 'icon128.png', title: 'POcKEtMONey scraper finished', message: job.message });
  } catch (e) {
    job.status = job.stop ? 'stopped' : 'error'; job.current = '';
    job.message = job.stop ? `Stopped after ${job.i} of ${job.items.length} cards.` : 'Paused: ' + (e.message || 'stopped');
    log(job.message);
  } finally {
    clearInterval(keepAlive); running = false;
    await closeWindow(); await save();
  }
}

async function start(sites, n, only) {
  if (running) return { error: 'A run is already going. Stop it first.' };
  const items = []; let gap = 7;
  for (const site of sites) {
    const r = await helper('/queue?' + new URLSearchParams({ site, n, only: only || '' }));
    if (r.status !== 200) return { error: r.data.error || 'helper said ' + r.status };
    items.push(...r.data.items); gap = r.data.secondsBetweenPages || gap;
  }
  if (!items.length) return { error: 'Nothing to scrape: every card was scraped recently.' };
  job = { sites, items, i: 0, saved: 0, skipped: 0, failed: 0, gap, log: [], status: 'running', startedAt: new Date().toISOString(), current: '', message: '' };
  log('started: ' + items.length + ' cards on ' + sites.join(', '));
  await save();
  loop();
  return { ok: true, count: items.length };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === 'start') return start(msg.sites, msg.n, msg.only);
    if (msg.type === 'stop') { if (job) { job.stop = true; if (!running) { job.status = 'stopped'; await save(); } } return { ok: true }; }
    if (msg.type === 'resume') { if (job && !running && job.i < job.items.length) { job.stop = false; job.failed = job.failed || 0; loop(); } return { ok: true }; }
    if (msg.type === 'clear') { if (!running) { job = null; await chrome.storage.local.remove('job'); badge(); } return { ok: true }; }
    if (msg.type === 'helper') return helper(msg.path, msg.body);
    return { error: 'unknown request' };
  })().then(reply);
  return true;
});

// a restarted service worker picks up a run that was going
(async () => {
  job = (await chrome.storage.local.get('job')).job || null;
  if (job && (job.status === 'running' || job.status === 'waiting') && !job.stop) loop(); else badge();
})();
