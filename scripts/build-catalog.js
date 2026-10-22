const fs=require('fs'),path=require('path'),zlib=require('zlib'),cp=require('child_process');
require(require('path').join(__dirname,'../src/core.js'));
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

// TCGplayer USD (English prints)
const tcg=JG(psv+'/cards.json.gz'); const usd=new Map();
for(const p of tcg){ if(!p.t||!p.pv) continue;
  let e=usd.get(p.t); if(!e){e={u:[],tp:p.id,uh:null};usd.set(p.t,e)}
  for(const v of p.pv){ if(v.mkt==null&&v.low==null) continue; e.u.push([v.v,r2(v.mkt),r2(v.low),r2(v.mid),r2(v.high)]); }
  if(e.uh==null&&p.px!=null){ e.uh=r2(p.px); const hv=p.pv.find(v=>v.mkt===p.px); if(hv) e.head=[p.id,hv.v]; }
}
// Cardmarket EUR (all European languages pooled)
const eur=new Map(); let guideDate='';
for(const f of fs.readdirSync(kz)){ const d=J(path.join(kz,f)); guideDate=d.guideDate||guideDate;
  for(const [id,vs] of Object.entries(d.cards)){ const list=[]; let cm=null;
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
  for(const [code,cm] of (r[F.variants]||[])){ if(!cm) continue; const row=cmRow.get(cm); if(!row) continue;
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
const data=JSON.stringify({v:2,commit:meta.built.slice(0,10)+'-v2',meta,setList,records});
fs.writeFileSync(out,data);
console.log({en:records.reduce((a,r)=>a+(r.id.startsWith('ja-')?0:r.c.length),0),nUsd,nEur,nLoc,nJa,nJaP,bytes:data.length,gz:zlib.gzipSync(data,{level:9}).length});
const cat=new PTCG.Catalog(setList,records);console.log(cat.stats);
const show=(q,f,s)=>{const r=cat.search(q,f||{},s);console.log(JSON.stringify(q),s||'',r.total,r.ms.toFixed(1)+'ms',r.ids.slice(0,4).map(i=>{const t=cat.cards[i];return t[1]+' ('+t[0]+') €'+cat.eur[i]+' $'+cat.usd[i]}).join(' | '))};
show('charizard base1');show('glurak');show('pikachu lang:ja');show('リザードン');show('',{currency:'eur'},'price');show('',{currency:'usd'},'price');show('price>500',{currency:'eur'});show('',{lang:'ja'},'price');
