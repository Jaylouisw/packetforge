const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const R=c.find(s=>s.model==='generic-router');
function mk(){const t=new Topology();const r=t.addDevice(R);r.name='R1';return {t,r,s:new CliSession(r,t,new Simulator(t))};}
// what the eighteen call sites assumed: one call configures several lines
const a=mk(); a.s.run('enable');
a.s.run('configure terminal','hostname R1','vlan 99 users','interface Gi0/0','ip address 10.0.1.1 255.255.255.0','exit','exit');
a.s.run('write memory');
console.log('multi-line call -> saved:', JSON.stringify(a.s.run('show startup-config').output));
// the old behaviour, line by line, showing what the ignored arguments would have been
const b=mk(); b.s.run('enable');
b.s.run('configure terminal');
b.s.run('write memory');
console.log('first-line-only  -> saved:', JSON.stringify(b.s.run('show startup-config').output));
