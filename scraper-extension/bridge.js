// Connects the POcKEtMONey site to this extension, so the site's scraping dashboard shows the run live and can start
// and stop it. Runs only on pages that identify as the POcKEtMONey site (<meta name="pocketmoney" content="app">).
// Page -> extension: window.postMessage({ ptcg: 'page', kind: 'ping' | 'start' | 'stop', id, only, deep })
// Extension -> page: window.postMessage({ ptcg: 'ext', kind: 'hello' | 'job' | 'reply', ... })
(function () {
  'use strict';
  if (window.__ptcgBridge || !document.querySelector('meta[name="pocketmoney"][content="app"]')) return;
  window.__ptcgBridge = true;
  const post = m => window.postMessage(Object.assign({ ptcg: 'ext' }, m), location.origin === 'null' ? '*' : location.origin);
  const hello = () => post({ kind: 'hello', version: chrome.runtime.getManifest().version });
  const sendJob = () => chrome.storage.local.get('job', s => post({ kind: 'job', job: s.job || null }));
  // the popup's "Open dashboard" button opens the site where it was last seen
  chrome.storage.local.set({ appUrl: location.href.split('#')[0] });
  hello(); sendJob();
  chrome.storage.onChanged.addListener(ch => { if (ch.job) post({ kind: 'job', job: ch.job.newValue || null }); });
  window.addEventListener('message', e => {
    const m = e.data;
    if (e.source !== window || !m || m.ptcg !== 'page') return;
    if (m.kind === 'ping') { hello(); sendJob(); return; }
    if (m.kind === 'start' || m.kind === 'stop')
      chrome.runtime.sendMessage({ type: m.kind, only: m.only || '', deep: !!m.deep }, r => post({ kind: 'reply', id: m.id, reply: r || null }));
  });
})();
