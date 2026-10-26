const fs=require('fs'),path=require('path'),zlib=require('zlib'),cp=require('child_process');
require(require('path').join(__dirname,'../../src/core.js'));
const S=process.argv[2], out=process.argv[3];
const repo=S+'/repo', psv=S+'/psv/public/data', zy=S+'/probe/ZyzyThePizi_pokemon-price-data', kz=S+'/probe/kazant_pokedex-scanner-data/latest';
const J=f=>JSON.parse(fs.readFileSync(f)), JG=f=>JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
const r2=x=>x==null?null:Math.round(x*100)/100;
const PREF=['normal','holo','normal-unlimited','holo-unlimited','n','h'];
function headline(list,keys){ // list rows: [label, trend, low, ...]
  const order=list.map((x,i)=>i).sort((a,b)=>{const pa=PREF.indexOf(keys[a]),pb=PREF.indexOf(keys[b]);return (pa<0?99:pa)-(pb<0?99:pb)||a-b});
  for(const i of order) if(list[i][2]!=null&&list[i][1]!=null) return {v:list[i][1],thin:0,i};
  const i=order[0]; return {v:list[i][1]!=null?list[i][1]:list[i][2],thin:1,i};
}
const pretty=s=>s.replace(/^r:/,'reverse ').replace(/[-+:]/g,' ').replace(/\s+/g,' ').trim().replace(/^./,c=>c.toUpperCase());

// ---- English (pokemontcg ids) ----
const sets=J(repo+'/sets/en.json');
const records=sets.map(s=>({id:s.id,u:s.updatedAt,c:J(path.join(repo,'cards/en',s.id+'.json')).map(PTCG.compactCard)}));
const setList=sets.map(PTCG.compactSet);
// TCGdex ids, so the page can fetch live Cardmarket prices from api.tcgdex.net/v2/en/sets/<tx>/<number>.
// Sets match by name (plus the few named differently). Cards match by number; where TCGdex numbers a card differently
// (e.g. the Classic Collections), it is matched by name and the TCGdex number is stored in set.tn[card id].
const TX_FIX={base1:'base1',hgss1:'hgss1',hgss2:'hgss2',hgss3:'hgss3',hgss4:'hgss4',fut20:'fut2020',svp:'svp',sve:'sve',me55c:'30th-c'};
if(fs.existsSync(S+'/tcgdex-en.json')){
  const td=J(S+'/tcgdex-en.json');
  const sk=s=>String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/&/g,'and').replace(/[^a-z0-9]/g,'');
  const nk=n=>String(n).toLowerCase().replace(/^0+(?=.)/,'');
  const byName=new Map(); for(const s of td.sets){const k=sk(s.name); byName.set(k,byName.has(k)?null:s.id);}
  let nTx=0,nCards=0,nTn=0; const unmatched=[];
  for(const s of setList){ const tx=TX_FIX[s.id]||byName.get(sk(s.n)); if(!tx||!td.cards[tx]) continue; s.tx=tx; nTx++;
    const tcards=td.cards[tx], byNum=new Set(tcards.map(c=>nk(c[0]))), used=new Set();
    const cards=records.find(r=>r.id===s.id).c, rest=[];
    for(const t of cards){ if(byNum.has(nk(t[8]))){used.add(nk(t[8]));nCards++;} else rest.push(t); }
    for(const t of rest){ // same name (or one name a prefix of the other, e.g. "Palkia LV.X" / "Palkia"), first unused in order
      const n=sk(t[1]), c=tcards.find(c=>!used.has(nk(c[0]))&&sk(c[1])===n)||tcards.find(c=>!used.has(nk(c[0]))&&(sk(c[1]).startsWith(n)||n.startsWith(sk(c[1]))));
      if(c){ used.add(nk(c[0])); (s.tn=s.tn||{})[t[0]]=c[0]; nTn++; nCards++; } else { (s.tn=s.tn||{})[t[0]]=''; unmatched.push(t[0]); } // '' = not on TCGdex
    } }
  console.log('tcgdex: sets',nTx,'/',setList.length,'· cards',nCards,'(',nTn,'renumbered) · unmatched',unmatched.length,unmatched.slice(0,12).join(' '));
} else console.warn('no tcgdex-en.json: English cards get no live Cardmarket prices');

