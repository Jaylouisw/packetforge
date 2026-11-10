const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const R=c.find(s=>s.model==='generic-router');
const t=new Topology();const r=t.addDevice(R);r.name='R1';const s=new CliSession(r,t,new Simulator(t));s.run('enable');
const p=(x)=>{const o=s.run(x).output;console.log('$ '+x+(o.length?'\n    '+o.join('\n    '):''));};
s.run('configure terminal');
p('ip route abc 255.0.0.0 1.1.1.1');
p('ip route 10.0.0.0 255.255.255.0 abc');
p('ip route 10.0.0.0 255.255.255.0 1.1.1.1 250');
p('ip route 10.0.0.0 255.255.255.0');
p('ip route 10.0.0.0 255.255.255.0 null0');
p('no ip route 10.0.0.0 255.255.255.0');
s.run('end');
p('show running-config');
p('show ip route');
console.log('routeTo checks:', JSON.stringify(r.routeTo ? null : null));
const dev=r;
for (const addr of ['10.0.0.5','1.2.3.4','abc']) { try { console.log('routeTo('+addr+') =', JSON.stringify(dev.routeTo(addr))); } catch(e){ console.log('routeTo('+addr+') threw', e.message); } }
console.log('config.routes=', JSON.stringify(r.config.routes));
