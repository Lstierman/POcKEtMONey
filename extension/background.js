// Relays the content script's requests to the local helper (scripts/ingest-server.js). Content scripts can't call
// http://127.0.0.1 from an https page themselves; the service worker can, through host_permissions.
const DEFAULT_HELPER = 'http://127.0.0.1:8787';
async function helper() { return (await chrome.storage.local.get('helper')).helper || DEFAULT_HELPER; }

async function call(path, body) {
  const url = (await helper()) + path;
  try {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  } catch (e) {
    return { status: 0, data: { error: 'The capture helper is not running. Start it with: npm run ingest' } };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === 'ingest') return call('/ingest', msg.payload);
    if (msg.type === 'search') return call('/cards?q=' + encodeURIComponent(msg.q));
    if (msg.type === 'resolve') return call('/resolve?' + new URLSearchParams(msg.params));
    if (msg.type === 'status') return call('/status');
    return { status: 400, data: { error: 'unknown request' } };
  })().then(reply);
  return true; // async reply
});