// Cardmarket and TCGplayer product ids per card, for the hourly collector (data/card-map.json.gz)
const cmIds=new Map(), tcgIds=new Map(); const addTo=(m,k,v)=>{ if(v==null) return; const a=m.get(k)||[]; if(!a.some(x=>JSON.stringify(x)===JSON.stringify(v))) a.push(v); m.set(k,a); };
// TCGplayer USD (English prints)
const tcg=JG(psv+'/cards.json.gz'); const usd=new Map();
for(const p of tcg){ if(p.t&&p.id&&p.set) addTo(tcgIds,p.t,[p.id,p.set]); if(!p.t||!p.pv) continue;
  let e=usd.get(p.t); if(!e){e={u:[],tp:p.id,uh:null};usd.set(p.t,e)}
  for(const v of p.pv){ if(v.mkt==null&&v.low==null) continue; e.u.push([v.v,r2(v.mkt),r2(v.low),r2(v.mid),r2(v.high)]); }
  if(e.uh==null&&p.px!=null){ e.uh=r2(p.px); const hv=p.pv.find(v=>v.mkt===p.px); if(hv) e.head=[p.id,hv.v]; }
}
// Cardmarket EUR (all European languages pooled)
const eur=new Map(); let guideDate='';
for(const f of fs.readdirSync(kz)){ const d=J(path.join(kz,f)); guideDate=d.guideDate||guideDate;
  for(const [id,vs] of Object.entries(d.cards)){ const list=[]; let cm=null; for(const [k,v] of Object.entries(vs)) if(v.idProduct) addTo(cmIds,id,[v.idProduct,pretty(k)]);
    for(const [k,v] of Object.entries(vs)){ if(v.trend==null&&v.low==null) continue; list.push([pretty(k),r2(v.trend),r2(v.low),r2(v.avg1),r2(v.avg7),r2(v.avg30)]); cm=cm||v.idProduct; }
    if(list.length){ const keys=Object.keys(vs).filter(k=>vs[k].trend!=null||vs[k].low!=null); const h=headline(list,keys); eur.set(id,{e:list,eh:h.v,et:h.thin,cm,hk:keys[h.i]}); }
  }}
// localized names
const content=JG(psv+'/content.json.gz');
let nUsd=0,nEur=0,nLoc=0;
for(const r of records) for(const t of r.c){
  const id=t[0], u=usd.get(id), e=eur.get(id), p={};
  if(u&&u.u.length){Object.assign(p,{u:u.u,uh:u.uh,tp:u.tp});nUsd++}
  if(e){Object.assign(p,{e:e.e,eh:e.eh,cm:e.cm});if(e.et)p.et=1;nEur++}
  if(Object.keys(p).length) t[21]=p;
  const c=content[id];
  if(c&&c.n){const nm={};for(const [l,v] of Object.entries(c.n)) if(l!=='en'&&v&&v!==t[1]) nm[l]=v; if(Object.keys(nm).length){t[23]=nm;nLoc++}}
}

