const $ = id => document.getElementById(id);
function check() {
  chrome.runtime.sendMessage({ type: 'status' }, r => {
    if (r && r.status === 200) {
      const d = r.data;
      $('st').innerHTML = '<span class="ok">Helper running</span><br>' + d.cards.toLocaleString() + ' cards in the store' +
        (d.scrapedAt ? '<br>last capture ' + new Date(d.scrapedAt).toLocaleString() : '') + (d.publish ? '<br>publishing: ' + d.pending + ' waiting' : '<br>not publishing (local store only)');
    } else $('st').innerHTML = '<span class="err">Helper not running.</span><br>Start the platform in the project folder: <code>npm start</code>';
  });
}
chrome.storage.local.get('helper', s => { if (s.helper) $('helper').value = s.helper; check(); });
$('save').onclick = () => chrome.storage.local.set({ helper: $('helper').value.replace(/\/$/, '') }, check);
