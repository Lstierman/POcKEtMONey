'use strict';
const $ = id => document.getElementById(id);
const SITES = [
  ['cardmarket', 'Cardmarket', 'every listing: language, condition, seller'],
  ['ebay', 'eBay', 'for sale and sold'],
  ['pricecharting', 'PriceCharting', 'graded prices and sales']
];
const send = msg => new Promise(ok => chrome.runtime.sendMessage(msg, ok));

function ago(iso) {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60e3);
  if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60); if (h < 48) return h + ' h ago';
  return Math.round(h / 24) + ' days ago';
}

let status = null, job = null;

function renderSites() {
  const busy = job && (job.status === 'running' || job.status === 'waiting');
  $('sites').innerHTML = '';
  for (const [key, name, what] of SITES) {
    const s = status && status.sites[key];
    const div = document.createElement('div'); div.className = 'site';
    div.innerHTML = '<div class="name"></div><button>Scrape</button><div class="when"></div>';
    div.querySelector('.name').textContent = name;
    div.querySelector('.when').textContent = s ? 'Last scraped ' + ago(s.lastAt) + (s.cards ? ' · ' + s.cards.toLocaleString() + ' cards' : '') + ' · ' + what : what;
    const b = div.querySelector('button'); b.disabled = !status || busy;
    b.onclick = () => start([key]);
    $('sites').appendChild(div);
  }
  $('all').disabled = !status || busy;
}

function renderHelper(r) {
  if (r.status !== 200) {
    status = null;
    $('helper').innerHTML = '<b class="err">Helper not running.</b> In the project folder run <code>npm run helper</code>';
  } else {
    status = r.data;
    $('helper').innerHTML = '<b class="ok">Helper connected.</b> ' + (status.publish ? 'Working on a copy of the prices branch.' : 'Saving locally only.');
  }
  const p = status ? status.pending : 0;
  $('pending').textContent = p + (p === 1 ? ' capture' : ' captures') + ' waiting';
  $('push').disabled = !status || !status.publish || !p;
  $('pushnote').textContent = !status ? '' : !status.publish ? 'Start the helper with npm run helper to push.'
    : status.lastPublish ? (status.lastPublish.ok ? 'Last push ' + ago(status.lastPublish.at) : 'Last push failed: ' + status.lastPublish.error) : 'Saved locally until you push.';
  renderSites();
}

function renderJob() {
  const el = $('job');
  if (!job) { el.hidden = true; renderSites(); return; }
  el.hidden = false;
  const active = job.status === 'running' || job.status === 'waiting', total = job.items.length;
  el.className = 'job' + (job.status === 'waiting' ? ' waiting' : '');
  const mins = (Date.now() - Date.parse(job.startedAt || Date.now())) / 60e3, rate = job.i && mins > 0.2 ? ' · ' + (job.i / mins).toFixed(1) + ' cards/min' : '';
  $('msg').textContent = job.message || (active ? job.i + ' of ' + total + ' done' + rate : job.status);
  $('bar').style.width = Math.round(100 * job.i / total) + '%';
  const NAMES = { cardmarket: 'Cardmarket', ebay: 'eBay', pricecharting: 'PriceCharting' };
  $('cur').textContent = active ? Object.keys(job.cur || {}).map(s => NAMES[s] + ': ' + job.cur[s] + (job.steps && job.steps[s] ? ' — ' + job.steps[s] : '')).join('\n') : '';
  $('counts').textContent = job.saved + ' saved · ' + job.skipped + ' not found · ' + job.failed + ' failed';
  $('log').textContent = job.log.join('\n');
  $('stop').hidden = !active;
  $('resume').hidden = active || job.i >= total;
  $('clear').hidden = active;
  renderSites();
}

async function refresh() { renderHelper(await send({ type: 'helper', path: '/sites' })); }

async function start(sites) {
  const n = Math.max(1, Math.min(500, +$('n').value || 20)), only = $('only').value.trim();
  const deep = $('deep').checked;
  chrome.storage.local.set({ n, only, deep });
  const r = await send({ type: 'start', sites, n, only, deep });
  if (r && r.error) { job = { items: [{}], i: 0, saved: 0, skipped: 0, failed: 0, log: [], status: 'error', message: r.error }; renderJob(); }
}

$('all').onclick = () => start(SITES.map(s => s[0]));
$('stop').onclick = () => send({ type: 'stop' });
$('resume').onclick = () => send({ type: 'resume' });
$('clear').onclick = async () => { await send({ type: 'clear' }); job = null; renderJob(); };
$('push').onclick = async () => {
  $('push').disabled = true; $('pushnote').textContent = 'Pushing…';
  const r = await send({ type: 'helper', path: '/publish', body: {} });
  if (r.status !== 200 || r.data.ok === false) $('pushnote').textContent = 'Push failed: ' + (r.data.error || r.status);
  await refresh();
};
$('saveaddr').onclick = () => chrome.storage.local.set({ helper: $('addr').value.trim().replace(/\/$/, '') }, refresh);

chrome.storage.onChanged.addListener(ch => { if (ch.job) { job = ch.job.newValue || null; renderJob(); if (job && job.status !== 'running') refresh(); } });
chrome.storage.local.get(['job', 'helper', 'n', 'only', 'deep'], s => {
  $('deep').checked = !!s.deep;
  if (s.helper) $('addr').value = s.helper;
  if (s.n) $('n').value = s.n;
  if (s.only) $('only').value = s.only;
  job = s.job || null; renderJob(); refresh();
});
setInterval(refresh, 5000);
