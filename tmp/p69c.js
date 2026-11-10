const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const SW=c.find(s=>s.model==='generic-switch');
const t=new Topology();const s1=t.addDevice(SW);s1.name='SW1';const s2=t.addDevice(SW);s2.name='SW2';
t.connect(s1.id,'Fa0/1',s2.id,'Fa0/1');
const sim=new Simulator(t);
console.log('topo dev macs:', s1.mac, s2.mac);
for (const d of [s1,s2]) console.log(d.name, 'iface macs:', [...d.interfaces.values()].slice(0,3).map(i=>i.name+'='+i.mac).join(' '));
console.log('stp root:', JSON.stringify(sim.stpResult.root));
