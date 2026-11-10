const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const SW=c.find(s=>s.model==='generic-switch');
const t=new Topology();const s1=t.addDevice(SW);s1.name='SW1';const s2=t.addDevice(SW);s2.name='SW2';const s3=t.addDevice(SW);s3.name='SW3';
t.connect(s1.id,'Fa0/1',s2.id,'Fa0/1');t.connect(s2.id,'Fa0/2',s3.id,'Fa0/1');t.connect(s3.id,'Fa0/2',s1.id,'Fa0/2');
const sim=new Simulator(t);
const mk=(d)=>{const s=new CliSession(d,t,sim);s.run('enable');return s;};
for (const d of [s1,s2,s3]) { const s=mk(d); console.log('['+d.name+']'); s.run('show spanning-tree').output.forEach(l=>console.log('   '+l)); }
console.log('--- internal stp:', JSON.stringify(sim.stp ? Object.keys(sim.stp) : null));
console.log('--- stpState?', typeof sim.stpState, typeof sim.stp);
const ports=[...s1.interfaces.values()].map(i=>i.name+':'+JSON.stringify(i.stp||null));
console.log('SW1 iface stp:', ports.join(' '));
