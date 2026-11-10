const fs=require('fs');const path=require('path');
const SRC=fs.readFileSync(path.join(__dirname,'..','engine','cli.js'),'utf8');
function body(name){const s=SRC.indexOf('  '+name+'(');const e=SRC.indexOf('\n  }',s);return SRC.slice(s,e);}
function prefixes(name){
  const b=body(name);const out=new Set();
  // Split on branch boundaries so a condition belongs to one branch.
  const parts=b.split(/\n\s*\}?\s*(?:else\s+)?if\s*\(/);
  for(const p of parts){
    const cond=p.slice(0,p.indexOf(') {')>=0?p.indexOf(') {'):200);
    if(!/head\s*===\s*'no'/.test(cond)) continue;
    const t1=[...cond.matchAll(/tokens\[1\]\s*===\s*'([^']+)'/g)].map(m=>m[1]);
    const t2=[...cond.matchAll(/tokens\[2\]\s*===\s*'([^']+)'/g)].map(m=>m[1]);
    const idx1=[...cond.matchAll(/\['([^']+)'(?:,\s*'([^']+)')*\]\s*\.indexOf\(tokens\[1\]\)/g)];
    if(!t1.length && !idx1.length) continue;
    if(t2.length){ for(const a of t1) for(const c of t2) out.add(a+' '+c); }
    else for(const a of t1) out.add(a);
    for(const m of idx1){ const words=[...m[0].matchAll(/'([^']+)'/g)].map(x=>x[1]); out.add(words.join('|')); }
  }
  return Array.from(out).sort();
}
console.log('config no-branches:');prefixes('_configMode').forEach(p=>console.log('  '+p));
console.log('iface no-branches:');prefixes('_ifaceMode').forEach(p=>console.log('  '+p));
// existing no help rows by mode
function rows(name){
  const b=body(name);return [...b.matchAll(/helpLine\('(no [^']+)'/g)].map(m=>m[1]);
}
console.log('config no help rows:',rows('_configModeHelp').length?rows('_configModeHelp'):'(look elsewhere)');
