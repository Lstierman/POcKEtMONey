'use strict';
const $ = id => document.getElementById(id);
const SITES = [['cardmarket', 'Cardmarket'], ['ebay', 'eBay'], ['pricecharting', 'PriceCharting']];
const send = msg => new Promise(ok => chrome.runtime.sendMessage(msg, ok));
const helper = (path, body) => send({ type: 'helper', path, body });
const fmt = n => (n || 0).toLocaleString('en-US');
function ago(iso) {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60e3);
  if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60); if (h < 48) return h + ' h ago';
  return Math.round(h / 24) + ' days ago';
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

let status = null, job = null, watch = [];
const active = () => job && (job.status === 'running' || job.status === 'waiting');

// ---------- helper status, sites, push ----------
function renderHelper(r) {
  if (!r || r.status !== 200) {
    status = null;
    $('helper').innerHTML = '<b class="err">Helper not running.</b> In the project folder run <code>npm run helper</code>';
  } else {
    status = r.data;
    $('helper').innerHTML = '<b class="ok">Helper connected.</b> ' + (status.publish ? 'Saves every card and pushes to GitHub every 15 min.' : 'Saving locally only (started without --publish).');
  }
  $('sites').innerHTML = !status ? '' : SITES.map(([k, name]) => {
    const s = status.sites[k], pct = s.eligible ? Math.round(1000 * s.fresh / s.eligible) / 10 : 0;
    return '<div class="site"><span class="name">' + name + '</span><span class="w">' + (s.watch.n ? '★ ' + s.watch.current + '/' + s.watch.n + ' up to date' : '') + '</span>' +
      '<div class="bar"><i style="width:' + Math.max(pct, s.fresh ? 0.5 : 0) + '%"></i></div>' +
      '<span class="when">' + fmt(s.fresh) + ' of ' + fmt(s.eligible) + ' cards (' + pct + '%) · last ' + ago(s.lastAt) + '</span></div>';
  }).join('');
  const p = status ? status.pending : 0;
  $('pending').textContent = p ? p + (p === 1 ? ' change' : ' changes') + ' not pushed yet' : 'Everything pushed';
  $('push').disabled = !status || !status.publish || !p;
  $('pushnote').textContent = !status ? '' : !status.publish ? 'Start the helper with npm run helper to push.'
    : status.lastPublish ? (status.lastPublish.ok ? 'Last push ' + ago(status.lastPublish.at) : 'Last push failed: ' + status.lastPublish.error) : 'Pushed every 15 min and when a run ends.';
  renderButton();
}
async function refresh() { renderHelper(await helper('/sites')); }

// ---------- To watch ----------
function renderWatch() {
  $('wcount').textContent = watch.length ? watch.length + (watch.length === 1 ? ' card' : ' cards') + ' · scraped first' : '';
  $('wl').innerHTML = !status ? '<div class="empty">Start the helper to see and edit the list.</div>' : !watch.length ? '<div class="empty">Nothing yet. Add cards here or with ★ on the site.</div>' :
    watch.map(w => '<div class="wi"><span class="star">★</span><span class="n" title="' + esc(w.label) + '">' + esc(w.label) + '</span><span class="p">' + (w.price != null ? '€' + w.price.toFixed(2) : '') +
      '</span><button class="x" data-rm="' + esc(w.id) + '" title="Remove from To watch">×</button></div>').join('');
}
async function loadWatch() { const r = await helper('/watch'); if (r && r.status === 200) watch = r.data.cards; renderWatch(); }
$('wl').addEventListener('click', async e => {
  const id = e.target.dataset && e.target.dataset.rm; if (!id) return;
  await helper('/watch', { remove: [id] }); loadWatch(); refresh();
});
let qTimer = null;
$('q').addEventListener('input', () => {
  clearTimeout(qTimer); const q = $('q').value.trim();
  if (q.length < 2) { $('sug').innerHTML = ''; return; }
  qTimer = setTimeout(async () => {
    const r = await helper('/cards?q=' + encodeURIComponent(q));
    if (!r || r.status !== 200) return;
    const have = new Set(watch.map(w => w.id));
    $('sug').innerHTML = r.data.filter(c => !have.has(c.id)).slice(0, 8).map(c => '<button data-add="' + esc(c.id) + '"><b>' + esc(c.name) + '</b>' + (c.en && c.en !== c.name ? ' (' + esc(c.en) + ')' : '') +
      ' <small>' + esc(c.lang.toUpperCase() + ' · ' + c.set + ' · ' + c.number) + '</small></button>').join('') || '<div class="empty">No card found.</div>';
  }, 250);
});
$('sug').addEventListener('click', async e => {
  const b = e.target.closest('button[data-add]'); if (!b) return;
  await helper('/watch', { add: [b.dataset.add] }); $('q').value = ''; $('sug').innerHTML = ''; loadWatch(); refresh();
});

