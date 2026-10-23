// The "Save to POcKEtMONey" panel on Cardmarket product pages, eBay searches and PriceCharting card pages.
// It reads the page you opened (extension/parsers.js) and sends the result to the local helper, which stores it in the
// price store. It only acts when you click (or, if you switch on auto-save for a site, once per page you open).
(function () {
  'use strict';
  if (window.__pocketmoney) return; window.__pocketmoney = true;
  if (/pocketmoney-scrape/.test(location.hash)) return; // a page the scraper extension opened: it saves the prices itself
  var PARSE = window.PTCG_PARSE, first = PARSE && PARSE.parsePage(document, location);
  if (!first) return;
  var site = first.site;

  // which card: #pocketmoney=<id> (links from the POcKEtMONey page), else what you picked here before for this page
  function pageKey() {
    var u = new URL(location.href);
    if (site === 'ebay') return 'ebay|' + u.host + '|' + (u.searchParams.get('_nkw') || '').toLowerCase() + '|' + (u.searchParams.get('LH_Sold') === '1' ? 'sold' : 'sale');
    return site + '|' + u.pathname.replace(/^\/[a-z]{2}\//, '/');
  }
  var cardId = (/pocketmoney=([^&]+)/.exec(location.hash) || [])[1] || null;
  if (cardId) cardId = decodeURIComponent(cardId);
  var key = pageKey(), autoKey = 'auto|' + site;
  function send(type, extra) { return new Promise(function (ok) { chrome.runtime.sendMessage(Object.assign({ type: type }, extra), ok); }); }
  function remember(id) { var o = {}; o[key] = id; chrome.storage.local.set(o); }

  // ---------- panel (shadow DOM, so the site's CSS can't touch it) ----------
  var host = document.createElement('div'); host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647';
  var sh = host.attachShadow({ mode: 'open' });
  sh.innerHTML = '<style>' +
    ':host{all:initial}*{box-sizing:border-box;font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '.p{width:330px;background:#fbfcfd;color:#141a24;border:1px solid #d3d9e2;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);padding:12px;display:grid;gap:8px}' +
    '.h{display:flex;align-items:center;gap:8px;font-weight:800;font-size:14px}.h i{width:12px;height:17px;border-radius:2px;border:2px solid #e4c35a;background:#2149c4;display:inline-block}' +
    '.h span{flex:1}.x{border:0;background:none;cursor:pointer;font-size:16px;color:#5a6474}' +
    '.f{color:#5a6474}.f b{color:#141a24}.row{display:flex;gap:6px}' +
    'input[type=text]{flex:1;min-width:0;height:32px;border:1.5px solid #d3d9e2;border-radius:8px;padding:0 8px}' +
    'button.b{height:32px;border-radius:8px;border:1.5px solid #d3d9e2;background:#fff;cursor:pointer;font-weight:700;padding:0 10px}' +
    'button.pr{background:#2149c4;color:#fff;border-color:#2149c4}button:disabled{opacity:.5;cursor:default}' +
    '.sug{display:grid;gap:2px;max-height:180px;overflow:auto}.sug button{text-align:left;border:0;background:#eef2fb;border-radius:6px;padding:5px 7px;cursor:pointer}' +
    '.sug small{color:#5a6474}.s{min-height:18px}.ok{color:#157a3d;font-weight:700}.err{color:#b8322a;font-weight:700}' +
    'label{display:flex;gap:6px;align-items:center;color:#5a6474}.mini{padding:6px 10px;border-radius:99px;background:#2149c4;color:#fff;font-weight:800;cursor:pointer;border:0;box-shadow:0 4px 14px rgba(0,0,0,.25)}' +
    '</style><div class="p" id="p"><div class="h"><i></i><span>POcKEtMONey</span><button class="x" id="min" title="Minimise">–</button></div>' +
    '<div class="f" id="found"></div>' +
    '<div class="row"><input type="text" id="card" placeholder="Card id, or search: charizard 4/102" spellcheck="false"><button class="b" id="find">Find</button></div>' +
    '<div class="sug" id="sug"></div>' +
    '<div class="row"><button class="b pr" id="save">Save</button><button class="b" id="all" hidden>Load all offers &amp; save</button></div>' +
    '<label><input type="checkbox" id="auto"> Auto-save on ' + site + ' pages with a known card</label>' +
    '<div class="s" id="st"></div></div><button class="mini" id="open" hidden>POcKEtMONey</button>';
  document.documentElement.appendChild(host);
  var $ = function (id) { return sh.getElementById(id); };
  function status(t, cls) { $('st').className = 's ' + (cls || ''); $('st').textContent = t; }
  function describe(r) {
    if (site === 'cardmarket') return '<b>' + r.found + '</b> Cardmarket offers on this page' + (r.idProduct ? ' · product ' + r.idProduct : '') + (r.more ? ' · more available' : '');
    if (site === 'ebay') return '<b>' + r.found + '</b> eBay ' + (r.sold ? 'sold' : 'for-sale') + ' items · ' + r.mp.replace('EBAY_', '') + (r.query ? ' · “' + r.query.replace(/</g, '') + '”' : '');
    return '<b>' + Object.keys(r.prices).filter(function (k) { return r.prices[k] != null; }).length + '</b> graded prices · <b>' + r.sold.length + '</b> sales';
  }
  function refreshFound() { var r = PARSE.parsePage(document, location); $('found').innerHTML = describe(r); $('all').hidden = !(site === 'cardmarket' && r.more); return r; }
  refreshFound();
  $('min').onclick = function () { $('p').hidden = true; $('open').hidden = false; };
  $('open').onclick = function () { $('p').hidden = false; $('open').hidden = true; };

  function showSuggestions(list) {
    $('sug').innerHTML = '';
    (list || []).forEach(function (c) {
      var b = document.createElement('button');
      b.innerHTML = '<b></b> <small></small>'; b.firstChild.textContent = c.name + (c.en && c.en !== c.name ? ' (' + c.en + ')' : '');
      b.lastChild.textContent = c.lang.toUpperCase() + ' · ' + c.set + ' · ' + c.number + ' · ' + c.id;
      b.onclick = function () { setCard(c.id); $('sug').innerHTML = ''; save(); };
      $('sug').appendChild(b);
    });
  }
  function setCard(id) { cardId = id; $('card').value = id; remember(id); }
  $('find').onclick = function () {
    var q = $('card').value.trim(); if (!q) return;
    status('Searching…');
    send('search', { q: q }).then(function (r) { status(r.status === 200 ? (r.data.length ? 'Pick the card:' : 'No card found for “' + q + '”') : r.data.error, r.status === 200 ? '' : 'err'); if (r.status === 200) showSuggestions(r.data); });
  };
  $('card').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('find').click(); });
  $('card').addEventListener('change', function () { var v = $('card').value.trim(); if (/^(ja:)?[A-Za-z0-9.\-_]+-[A-Za-z0-9.\-_]+$/.test(v)) cardId = v; });

  function save() {
    var r = refreshFound(), data = JSON.parse(JSON.stringify(Object.assign({}, r, { more: undefined })));
    status('Saving…'); $('save').disabled = true;
    return send('ingest', { payload: { site: site, url: location.href.split('#')[0], cardId: cardId, data: data, html: r.found ? undefined : document.documentElement.outerHTML.slice(0, 3e6) } }).then(function (res) {
      $('save').disabled = false;
      if (res.status === 200) { setCard(res.data.card.id); status('Saved ' + res.data.report + ' → ' + res.data.card.name + ' (' + res.data.card.set + ' ' + res.data.card.number + '). Data label: ' + res.data.coverage, 'ok'); }
      else if (res.status === 409) { status('Which card is this? Pick one, or search above.'); showSuggestions(res.data.suggestions); }
      else status(res.data.error || 'Failed (' + res.status + ')', 'err');
      return res.status === 200;
    });
  }
  $('save').onclick = save;

  // Cardmarket shows the first offers only: click its own "load more" button for you, at a calm pace, then save
  $('all').onclick = async function () {
    $('all').disabled = true; $('save').disabled = true;
    for (var i = 0; i < 40; i++) {
      var r = PARSE.cardmarket(document, location); if (!r.more) break;
      status('Loading more offers… ' + r.found + ' so far');
      var before = r.rowsSeen; r.more.click();
      for (var t = 0; t < 40 && PARSE.cardmarket(document, location).rowsSeen === before; t++) await new Promise(function (ok) { setTimeout(ok, 250); });
      await new Promise(function (ok) { setTimeout(ok, 1500 + Math.random() * 1500); });
    }
    $('all').disabled = false; save();
  };

  // card from the link, from an earlier pick, or from the page (Cardmarket product id / PriceCharting URL)
  chrome.storage.local.get([key, autoKey], function (st) {
    $('auto').checked = !!st[autoKey];
    $('auto').onchange = function () { var o = {}; o[autoKey] = $('auto').checked; chrome.storage.local.set(o); };
    if (cardId) remember(cardId); else cardId = st[key] || null;
    var ready = cardId ? Promise.resolve() : send('resolve', { params: site === 'cardmarket' && first.idProduct ? { cm: first.idProduct } : site === 'pricecharting' ? { pc: first.url } : {} })
      .then(function (r) { if (r && r.status === 200 && r.data.id) cardId = r.data.id; });
    ready.then(function () {
      if (cardId) { $('card').value = cardId; status('Card: ' + cardId); } else status('Search for the card once; it is remembered for this page.');
      if (st[autoKey] && cardId) setTimeout(save, 1200);
    });
  });
})();
