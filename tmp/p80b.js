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
let e=lab();
const mac1=e.p1.interfaces.get('eth0').mac, mac2=e.p2.interfaces.get('eth0').mac;
console.log('mac1',mac1,'mac2',mac2);
console.log('== pin the RIGHT mac, no ARP should be sent:');
console.log(e.cfg(e.a,['arp 10.0.0.50 '+mac1.replace(/:/g,'.').replace(/..(..)\.?/g,'$1')]).join(' | '));
let n=(e.sim.events||[]).length;
console.log(e.a.run('ping 10.0.0.50 count 1').output.join(' | '));
console.log('events:', (e.sim.events||[]).slice(n).map(x=>x.type+(x.via?'/'+x.via:'')).join(', '));
console.log('arp table after ping:', JSON.stringify(Array.from(e.r.arp.entries())), 'static:', JSON.stringify(Array.from(e.r.arpStatic.entries())));
console.log('\n== spoof: PC2 answers an ARP request for 10.0.0.50');
// force an arp request for .50 by removing nothing; instead send a gratuitous/arp reply from PC2 claiming 10.0.0.50
const f=require('../engine/net');
e.sim._handleArp ? null : null;
e.r.arp.delete('10.0.0.50');
// craft: make PC2 emit an ARP reply claiming 10.0.0.50 -> route it to R1
const arpLib=require('../engine/arp');
const frame=arpLib.build ? arpLib.build('reply',{senderMac:mac2,senderIp:'10.0.0.50',targetMac:'ff:ff:ff:ff:ff:ff',targetIp:'10.0.0.1'}) : null;
console.log('build available:', !!frame);
if(frame){
  const iface=e.p2.interfaces.get('eth0');
  e.sim._transmit ? e.sim._transmit(e.p2.id, iface, Object.assign({ethertype:0x0806,srcMac:mac2,dstMac:'ff:ff:ff:ff:ff:ff'},frame)) : null;
}
console.log('static after spoof:', JSON.stringify(Array.from(e.r.arpStatic.entries())));
console.log('learned after spoof:', JSON.stringify(Array.from(e.r.arp.entries())));
console.log('events:', (e.sim.events||[]).slice(-6).map(x=>x.type).join(', '));
console.log('\n== clear arp keeps it:'); console.log(e.a.run('clear arp').output.join(' | '));
console.log('\n== dump:'); console.log(e.a.run('show running-config').output.filter(l=>/^arp /.test(l)).join('\n'));
