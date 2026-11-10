const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const R=c.find(s=>s.model==='generic-router');
const t=new Topology();const r1=t.addDevice(R);r1.name='R1';const r2=t.addDevice(R);r2.name='R2';
t.connect(r1.id,'Gi0/0',r2.id,'Gi0/0');const sim=new Simulator(t);
const cfg=(d,cmds)=>{const s=new CliSession(d,t,sim);s.run('enable');s.run('configure terminal');for(const x of cmds)s.run(x);s.run('end');return s;};
const s1=cfg(r1,['ipv6 unicast-routing','interface Gi0/0','ipv6 address 2001:db8:1::1/64','exit']);
cfg(r2,['ipv6 unicast-routing','interface Gi0/0','ipv6 address 2001:db8:1::2/64','exit']);
for (const cmd of ['ping 2001:db8:1::2','ping ipv6 2001:db8:1::2','ping 2001:db8:1::2 count 2']) {
  console.log('$ '+cmd); s1.run(cmd).output.forEach(l=>console.log('   '+l));
}
console.log('sim.ping6:', JSON.stringify(sim.ping6(r1.id,'2001:db8:1::2',{count:1})).slice(0,200));
