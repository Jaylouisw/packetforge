const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const SW=c.find(s=>s.model==='generic-switch'),PC=c.find(s=>s.model==='generic-pc');
function run(withVlan){
  const t=new Topology();const sw=t.addDevice(SW),p1=t.addDevice(PC);sw.name='SW1';p1.name='PC1';
  const ports=[...sw.interfaces.keys()].filter(n=>!sw.interfaces.get(n).svi);
  t.connect(p1.id,'eth0',sw.id,ports[0]);
  const sim=new Simulator(t);const mk=d=>{const s=new CliSession(d,t,sim);s.run('enable');return s;};
  const a=mk(sw),s1=mk(p1);
  const cfg=(s,cm)=>{s.run('configure terminal');const o=[];for(const x of cm)o.push.apply(o,s.run(x).output);s.run('end');return o;};
  cfg(s1,['hostname PC1','interface eth0','ip address 10.0.0.50 255.255.255.0','exit']);
  const pre = withVlan ? ['vlan 20','name users','exit'] : [];
  console.log(' vlan20 cfg:', cfg(a,pre.concat(['interface '+ports[0],'switchport mode access','switchport port-security'])).join(' | '));
  if(withVlan) console.log(' access:', cfg(a,['interface '+ports[0],'switchport access vlan 20']).join(' | '));
  const mac1=p1.interfaces.get('eth0').mac;
  const frame={etherType:0x0806,srcMac:mac1,dstMac:'ff:ff:ff:ff:ff:ff',arp:{op:'request',senderMac:mac1,senderIp:'10.0.0.50',targetMac:'00:00:00:00:00:00',targetIp:'10.0.0.254'}};
  const n=(sim.events||[]).length;
  sim._processFrame(sw,frame,ports[0]);
  console.log(' events:', (sim.events||[]).slice(n).map(x=>x.type).join(','));
  console.log(' state:', JSON.stringify(sw.portSecurity.ports[ports[0]]&&{enabled:sw.portSecurity.ports[ports[0]].enabled,dyn:sw.portSecurity.ports[ports[0]].dynamic,max:sw.portSecurity.ports[ports[0]].maximum}));
  a.run('show port-security address').output.forEach(l=>console.log('   '+l));
}
console.log('== VLAN 1:'); run(false);
console.log('== VLAN 20:'); run(true);
