const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const SW=c.find(s=>s.model==='generic-switch'), R=c.find(s=>s.model==='generic-router');
function mkSw(){const t=new Topology();const sw=t.addDevice(SW);sw.name='SW1';const s=new CliSession(sw,t,new Simulator(t));s.run('enable');return {t,sw,s};}
const R2=(s,x)=>{const o=s.run(x).output;console.log('$ '+x);o.forEach(l=>console.log('    '+l));return o;};
// 1. range checks
let a=mkSw();
R2(a.s,'configure terminal'); R2(a.s,'vlan 30'); R2(a.s,'end');
for (const q of ['show vlan 0','show vlan 4095','show vlan 9999','show vlan 0040']) R2(a.s,q);
// 2. paste the running-config back into a fresh switch
const rc=R2(a.s,'show running-config').filter(l=>!/^!/.test(l));
let b=mkSw(); R2(b.s,'configure terminal');
for (const line of rc) { const o=b.s.run(line).output; if (o.some(x=>/^%/.test(x))) console.log('    PASTE FAIL: '+line+' -> '+o.join(' | ')); }
R2(b.s,'end');
R2(b.s,'show vlan');
// 3. a name typed explicitly
let d=mkSw(); R2(d.s,'configure terminal'); R2(d.s,'vlan 40'); R2(d.s,'name SALES'); R2(d.s,'end');
R2(d.s,'show vlan 40'); R2(d.s,'show running-config');
// 4. show vlan on a router
const t2=new Topology(); const r=t2.addDevice(R); r.name='R1'; const s2=new CliSession(r,t2,new Simulator(t2)); s2.run('enable');
R2(s2,'show vlan');
