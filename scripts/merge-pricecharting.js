const fs=require('fs');
const out=new Map();
const norm=(id,pc,o)=>{
  const t=out; const num=(id.split('-').pop()||'').replace(/^0+/,'').toLowerCase();
  const p=o.prices||{}; const g=['ungraded','grade7','grade8','grade9','grade9_5','psa10'].map(k=>p[k]==null?null:+p[k]);
  const s=(o.sold||[]).map(r=>{let [d,gr,ti,pr,u]=r; if(gr==null||gr===''||/^ungraded$/i.test(gr)) gr='Ungraded'; else if(typeof gr==='number'||/^\d/.test(gr)) gr='Graded '+gr; else gr=String(gr).replace(/^Grade /,'Graded ');
    if(u){const m=/tcgplayer\.com%2Fproduct%2F(\d+)/.exec(u); if(m) u='https://www.tcgplayer.com/product/'+m[1]; u=u.replace(/(ebay\.com\/itm\/\d+).*/,'$1');}
    return [d,gr,ti,pr==null?null:+pr,u||null];})
    .filter(r=>{ if(r[3]==null) return false; const m=/(?:#|\b)([A-Za-z]*\d+)\s*\/\s*[A-Za-z]*\d+/.exec(r[2]); return !m || m[1].replace(/^0+/,'').toLowerCase()===num || /^[a-z]+\d+$/.test(num); });
  t.set(id,{pc,g,s});
};
for(const f of fs.readdirSync(process.argv[2]||'data/pricecharting')){
  const txt=fs.readFileSync((process.argv[2]||'data/pricecharting')+'/'+f,'utf8').trim().split('\n').filter(Boolean);
  for(const line of txt){
    if(f.endsWith('.raw')){const [id,pc,j]=line.split('\t'); norm(id,pc,JSON.parse(j));}
    else {const o=JSON.parse(line); norm(o.id,o.pc,o);}
  }
}
fs.writeFileSync(process.argv[3]||'build/pc_data.json',JSON.stringify(Object.fromEntries(out)));
console.log(out.size,'cards',[...out.values()].reduce((a,x)=>a+x.s.length,0),'sales');
