const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const R=c.find(s=>s.model==='generic-router'),PC=c.find(s=>s.model==='generic-pc');
const t=new Topology();const r=t.addDevice(R),p1=t.addDevice(PC),p2=t.addDevice(PC);
r.name='R1';p1.name='PC1';p2.name='PC2';
t.connect(p1.id,'eth0',r.id,'Gi0/0');t.connect(p2.id,'eth0',r.id,'Gi0/1');
const sim=new Simulator(t);const mk=d=>{const s=new CliSession(d,t,sim);s.run('enable');return s;};
const a=mk(r),s1=mk(p1),s2=mk(p2);
const cfg=(s,cm)=>{s.run('configure terminal');const o=[];for(const x of cm)o.push.apply(o,s.run(x).output);s.run('end');return o;};
cfg(s1,['hostname PC1','interface eth0','ip address 10.0.0.50 255.255.255.0','exit']);
cfg(s2,['hostname PC2','interface eth0','ip address 10.0.0.60 255.255.255.0','exit']);
cfg(a,['hostname R1','interface Gi0/0','ip address 10.0.0.1 255.255.255.0','exit','interface Gi0/1','ip address 10.0.1.1 255.255.255.0','exit']);
const mac1=p1.interfaces.get('eth0').mac, mac2=p2.interfaces.get('eth0').mac;
const dotted = m => m.replace(/:/g,'').replace(/(.{4})(?!$)/g,'$1.');
cfg(a,['arp 10.0.0.50 '+dotted(mac1)]);
// PC2 forges a reply claiming 10.0.0.50, arriving on R1's Gi0/1
const frame={ethertype:0x0806, srcMac:mac2, dstMac:'ff:ff:ff:ff:ff:ff',
  arp:{op:'reply', senderMac:mac2, senderIp:'10.0.0.50', targetMac:r.interfaces.get('Gi0/1').mac, targetIp:'10.0.1.1'}};
const before=(sim.events||[]).length;
try { sim._deliver({devId:r.id, iface:'Gi0/1', frame}); } catch(err){ console.log('inject failed:', err.message); }
console.log('static:', JSON.stringify(Array.from(r.arpStatic.entries())));
console.log('learned:', JSON.stringify(Array.from(r.arp.entries())));
console.log('events:', (sim.events||[]).slice(before).map(x=>x.type+(x.offered?'/'+x.offered:''+(x.kept||''))).join(', '));
console.log('== ping still goes to the static mac:');
let n=(sim.events||[]).length;
console.log(a.run('ping 10.0.0.50 count 1').output.filter(l=>/Success|Reply/.test(l)).join(' | '));
console.log('events:', (sim.events||[]).slice(n).map(x=>x.type+(x.via?'/'+x.via:'')+(x.mac?'@'+x.mac:'')).join(', '));
