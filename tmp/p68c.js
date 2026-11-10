const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const R=c.find(s=>s.model==='generic-router');
const t=new Topology();const r1=t.addDevice(R);r1.name='R1';
const sim=new Simulator(t);const s=new CliSession(r1,t,sim);s.run('enable');s.run('configure terminal');s.run('interface Gi0/0');s.run('ip address 10.0.0.1 255.255.255.0');s.run('end');
const p=(x)=>{const o=s.run(x).output;console.log('$ '+x);o.forEach(l=>console.log('   '+l));};
p('ping 10.0.0.1 count 2');
console.log('drops:', JSON.stringify(sim.events.filter(e=>e.type==='drop').map(e=>e.reason)));
console.log('routeTo own:', JSON.stringify(sim.topo.getDevice(r1.id).routeTo('10.0.0.1')));