// ---- Japanese (TCGdex) with Cardmarket EUR for Japanese products ----
const ja=J(zy+'/catalog/v2/cards-ja.json'), jsets=J(zy+'/catalog/v2/sets.json'), lat=J(zy+'/prices/latest.json');
const LF=Object.fromEntries(lat.fields.map((f,i)=>[f,i])); const cmRow=new Map(lat.rows.map(r=>[r[0],r]));
const dex=J(zy+'/catalog/pokedex.json'); const species=new Map(dex.rows.filter(r=>r[6]).map(r=>[r[0],r[2]]));
const SF=Object.fromEntries(jsets.fields.map((f,i)=>[f,i])), F=Object.fromEntries(ja.fields.map((f,i)=>[f,i]));
const jaSets=new Map();
for(const s of jsets.rows) if(s[SF.lang]==='ja') jaSets.set(s[SF.id],{id:'ja-'+s[SF.id],n:s[SF.name],ne:s[SF.nameEn]||'',se:s[SF.serieName]||'',pt:s[SF.official]||s[SF.total]||0,t:s[SF.total]||0,d:s[SF.releaseDate]||'',c:s[SF.id],lang:'ja'});
const VL={n:'Normal',h:'Holo',r:'Reverse holo',f:'1st Edition',p:'Promo'};
const jaRecs=new Map(), jaHead=[]; let nJa=0,nJaP=0;
const SUPER={Pokemon:'Pokémon',Trainer:'Trainer',Energy:'Energy'};
for(const r of ja.rows){ const set=jaSets.get(r[F.setId]); if(!set) continue;
  const list=[];
  for(const [code,cm] of (r[F.variants]||[])){ if(!cm) continue; { const b=code.split(/[:+]/)[0], rs=code.slice(b.length); addTo(cmIds,'ja:'+r[F.id],[cm,(VL[b]||b)+(rs?' '+pretty(rs).toLowerCase():'')]); } const row=cmRow.get(cm); if(!row) continue;
    let tr=row[LF.trend], lo=row[LF.low], a30=row[LF.avg30];
    if(tr==null&&lo==null){tr=row[LF.trendHolo];lo=row[LF.lowHolo];a30=row[LF.avg30Holo]}
    if(tr==null&&lo==null) continue;
    const base=code.split(/[:+]/)[0], rest=code.slice(base.length);
    list.push([(VL[base]||base)+(rest?' '+pretty(rest).toLowerCase():''),r2(tr),r2(lo),r2(row[LF.avg1]),r2(row[LF.avg7]),r2(a30),cm,rest?code:base]);
  }
  const img=r[F.image]; const imgc=!img?'':/^https?:/.test(img)?img:'t:'+img;
  const dexIds=r[F.dexIds]||[]; const alias=dexIds.map(d=>species.get(d)).filter(Boolean).join(' ');
  const t=[ 'ja:'+r[F.id], r[F.name], SUPER[r[F.category]]||r[F.category]||'', r[F.stage]?[r[F.stage].replace(/^Stage(\d)/,'Stage $1')]:[], r[F.hp]||0, r[F.types]||[], r[F.rarity]||'', r[F.illustrator]||'', r[F.localId]||'', dexIds, r[F.regulationMark]||'', imgc, '',
    (r[F.attacks]||[]).map(a=>[a,[], '', '']), (r[F.abilities]||[]).map(a=>['Ability',a,'']), [], [], [], 0, '', '' ];
  if(list.length){const h=headline(list,list.map(x=>x[7]));t[21]={e:list.map(x=>x.slice(0,6)),eh:h.v,cm:list[0][6]};if(h.thin)t[21].et=1;nJaP++;jaHead.push([t,list[h.i][6]])}
  t[22]='ja'; if(alias) t[24]=alias;
  if(!jaRecs.has(set.id)) jaRecs.set(set.id,[]); jaRecs.get(set.id).push(t); nJa++;
}
for(const [sid,cards] of jaRecs){ const s=[...jaSets.values()].find(x=>x.id===sid); setList.push(s); records.push({id:sid,u:'',c:cards}); }

// ---- price histories ----
const eurAxisSet=new Set(), eurSer=new Map(); // card tuple -> Map(date->val)
const kzH=S+'/probe/kazant_pokedex-scanner-data/history';
const enById=new Map(); for(const r of records) for(const t of r.c) enById.set(t[0],t);
for(const f of fs.readdirSync(kzH)){ const d=J(path.join(kzH,f));
  for(const [id,vs] of Object.entries(d.series)){ const e=eur.get(id), t=enById.get(id); if(!e||!t||!vs[e.hk]) continue;
    const m=new Map(); d.dates.forEach((dt,i)=>{const v=vs[e.hk][i]; if(v!=null){m.set(dt,v);eurAxisSet.add(dt)}}); eurSer.set(t,m); } }
const byShard=new Map(); for(const [t,cm] of jaHead){const k=cm%1000; if(!byShard.has(k)) byShard.set(k,[]); byShard.get(k).push([t,cm]);}
for(const [k,list] of byShard){ const sh=J(zy+'/history/'+k+'.json');
  for(const [t,cm] of list){ const rows=sh[String(cm)]; if(!rows) continue; const m=new Map();
    for(const r of rows){ if(r[0]<'2026-09-06') continue; const v=r[2]!=null?r[2]:r[7]; if(v!=null){m.set(r[0],v);eurAxisSet.add(r[0])} } eurSer.set(t,m); } }
const usdNeed=new Map(); for(const [id,u] of usd) if(u.head) usdNeed.set(u.head[0]+'|'+u.head[1], id);
const cdir=S+'/probe/Tbaker-maker_Catchem-data/data/history/tcgcsv-daily/raw'; const usdAxis=fs.readdirSync(cdir).sort(); const usdSer=new Map();
for(const day of usdAxis){ for(const line of zlib.gunzipSync(fs.readFileSync(path.join(cdir,day,'prices.ndjson.gz'))).toString().split('\n')){ if(!line) continue; const r=JSON.parse(line);
  const id=usdNeed.get(r.productId+'|'+r.subTypeName); if(!id||r.marketPrice==null) continue; if(!usdSer.has(id)) usdSer.set(id,new Map()); usdSer.get(id).set(day,r.marketPrice); } }
