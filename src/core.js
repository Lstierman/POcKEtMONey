/* Pokémon card catalog core: compact storage + bitmap/inverted index search.
   Shared by the page and the Node build script. */
(function (root) {
  'use strict';

  // ---------- compact storage format ----------
  // Each card is stored as a positional tuple (no repeated key names):
  // [id, name, supertype, subtypes, hp, types, rarity, artist, number, dex[], regMark,
  //  img, evolvesFrom, attacks, abilities, rules, weaknesses, resistances, retreat, flavor, legal]
  var P_IMG = 'https://images.pokemontcg.io/';
  var X_IMG = 'https://images.scrydex.com/pokemon/';

  function encImg(u) {
    if (!u) return '';
    if (u.indexOf(P_IMG) === 0) return 'p:' + u.slice(P_IMG.length);
    if (u.indexOf(X_IMG) === 0) return 'x:' + u.slice(X_IMG.length);
    return u;
  }
  function imgUrls(code) {
    if (!code) return null;
    if (code.slice(0, 2) === 'p:') { var r = code.slice(2); return { small: P_IMG + r, large: P_IMG + r.replace(/\.png$/, '_hires.png') }; }
    if (code.slice(0, 2) === 'x:') { var s = code.slice(2); return { small: X_IMG + s, large: X_IMG + s.replace(/\/small$/, '/large') }; }
    if (code.slice(0, 2) === 't:') { var d = 'https://assets.tcgdex.net/' + code.slice(2); return { small: d + '/low.webp', large: d + '/high.webp' }; }
    return { small: code, large: code };
  }

  function compactCard(c) {
    var lg = c.legalities || {}, legal = '';
    if (lg.standard === 'Legal') legal += 'S';
    if (lg.expanded === 'Legal') legal += 'E';
    if (lg.unlimited === 'Legal') legal += 'U';
    var t = [
      c.id, c.name, c.supertype || '', c.subtypes || [], c.hp ? parseInt(c.hp, 10) || 0 : 0,
      c.types || [], c.rarity || '', c.artist || '', c.number || '', c.nationalPokedexNumbers || [],
      c.regulationMark || '', encImg(c.images && c.images.small), c.evolvesFrom || '',
      (c.attacks || []).map(function (a) { return [a.name || '', a.cost || [], a.damage || '', a.text || '']; }),
      (c.abilities || []).map(function (a) { return [a.type || '', a.name || '', a.text || '']; }),
      c.rules || [],
      (c.weaknesses || []).map(function (w) { return [w.type, w.value]; }),
      (c.resistances || []).map(function (w) { return [w.type, w.value]; }),
      c.convertedRetreatCost || 0, c.flavorText || '', legal
    ];
    // trim trailing empties to save space
    while (t.length > 9) {
      var v = t[t.length - 1];
      if (v === '' || v === 0 || (Array.isArray(v) && v.length === 0)) t.pop(); else break;
    }
    return t;
  }

  function compactSet(s) {
    return { id: s.id, n: s.name, se: s.series || '', pt: s.printedTotal || s.total || 0, t: s.total || 0,
      d: (s.releaseDate || '').replace(/\//g, '-'), c: s.ptcgoCode || '', u: s.updatedAt || '' };
  }

  function expand(t) {
    return {
      id: t[0], name: t[1], supertype: t[2] || '', subtypes: t[3] || [], hp: t[4] || 0, types: t[5] || [],
      rarity: t[6] || '', artist: t[7] || '', number: t[8] || '', dex: t[9] || [], reg: t[10] || '',
      img: t[11] || '', evolvesFrom: t[12] || '', attacks: t[13] || [], abilities: t[14] || [], rules: t[15] || [],
      weaknesses: t[16] || [], resistances: t[17] || [], retreat: t[18] || 0, flavor: t[19] || '', legal: t[20] || '',
      price: t[21] || null, lang: t[22] || 'en', names: t[23] || null, alias: t[24] || '', hist: t[25] || null, sales: t[26] || null
    };
  }

  // ---------- text normalisation ----------
  function norm(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC').toLowerCase()
      .replace(/[’']/g, '').replace(/♀/g, ' f').replace(/♂/g, ' m');
  }
  var TOKEN_RE = (function () { try { return new RegExp('[\\p{L}\\p{N}]+', 'gu'); } catch (e) { return /[a-z0-9]+/g; } })();
  function tokens(s) {
    if (!s) return [];
    var m = norm(s).match(TOKEN_RE);
    return m || [];
  }

  // ---------- bitmaps ----------
  function popcount32(x) { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; }
  function popcount(b) { var n = 0; for (var i = 0; i < b.length; i++) if (b[i]) n += popcount32(b[i]); return n; }
  function andInto(a, b) { for (var i = 0; i < a.length; i++) a[i] &= b[i]; return a; }
  function orInto(a, b) { for (var i = 0; i < a.length; i++) a[i] |= b[i]; return a; }
  function andNotInto(a, b) { for (var i = 0; i < a.length; i++) a[i] &= ~b[i]; return a; }
  function bitsToIds(b, n) {
    var out = new Uint32Array(popcount(b)), k = 0;
    for (var i = 0; i < b.length; i++) {
      var w = b[i];
      while (w) { var t = w & -w; out[k++] = (i << 5) + (31 - Math.clz32(t)); w ^= t; }
    }
    return out;
  }

  // ---------- inverted index ----------
  function IndexBuilder() { this.map = new Map(); }
  IndexBuilder.prototype.add = function (term, id) {
    var e = this.map.get(term);
    if (!e) { e = [id]; this.map.set(term, e); }
    else if (e[e.length - 1] !== id) e.push(id);
  };
  IndexBuilder.prototype.finish = function () {
    var terms = Array.from(this.map.keys()).sort();
    var post = new Array(terms.length), total = 0;
    for (var i = 0; i < terms.length; i++) { post[i] = Uint32Array.from(this.map.get(terms[i])); total += post[i].length; }
    this.map = null;
    return { terms: terms, post: post, postings: total };
  };
  function lowerBound(arr, x) { var lo = 0, hi = arr.length; while (lo < hi) { var m = (lo + hi) >>> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }

  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = new Array(b.length + 1), cur = new Array(b.length + 1);
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      cur[0] = i; var best = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[b.length];
  }

  // ---------- catalog ----------
  var TYPE_ORDER = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Fairy', 'Dragon', 'Colorless'];

  function Catalog(setList, records) {
    var t0 = now();
    var sets = setList.slice().sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : (a.id < b.id ? -1 : 1); });
    var setById = new Map();
    sets.forEach(function (s, i) { s.ix = i; setById.set(s.id, s); });
    records = records.filter(function (r) { return setById.has(r.id); })
      .sort(function (a, b) { return setById.get(a.id).ix - setById.get(b.id).ix; });

    var N = 0; records.forEach(function (r) { N += r.c.length; });
    var W = (N + 31) >>> 5;
    this.N = N; this.W = W; this.sets = sets; this.setById = setById;
    this.cards = new Array(N);
    this.setIx = new Uint16Array(N);
    this.hp = new Uint16Array(N);
    this.numKey = new Float64Array(N);
    this.nameNorm = new Array(N);
    this.dex = new Array(N);
    this.eur = new Float32Array(N).fill(NaN);
    this.usd = new Float32Array(N).fill(NaN);
    this.chg = { eur: new Float32Array(N).fill(NaN), usd: new Float32Array(N).fill(NaN), any: new Float32Array(N).fill(NaN) };
    this.priced = new Uint32Array(W); // one bit per card with any price data
    this.cov = new Uint8Array(N); // data score in 0.05 steps, 0..20 (src/prices.js dataScore), set by the page
    this.covBits = []; for (var cb = 0; cb <= 20; cb++) this.covBits.push(new Uint32Array(W));
    function med(a) { var b = a.slice().sort(function (x, y) { return x - y; }); return b.length ? b[b.length >> 1] : NaN; }
    function change(h) { // h = [startIdx, v...]; robust % change: median of last 3 vs median of 3 points a week earlier
      if (!h) return NaN; var v = h.slice(1).filter(function (x) { return x != null; });
      if (v.length < 10) return NaN; var m = med(v);
      v = v.filter(function (x) { return x > m / 8 && x < m * 8; });
      if (v.length < 10) return NaN;
      var last = med(v.slice(-3)), prev = med(v.slice(-10, -7));
      return prev >= 1 ? (last - prev) / prev * 100 : NaN;
    }

    var facets = this.facets = { lang: new Map(), type: new Map(), supertype: new Map(), subtype: new Map(), rarity: new Map(), set: new Map(), series: new Map(), reg: new Map(), legal: new Map() };
    function fac(map, v, id) { if (!v) return; var b = map.get(v); if (!b) { b = new Uint32Array(W); map.set(v, b); } b[id >>> 5] |= (1 << (id & 31)) >>> 0; }

    var ix = { all: new IndexBuilder(), name: new IndexBuilder(), artist: new IndexBuilder(), set: new IndexBuilder(), attack: new IndexBuilder(), rarity: new IndexBuilder() };
    function addText(b, s, id, extra) { var tk = tokens(s); for (var i = 0; i < tk.length; i++) { b.add(tk[i], id); if (extra) extra.add(tk[i], id); } return tk; }

    var id = 0;
    for (var r = 0; r < records.length; r++) {
      var rec = records[r], set = setById.get(rec.id);
      var setToks = [norm(set.id)].concat(set.c ? [norm(set.c)] : [], tokens(set.n), tokens(set.se), tokens(set.ne || ''));
      for (var k = 0; k < rec.c.length; k++, id++) {
        var t = rec.c[k];
        this.cards[id] = t;
        this.setIx[id] = set.ix;
        this.hp[id] = t[4] || 0;
        this.nameNorm[id] = norm(t[1]);
        this.dex[id] = t[9] || null;
        var num = String(t[8] || ''), m = /^(\D*)(\d+)(.*)$/.exec(num);
        this.numKey[id] = m ? (m[1] ? 50000 + (m[1].charCodeAt(0) % 64) * 500 : 0) + parseInt(m[2], 10) + (m[3] ? 0.5 : 0) : 99999;

        var pr = t[21];
        if (pr) { if (pr.eh != null && !pr.et) this.eur[id] = pr.eh; if (pr.uh != null) this.usd[id] = pr.uh; }
        if ((pr && (pr.eh != null || pr.uh != null)) || t[26]) this.priced[id >>> 5] |= (1 << (id & 31)) >>> 0;
        this.covBits[0][id >>> 5] |= (1 << (id & 31)) >>> 0;
        if (t[25]) { this.chg.eur[id] = change(t[25].e); this.chg.usd[id] = change(t[25].u); this.chg.any[id] = isNaN(this.chg.eur[id]) ? this.chg.usd[id] : this.chg.eur[id]; }
        fac(facets.lang, t[22] || 'en', id);
        if (t[26]) fac(facets.legal, 'sales', id);
        (t[5] || []).forEach(function (v) { fac(facets.type, v, id); });
        fac(facets.supertype, t[2], id);
        (t[3] || []).forEach(function (v) { fac(facets.subtype, v, id); });
        fac(facets.rarity, t[6] || 'Unspecified', id);
        fac(facets.set, set.id, id);
        fac(facets.series, set.se, id);
        fac(facets.reg, t[10], id);
        var lg = t[20] || '';
        if (lg.indexOf('S') >= 0) fac(facets.legal, 'standard', id);
        if (lg.indexOf('E') >= 0) fac(facets.legal, 'expanded', id);

        var nt = addText(ix.name, t[1], id, ix.all);
        if (nt.length > 1) { ix.name.add(nt.join(''), id); ix.all.add(nt.join(''), id); }
        if (t[23]) for (var ln in t[23]) addText(ix.name, t[23][ln], id, ix.all);
        if (t[24]) addText(ix.name, t[24], id, ix.all);
        addText(ix.artist, t[7], id, ix.all);
        var nb = String(t[8] || '').replace(/^0+(?=\d)/, ''); if (nb) ix.all.add(norm(nb), id);
        addText(ix.rarity, t[6], id, ix.all);
        for (var s2 = 0; s2 < setToks.length; s2++) { ix.set.add(setToks[s2], id); ix.all.add(setToks[s2], id); }
        addText(ix.all, t[2], id);
        (t[3] || []).forEach(function (v) { addText(ix.all, v, id); });
        (t[5] || []).forEach(function (v) { addText(ix.all, v, id); });
        addText(ix.all, t[12], id);
        (t[13] || []).forEach(function (a) { addText(ix.attack, a[0], id, ix.all); addText(ix.all, a[3], id); });
        (t[14] || []).forEach(function (a) { addText(ix.attack, a[1], id, ix.all); addText(ix.all, a[2], id); });
        (t[15] || []).forEach(function (v) { addText(ix.all, v, id); });
        addText(ix.all, t[19], id);
      }
    }
    this.ix = {};
    var terms = 0, postings = 0;
    for (var key in ix) { this.ix[key] = ix[key].finish(); terms += this.ix[key].terms.length; postings += this.ix[key].postings; }
    this.cache = new Map();
    this.stats = { cards: N, sets: sets.length, terms: this.ix.all.terms.length, postings: postings, buildMs: now() - t0 };
  }

  // the page's price model decided a card's headline (in EUR and USD, null when unknown), its data score bucket 0..20
  // and whether any price data is known
  Catalog.prototype.setValue = function (id, eur, usd, cov, known) {
    this.eur[id] = eur == null ? NaN : eur; this.usd[id] = usd == null ? NaN : usd;
    var w = id >>> 5, bit = (1 << (id & 31)) >>> 0, old = this.cov[id];
    if (old !== cov) { this.covBits[old][w] &= ~bit; this.covBits[cov][w] |= bit; this.cov[id] = cov; }
    if (known) this.priced[w] |= bit; else this.priced[w] &= ~bit;
  };
  Catalog.prototype.isPriced = function (id) { return ((this.priced[id >>> 5] >>> (id & 31)) & 1) === 1; };

  // union of postings for every term starting with `prefix`
  Catalog.prototype.prefixBits = function (field, prefix, exact) {
    var ck = field + '\u0000' + prefix + (exact ? '=' : '');
    var hit = this.cache.get(ck);
    if (hit) { this.cache.delete(ck); this.cache.set(ck, hit); return hit; }
    var idx = this.ix[field], b = new Uint32Array(this.W), i = lowerBound(idx.terms, prefix), n = 0;
    for (; i < idx.terms.length && idx.terms[i].lastIndexOf(prefix, 0) === 0; i++) {
      if (exact && idx.terms[i] !== prefix) break;
      var p = idx.post[i]; n++;
      for (var j = 0; j < p.length; j++) b[p[j] >>> 5] |= (1 << (p[j] & 31)) >>> 0;
    }
    var res = { bits: b, terms: n };
    this.cache.set(ck, res);
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    return res;
  };

  Catalog.prototype.fuzzy = function (field, tok) {
    var idx = this.ix[field], max = tok.length >= 7 ? 2 : 1, found = [];
    for (var i = 0; i < idx.terms.length && found.length < 40; i++) {
      var term = idx.terms[i];
      if (term.length < tok.length - max) continue;
      var d = editDistance(tok, term, max);
      if (d > 1 && term.length > tok.length + 1) d = Math.max(1, editDistance(tok, term.slice(0, tok.length), 1)) + 0.5;
      if (d <= max) found.push([d, term]);
    }
    found.sort(function (a, b) { return a[0] - b[0]; });
    if (found.length) { var bestD = found[0][0]; found = found.filter(function (x) { return x[0] === bestD; }); }
    var b = new Uint32Array(this.W);
    for (var f = 0; f < found.length; f++) {
      var p = idx.post[lowerBound(idx.terms, found[f][1])];
      for (var j = 0; j < p.length; j++) b[p[j] >>> 5] |= (1 << (p[j] & 31)) >>> 0;
    }
    return { bits: b, best: found.length ? found[0][1] : null };
  };

  var FIELD_ALIAS = { name: 'name', n: 'name', artist: 'artist', a: 'artist', illus: 'artist', set: 'set', s: 'set', attack: 'attack', move: 'attack', ability: 'attack', rarity: 'rarity', r: 'rarity', text: 'all' };

  function parseQuery(q) {
    var re = /(-?)(?:([a-z]+)(:|>=|<=|>|<|=))?(?:"([^"]*)"?|(\S+))/gi, m, out = [];
    while ((m = re.exec(q))) {
      if (!m[0]) { re.lastIndex++; continue; }
      out.push({ neg: m[1] === '-', field: m[2] ? m[2].toLowerCase() : null, op: m[3] || null, value: m[4] != null ? m[4] : m[5] || '', raw: m[0] });
    }
    return out;
  }

  // q: query string; f: { type:Set, supertype:'', rarity:'', set:'', series:'', reg:Set, legal:Set }, sort
  Catalog.prototype.search = function (q, f, sort) {
    var t0 = now(), W = this.W, self = this;
    var bits = new Uint32Array(W).fill(0xFFFFFFFF);
    if (this.N & 31) bits[W - 1] = (1 << (this.N & 31)) - 1 >>> 0;
    var notes = [], plain = [], numeric = [], hasText = false;

    parseQuery(q || '').forEach(function (p) {
      var field = p.field, op = p.op;
      if (field === 'score' && /^(0?\.\d+|1(\.0+)?|0)$/.test(p.value)) { // score>=0.5: compared in the engine's 0.05 steps
        numeric.push({ k: 'score', op: op === ':' ? '>=' : op, v: Math.round(+p.value * 20), neg: p.neg }); return;
      }
      if (field && (field === 'hp' || field === 'dex' || field === 'no' || field === 'number') && /^\d+$/.test(p.value)) {
        numeric.push({ k: field === 'number' ? 'no' : field, op: op === ':' ? '=' : op, v: +p.value, neg: p.neg }); return;
      }
      if (field && (field === 'price' || field === 'eur' || field === 'usd') && op && /^\d+(\.\d+)?$/.test(p.value)) {
        numeric.push({ k: field === 'price' ? (f && f.currency) || 'eur' : field, op: op === ':' ? '>=' : op, v: +p.value, neg: p.neg }); return;
      }
      if (field === 'has' && /^pric/i.test(p.value)) { (p.neg ? andNotInto : andInto)(bits, self.priced); return; }
      if (field === 'has' && /^(sales|sold|graded|psa)/i.test(p.value)) {
        var sb = self.facets.legal.get('sales') || new Uint32Array(W); (p.neg ? andNotInto : andInto)(bits, sb); return;
      }
      if (field === 'lang' || field === 'language') {
        var lv = /^j/i.test(p.value) ? 'ja' : 'en';
        if (self.facets.lang.get(lv)) { (p.neg ? andNotInto : andInto)(bits, self.facets.lang.get(lv)); return; }
      }
      if (field === 'type' || field === 't') {
        var ty = TYPE_ORDER.filter(function (x) { return norm(x).indexOf(norm(p.value)) === 0; })[0];
        if (ty && self.facets.type.get(ty)) { (p.neg ? andNotInto : andInto)(bits, self.facets.type.get(ty)); return; }
      }
      if (field === 'reg' && self.facets.reg.get(p.value.toUpperCase())) { andInto(bits, self.facets.reg.get(p.value.toUpperCase())); return; }
      var target = field && op === ':' && FIELD_ALIAS[field] ? FIELD_ALIAS[field] : 'all';
      var value = target === 'all' && field && !FIELD_ALIAS[field] ? p.raw.replace(/^-/, '') : p.value;
      var tk = tokens(value);
      if (!tk.length) return;
      hasText = true;
      tk.forEach(function (tok) {
        var r = self.prefixBits(target, tok);
        var b = r.bits, used = tok;
        if (!r.terms && !p.neg && tok.length >= 4) {
          var fz = self.fuzzy(target, tok);
          if (fz.best) { notes.push({ from: tok, to: fz.best }); b = fz.bits; used = fz.best; }
        }
        if (p.neg) andNotInto(bits, b); else andInto(bits, b);
        if (!p.neg && target === 'all') plain.push(used);
      });
    });

    if (numeric.length) {
      for (var i = 0; i < W; i++) {
        var w = bits[i];
        while (w) {
          var t = w & -w, id = (i << 5) + (31 - Math.clz32(t)); w ^= t;
          for (var n = 0; n < numeric.length; n++) {
            var c = numeric[n], vals;
            if (c.k === 'hp') vals = [this.hp[id]];
            else if (c.k === 'dex') vals = this.dex[id] || [];
            else if (c.k === 'score') vals = [this.cov[id]];
            else if (c.k === 'eur' || c.k === 'usd') vals = isNaN(this[c.k][id]) ? [] : [this[c.k][id]];
            else vals = [this.numKey[id]];
            var ok = vals.some(function (x) { return c.op === '>' ? x > c.v : c.op === '<' ? x < c.v : c.op === '>=' ? x >= c.v : c.op === '<=' ? x <= c.v : x === c.v; });
            if (c.k === 'hp' && !this.hp[id]) ok = false;
            if (ok === c.neg) { bits[i] &= ~t; break; }
          }
        }
      }
    }

    // facets — keep a copy before each disjunctive facet for live counts
    f = f || {};
    function orOf(map, values) {
      var b = new Uint32Array(W);
      values.forEach(function (v) { var x = map.get(v); if (x) orInto(b, x); });
      return b;
    }
    if (f.lang) andInto(bits, this.facets.lang.get(f.lang) || new Uint32Array(W));
    var single = [['supertype', f.supertype], ['rarity', f.rarity], ['set', f.set], ['series', f.series]];
    var afterOthers = bits; // bits without type & supertype facets, for counts
    var withoutType = null, withoutSuper = null;
    var typeSel = f.type && f.type.size ? orOf(this.facets.type, f.type) : null;
    var superSel = f.supertype ? (this.facets.supertype.get(f.supertype) || new Uint32Array(W)) : null;
    single.forEach(function (s) { if (s[1] && s[0] !== 'supertype') andInto(bits, self.facets[s[0]].get(s[1]) || new Uint32Array(W)); });
    if (f.reg && f.reg.size) andInto(bits, orOf(this.facets.reg, f.reg));
    if (f.legal && f.legal.size) f.legal.forEach(function (v) { andInto(bits, self.facets.legal.get(v) || new Uint32Array(W)); });
    var allPriced = typeSel ? andInto(bits.slice(), typeSel) : bits.slice();
    if (superSel) andInto(allPriced, superSel);
    var covCounts = this.covBits.map(function (b) { return popcount(andInto(allPriced.slice(), b)); });
    var nAll = popcount(allPriced), nKnown = popcount(andInto(allPriced, this.priced));
    if (f.priced === 'yes') andInto(bits, this.priced); else if (f.priced === 'no') andNotInto(bits, this.priced);
    if (f.cov) { // minimum data score, in 0.05 steps (1..20)
      var cs = new Uint32Array(W); for (var ck = +f.cov; ck <= 20; ck++) orInto(cs, this.covBits[ck]); andInto(bits, cs);
    }
    withoutType = superSel ? andInto(bits.slice(), superSel) : bits.slice();
    withoutSuper = typeSel ? andInto(bits.slice(), typeSel) : bits.slice();
    if (typeSel) andInto(bits, typeSel);
    if (superSel) andInto(bits, superSel);

    var counts = { type: {}, supertype: {}, priced: { yes: nKnown, no: nAll - nKnown }, cov: covCounts };
    this.facets.type.forEach(function (b, k) { counts.type[k] = popcount(andInto(withoutType.slice(), b)); });
    this.facets.supertype.forEach(function (b, k) { counts.supertype[k] = popcount(andInto(withoutSuper.slice(), b)); });

    var ids = bitsToIds(bits, this.N);

    // ranking
    var setIx = this.setIx, numKey = this.numKey, hp = this.hp, nameNorm = this.nameNorm, cards = this.cards;
    var mode = sort || 'relevance';
    if (mode === 'relevance' && !hasText) mode = 'newest';
    var arr = Array.from(ids);
    if (mode === 'relevance') {
      var nameBits = null;
      plain.forEach(function (tok) { var b = self.prefixBits('name', tok).bits; nameBits = nameBits ? andInto(nameBits.slice(), b) : b; });
      var phrase = plain.join(' ');
      var score = new Float64Array(this.N);
      for (var a = 0; a < arr.length; a++) {
        var x = arr[a], s = 0;
        if (nameBits && (nameBits[x >>> 5] >>> (x & 31)) & 1) {
          s += 100;
          var nn = nameNorm[x];
          if (nn === phrase) s += 80; else if (nn.lastIndexOf(phrase, 0) === 0) s += 50;
          s -= nn.length * 0.2;
        }
        score[x] = s;
      }
      arr.sort(function (p, q2) { return score[q2] - score[p] || setIx[q2] - setIx[p] || numKey[p] - numKey[q2]; });
    } else if (mode === 'newest') {
      arr.sort(function (p, q2) { return setIx[q2] - setIx[p] || numKey[p] - numKey[q2]; });
    } else if (mode === 'oldest') {
      arr.sort(function (p, q2) { return setIx[p] - setIx[q2] || numKey[p] - numKey[q2]; });
    } else if (mode === 'name') {
      arr.sort(function (p, q2) { return nameNorm[p] < nameNorm[q2] ? -1 : nameNorm[p] > nameNorm[q2] ? 1 : setIx[q2] - setIx[p]; });
    } else if (mode === 'price' || mode === 'priceAsc') {
      var px = f.currency === 'usd' ? this.usd : this.eur, dir = mode === 'price' ? 1 : -1;
      arr.sort(function (p, q2) {
        var a1 = px[p], b1 = px[q2], na = isNaN(a1), nb = isNaN(b1);
        if (na || nb) return na === nb ? setIx[q2] - setIx[p] : na ? 1 : -1;
        return dir * (b1 - a1) || setIx[q2] - setIx[p];
      });
    } else if (mode === 'rising' || mode === 'falling') {
      var ch = this.chg.any, pv = this.eur, sg = mode === 'rising' ? 1 : -1; // % change is currency-independent
      arr = arr.filter(function (x) { return !isNaN(ch[x]) && pv[x] >= 2; });
      arr.sort(function (p, q2) { return sg * (ch[q2] - ch[p]) || pv[q2] - pv[p]; });
    } else if (mode === 'hp') {
      arr.sort(function (p, q2) { return hp[q2] - hp[p] || setIx[q2] - setIx[p]; });
    }
    return { ids: arr, total: arr.length, ms: now() - t0, notes: notes, counts: counts };
  };

  // ---------- live price responses ----------
  // Both return the same shapes the build stores in t[21], plus `at` (the source's own update time, ISO), or null.
  function pos(x) { return typeof x === 'number' && x > 0 ? Math.round(x * 100) / 100 : null; }
  function words(s) { return String(s).replace(/-/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }

  // api.tcgdex.net card: Cardmarket EUR per variant. Cardmarket's "-holo" fields are the reverse-holo copies.
  var TD_TYPE = { normal: 'Normal', holo: 'Holo', reverse: 'Reverse holo' };
  function liveFromTcgdex(card) {
    var vs = (card && card.variants_detailed) || [], rows = [], seen = {}, at = '';
    var hasReverse = !!(card && card.variants && card.variants.reverse);
    // many cards carry the price only at card level, not on their variants
    if (!vs.some(function (v) { return v.pricing && v.pricing.cardmarket; }) && card && card.pricing && card.pricing.cardmarket)
      vs = [{ type: card.variants && card.variants.holo && !card.variants.normal ? 'holo' : 'normal', pricing: card.pricing }];
    vs.forEach(function (v) {
      var cm = v.pricing && v.pricing.cardmarket; if (!cm || seen[cm.idProduct]) return; seen[cm.idProduct] = 1;
      var stamp = (v.stamp || []).indexOf('1st-edition') >= 0 ? '1st Edition ' : '';
      var base = TD_TYPE[v.type] || words(v.type || 'normal'), label = stamp ? stamp + base.toLowerCase() : base;
      if (v.subtype) label += ' ' + String(v.subtype).replace(/-/g, ' ');
      var main = [label, pos(cm.trend), pos(cm.low), pos(cm.avg1), pos(cm.avg7), pos(cm.avg30)];
      if (main[1] != null || main[2] != null) rows.push(main);
      var rh = ['Reverse holo' + (stamp ? ' (' + stamp.trim().toLowerCase() + ')' : ''), pos(cm['trend-holo']), pos(cm['low-holo']), pos(cm['avg1-holo']), pos(cm['avg7-holo']), pos(cm['avg30-holo'])];
      if (hasReverse && v.type !== 'holo' && (rh[1] != null || rh[2] != null)) rows.push(rh);
      if (cm.updated > at) at = cm.updated;
    });
    if (!rows.length) return null;
    // headline: the plain print first (no 1st Edition, no reverse), and only a row with both a trend and a low counts as solid
    var order = rows.map(function (r, i) { return i; }).sort(function (a, b) { return rank(rows[a][0]) - rank(rows[b][0]) || a - b; });
    function rank(l) { return /^1st/.test(l) ? 2 : /^Reverse/.test(l) ? 1 : 0; }
    for (var i = 0; i < order.length; i++) { var r = rows[order[i]]; if (r[1] != null && r[2] != null) return { e: rows, eh: r[1], cm: card.pricing && card.pricing.cardmarket ? card.pricing.cardmarket.idProduct : null, at: at }; }
    var h = rows[order[0]];
    return { e: rows, eh: h[1] != null ? h[1] : h[5] != null ? h[5] : h[2], et: 1, at: at };
  }

  // api.pokemontcg.io card (select=id,tcgplayer): TCGplayer USD per finish
  var PT_PREF = ['normal', 'holofoil', 'unlimitedHolofoil', 'unlimitedNormal', '1stEditionHolofoil', '1stEditionNormal', 'reverseHolofoil'];
  function liveFromPtcgio(card) {
    var tp = card && card.tcgplayer, pr = tp && tp.prices; if (!pr) return null;
    var keys = Object.keys(pr).sort(function (a, b) { var x = PT_PREF.indexOf(a), y = PT_PREF.indexOf(b); return (x < 0 ? 99 : x) - (y < 0 ? 99 : y); });
    var rows = [], uh = null;
    keys.forEach(function (k) {
      var v = pr[k] || {}, row = [k.replace(/^1st/, '1st ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, function (c) { return c.toUpperCase(); }), pos(v.market), pos(v.low), pos(v.mid), pos(v.high)];
      if (row[1] == null && row[2] == null) return;
      rows.push(row); if (uh == null && row[1] != null) uh = row[1];
    });
    if (!rows.length) return null;
    return { u: rows, uh: uh, at: String(tp.updatedAt || '').replace(/\//g, '-') };
  }

  function now() { return (typeof performance !== 'undefined' ? performance : Date).now(); }

  root.PTCG = { compactCard: compactCard, compactSet: compactSet, expand: expand, imgUrls: imgUrls, Catalog: Catalog, tokens: tokens, norm: norm, TYPE_ORDER: TYPE_ORDER, parseQuery: parseQuery,
    liveFromTcgdex: liveFromTcgdex, liveFromPtcgio: liveFromPtcgio };
})(typeof window !== 'undefined' ? window : globalThis);
