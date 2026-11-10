const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const R=c.find(s=>s.model==='generic-router'),PC=c.find(s=>s.model==='generic-pc');
function lab(){
  const t=new Topology();const r=t.addDevice(R),p1=t.addDevice(PC),p2=t.addDevice(PC);
  r.name='R1';p1.name='PC1';p2.name='PC2';
  t.connect(p1.id,'eth0',r.id,'Gi0/0');t.connect(p2.id,'eth0',r.id,'Gi0/1');
  const sim=new Simulator(t);const mk=d=>{const s=new CliSession(d,t,sim);s.run('enable');return s;};
  const a=mk(r),s1=mk(p1),s2=mk(p2);
  const cfg=(s,cm)=>{s.run('configure terminal');const o=[];for(const x of cm)o.push.apply(o,s.run(x).output);s.run('end');return o;};
  cfg(s1,['hostname PC1','interface eth0','ip address 10.0.0.50 255.255.255.0','exit']);
  cfg(s2,['hostname PC2','interface eth0','ip address 10.0.0.60 255.255.255.0','exit']);
  cfg(a,['hostname R1','interface Gi0/0','ip address 10.0.0.1 255.255.255.0','exit','interface Gi0/1','ip address 10.0.1.1 255.255.255.0','exit']);
  return {t,sim,r,p1,p2,a,s1,s2,cfg};
}
const dotted = m => m.replace(/:/g,'').replace(/(.{4})(?!$)/g,'$1.');
let e=lab();
const mac1=e.p1.interfaces.get('eth0').mac, mac2=e.p2.interfaces.get('eth0').mac;
console.log('dotted mac1:', dotted(mac1));
console.log('== pin the RIGHT mac:');
console.log(e.cfg(e.a,['arp 10.0.0.50 '+dotted(mac1)+' arpa']).join(' | '));
let n=(e.sim.events||[]).length;
console.log(e.a.run('ping 10.0.0.50 count 1').output.join(' | '));
console.log('events:', (e.sim.events||[]).slice(n).map(x=>x.type+(x.via?'/'+x.via:'')).join(', '));
console.log('learned:', JSON.stringify(Array.from(e.r.arp.entries())));
console.log('\n== spoof from PC2 claiming 10.0.0.50:');
// ask R1 for 10.0.0.50 again after clearing learned, but PC2 answers first? Simplest: send R1 an
// ARP reply from PC2's port claiming to be 10.0.0.50.
const iface=e.p2.interfaces.get('eth0');
e.sim._receive ? null : null;
const frame={ethertype:0x0806, srcMac:mac2, dstMac:'ff:ff:ff:ff:ff:ff',
  arp:{op:'reply', senderMac:mac2, senderIp:'10.0.0.50', targetMac:e.r.interfaces.get('Gi0/1').mac, targetIp:'10.0.1.1'}};
try { e.sim._deliverFrame ? e.sim._deliverFrame(e.r.id,'Gi0/1',frame) : e.sim._rx(e.r.id,'Gi0/1',frame); }
catch(err){ console.log('inject failed:', err.message); }
console.log('static after spoof:', JSON.stringify(Array.from(e.r.arpStatic.entries())));
console.log('learned after spoof:', JSON.stringify(Array.from(e.r.arp.entries())));
console.log('tail events:', (e.sim.events||[]).slice(-5).map(x=>x.type).join(', '));