const eurAxis=[...eurAxisSet].sort();
function enc(m,axis){ const arr=axis.map(d=>m.has(d)?r2(m.get(d)):null); let st=0; while(st<arr.length&&arr[st]==null) st++; if(arr.length-st<2) return null; return [st].concat(arr.slice(st)); }
let nH=0;
for(const r of records) for(const t of r.c){ const h={}; const em=eurSer.get(t); if(em){const x=enc(em,eurAxis); if(x) h.e=x;} const um=usdSer.get(t[0]); if(um&&!t[0].startsWith('ja:')){const x=enc(um,usdAxis); if(x) h.u=x;}
  if(h.e||h.u){ while(t.length<25) t.push(t.length===21?null:t.length===22?(t[0].startsWith('ja:')?'ja':'en'):t.length===23?null:''); t[25]=h; nH++; } }
console.log('history cards',nH,'eurAxis',eurAxis.length,eurAxis[0],eurAxis[eurAxis.length-1],'usdAxis',usdAxis.length);
const meta={eurAxis,usdAxis,built:new Date().toISOString(), usdDate:J(psv+'/stats.json').pricesUpdated, eurDate:guideDate, jaEurDate:lat.sourceCreatedAt,
  sources:{cards:'PokemonTCG/pokemon-tcg-data',usd:'TCGplayer via tcgcsv.com (psvanzyl/pokemon-tcg)',eur:'Cardmarket price guide (kazant/pokedex-scanner-data)',ja:'TCGdex + Cardmarket (ZyzyThePizi/pokemon-price-data)',names:'TCGdex'}};
// Cardmarket/TCGplayer ids TCGdex knows for English cards the open sources don't map (scripts/build/fetch-tcgdex-products.js)
const tdxF=path.join(__dirname,'../../data/tcgdex-products.json');
if(fs.existsSync(tdxF)){ let n=0; for(const [id,x] of Object.entries(J(tdxF))) if(x.cm.length&&!(cmIds.get(id)||[]).length){ x.cm.forEach(v=>addTo(cmIds,id,v)); n++; } console.log('tcgdex product ids added for',n,'cards'); }