// ---------- the run ----------
function renderButton() {
  const stopping = job && job.status === 'stopping';
  $('go').textContent = stopping ? 'Stopping: saving what was read…' : active() ? 'Stop' : 'Scrape all';
  $('go').className = active() || stopping ? 'main stop' : 'pr main';
  $('go').disabled = stopping || (!status && !active());
}
function renderJob() {
  renderButton();
  const el = $('job');
  if (!job) { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'job' + (job.status === 'waiting' ? ' waiting' : '');
  const done = job.saved + job.skipped + job.failed, mins = (Date.now() - Date.parse(job.startedAt)) / 60e3;
  $('msg').textContent = job.message || (active() ? (job.done && job.done.catalog ? 'To watch done · working through the catalog' : job.only ? 'Scraping ' + job.only : 'Updating To watch first') : job.status);
  $('cur').textContent = active() ? Object.keys(job.cur || {}).map(s => (SITES.find(x => x[0] === s) || [s, s])[1] + ': ' + job.cur[s] + (job.steps && job.steps[s] ? ' — ' + job.steps[s] : '')).join('\n') : '';
  $('counts').textContent = done + ' cards · ' + job.saved + ' saved · ' + job.skipped + ' not found · ' + job.failed + ' failed' + (done && mins > 0.3 ? ' · ' + (done / mins).toFixed(1) + '/min' : '') +
    (job.cpu && active() ? '\nCPU ' + job.cpu.usage + '% of the machine (limit ' + job.cpu.limit + '%)' + (job.cpu.waitedS ? ', waited ' + job.cpu.waitedS + ' s to stay under' : '') : '');
  $('log').textContent = job.log.join('\n');
}
$('go').onclick = async () => {
  if (active()) { $('go').disabled = true; $('go').textContent = 'Stopping: saving what was read…'; send({ type: 'stop' }); return; }
  const only = $('only').value.trim(), deep = $('deep').checked;
  chrome.storage.local.set({ deep }); // "only" is not remembered, so a test filter never sticks to the next Scrape all
  const r = await send({ type: 'start', only, deep });
  if (r && r.error) { job = { log: [], saved: 0, skipped: 0, failed: 0, startedAt: new Date().toISOString(), status: 'error', message: r.error }; renderJob(); }
};
$('push').onclick = async () => {
  $('push').disabled = true; $('pushnote').textContent = 'Pushing…';
  const r = await helper('/publish', {});
  if (!r || r.status !== 200 || r.data.ok === false) $('pushnote').textContent = 'Push failed: ' + ((r && r.data && r.data.error) || (r && r.status));
  refresh();
};
$('addr').addEventListener('change', () => chrome.storage.local.set({ helper: $('addr').value.trim().replace(/\/$/, '') }, () => { refresh(); loadWatch(); }));

// the site's scraping dashboard (where the bridge last saw it)
chrome.storage.local.get('appUrl', s => { if (s.appUrl) { $('dash').hidden = false; $('dash').onclick = () => chrome.tabs.create({ url: s.appUrl + '#scraping' }); } });
chrome.storage.onChanged.addListener(ch => { if (ch.job) { job = ch.job.newValue || null; renderJob(); } });
chrome.storage.local.get(['job', 'helper', 'deep'], async s => {
  if (s.helper) $('addr').value = s.helper;
  $('deep').checked = !!s.deep;
  job = s.job || null; renderJob();
  await refresh(); loadWatch();
});
setInterval(refresh, 5000);
setInterval(loadWatch, 15000);
