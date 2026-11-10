// Truncation sweep: type every documented command with NO arguments and check that what comes back is
// a sentence, never a crash, an empty answer, or a fabricated result.
const {Topology,Simulator,CliSession}=require('../engine');
const {loadCatalog}=require('../devices/registry');
const cat=loadCatalog('C:/Users/jay/packetforge/devices');
const mk=(model,name)=>{const t=new Topology();const d=t.addDevice(cat.find(x=>x.model===model));d.name=name;const s=new CliSession(d,t,new Simulator(t));s.run('enable');return {d,s,t};};
const env=mk('generic-router','R1');
const rows=env.s._helpFormRows('enable');
const seen=new Set();
const findings=[];
for (const row of rows) {
  // the keyword prefix of the row: words up to the first value slot
  const words=[];
  for (const t of row.tokens) { if (typeof t !== 'string') break; words.push(t); }
  if (!words.length) continue;
  for (let n=1; n<words.length; n++) {
    // Truncated typings: every proper prefix of the keyword words.
    const cmd=words.slice(0,n).join(' ');
    if (seen.has(cmd)) continue; seen.add(cmd);
    let out;
    try { out = env.s.run(cmd).output; } catch (e) { findings.push([cmd,'THREW',e.message]); continue; }
    const text = out.join('\n');
    if (!out.length) findings.push([cmd,'EMPTY','']);
    else if (/undefined|NaN|\[object Object\]|null/.test(text)) findings.push([cmd,'LEAK',text.slice(0,120)]);
    else if (!/^%/.test(out[0]) && !/^ {2}/.test(out[0]) && !/^[A-Za-z]/.test(out[0])) findings.push([cmd,'ODD',out[0].slice(0,80)]);
  }
}
console.log('truncated forms tested:', seen.size);
for (const [cmd,kind,detail] of findings) console.log(kind.padEnd(6), JSON.stringify(cmd), detail);