// ---- language bundles: the same card printed in several languages (and its same-art reprints) ----
// Two prints belong together when they share a Cardmarket metacard (Cardmarket's id for one card's text across all
// its products) and the illustrator, or, for Pokémon without a Cardmarket id, the same Pokédex numbers, name suffix
// (ex, V, GX…), HP, types and illustrator. When a group holds two prints in the same language (a regular and a
// full-art version by the same artist, say), it is split by rarity class. Only groups spanning two or more languages
// become bundles. Energy and unillustrated cards are left out.
const bundles=[];
{
  const metaOf=new Map(); const cmF=S+'/cm-products.json';
  if(fs.existsSync(cmF)) for(const p of J(cmF).products) metaOf.set(p.idProduct,p.idMetacard); else console.warn('no cm-products.json: bundles use the Pokémon rule only');
  const SUF=/(V-UNION|VMAX|VSTAR|LV\.X|BREAK|LEGEND|GX|EX|ex|V|δ|★|◇)$/;
  // rarity class, comparable across the English and Japanese rarity names; '?' = unknown
  const rclass=r=>{ r=String(r||'').toLowerCase();
    if(!r||r==='none'||r==='promo'||r==='classic collection') return '?';
    if(/secret|rainbow|hyper/.test(r)) return 'S';
    if(/shiny/.test(r)) return 'H';
    if(/illustration|character|trainer gallery/.test(r)) return 'I';
    if(/ultra/.test(r)) return 'U';
    return 'R'; };
  const parent=new Map(), find=x=>{ while(parent.get(x)!==x){ parent.set(x,parent.get(parent.get(x))); x=parent.get(x); } return x; };
  const owner=new Map(), lang=new Map(), rcl=new Map();
  const link=(id,key)=>{ if(!parent.has(id)) parent.set(id,id); if(owner.has(key)){ const a=find(owner.get(key)), b=find(id); if(a!==b) parent.set(a,b); } else owner.set(key,id); };
  for(const r of records) for(const t of r.c){
    const art=String(t[7]||'').toLowerCase().replace(/[^a-z0-9]/g,''); if(!art||t[2]==='Energy') continue;
    lang.set(t[0],t[22]||'en'); rcl.set(t[0],rclass(t[6]));
    let hasMeta=false;
    for(const [cm] of cmIds.get(t[0])||[]){ const m=metaOf.get(cm); if(m){ link(t[0],'m'+m+'|'+art); hasMeta=true; } }
    if(!hasMeta&&t[2]==='Pokémon'&&(t[9]||[]).length&&t[4]){ const suf=(String(t[1]).replace(/\s+/g,'').match(SUF)||[])[1]||''; link(t[0],'p'+t[9].join(',')+'|'+suf+'|'+t[4]+'|'+(t[5]||[]).join(',')+'|'+art); }
  }
  const groups=new Map(); for(const id of parent.keys()){ const k=find(id); if(!groups.has(k)) groups.set(k,[]); groups.get(k).push(id); }
  const crossLang=g=>g.length>1&&new Set(g.map(id=>lang.get(id))).size>1;
  for(const g of groups.values()){
    if(!crossLang(g)) continue;
    const perLang={}; g.forEach(id=>{ perLang[lang.get(id)]=(perLang[lang.get(id)]||0)+1; });
    let parts=[g];
    if(Math.max(...Object.values(perLang))>1){
      const by=new Map(); g.filter(id=>rcl.get(id)!=='?').forEach(id=>{ const c=rcl.get(id); if(!by.has(c)) by.set(c,[]); by.get(c).push(id); });
      parts=[...by.values()];
      // a print of unknown rarity joins only when that can't be wrong: a single part, and the only unknown print of its language
      const unk=g.filter(id=>rcl.get(id)==='?');
      if(parts.length===1) unk.forEach(id=>{ if(unk.filter(x=>lang.get(x)===lang.get(id)).length===1) parts[0].push(id); });
      if(!parts.length) parts=[g];
    }
    for(const p of parts) if(crossLang(p)) bundles.push(p.sort((a,b)=>(a.startsWith('ja:')-b.startsWith('ja:'))||(a<b?-1:1)));
  }
  console.log('language bundles:',bundles.length,'covering',bundles.reduce((a,g)=>a+g.length,0),'cards');
}
const data=JSON.stringify({v:2,commit:meta.built.slice(0,10)+'-v2',meta,setList,records,bundles});
fs.writeFileSync(out,data);

// card map for scripts/collect.js: [id, set id, name, number, printed total, lang, [[cardmarket id, variant]], [[tcgplayer id, group id]], other names, english name, set code, english set name]
const mapRows=[]; const setOf=new Map(setList.map(s=>[s.id,s]));
for(const r of records){ const st=setOf.get(r.id); if(!st) continue;
  for(const t of r.c) mapRows.push([t[0],r.id,t[1],String(t[8]||''),st.pt||0,t[22]||'en',cmIds.get(t[0])||[],tcgIds.get(t[0])||[],t[23]||null,t[24]||null,st.c||'',st.ne||st.n]); }
fs.writeFileSync(path.join(__dirname,'../../data/card-map.json.gz'),zlib.gzipSync(JSON.stringify({v:1,built:meta.built,cards:mapRows}),{level:9}));
console.log('card map:',mapRows.length,'cards,',mapRows.filter(x=>x[6].length).length,'with Cardmarket ids,',mapRows.filter(x=>x[7].length).length,'with TCGplayer ids');
console.log({en:records.reduce((a,r)=>a+(r.id.startsWith('ja-')?0:r.c.length),0),nUsd,nEur,nLoc,nJa,nJaP,bytes:data.length,gz:zlib.gzipSync(data,{level:9}).length});
const cat=new PTCG.Catalog(setList,records);console.log(cat.stats);
const show=(q,f,s)=>{const r=cat.search(q,f||{},s);console.log(JSON.stringify(q),s||'',r.total,r.ms.toFixed(1)+'ms',r.ids.slice(0,4).map(i=>{const t=cat.cards[i];return t[1]+' ('+t[0]+') €'+cat.eur[i]+' $'+cat.usd[i]}).join(' | '))};
show('charizard base1');show('glurak');show('pikachu lang:ja');show('リザードン');show('',{currency:'eur'},'price');show('',{currency:'usd'},'price');show('price>500',{currency:'eur'});show('',{lang:'ja'},'price');
