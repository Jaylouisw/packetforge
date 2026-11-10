const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const R=c.find(s=>s.model==='generic-router');
const t=new Topology();const r1=t.addDevice(R);r1.name='R1';const s=new CliSession(r1,t,new Simulator(t));
s.run('enable');s.run('configure terminal');
const p=(x)=>{console.log('R1(config-if)#'+x);s.run(x).output.forEach(l=>console.log(l));};
p('interface Gi0/0'); p('ip address 10.0.0.1 255.0.255.0'); p('ip address 10.0.0.255 255.255.255.0'); p('ip address 0.0.0.0 0.0.0.0');
p('ip address 10.0.0.1 255.255.255.0'); p('ip address 10.0.0.1/24 secondary');
p('interface Gi0/1'); p('ip address 10.0.0.1 255.255.255.0'); p('ip address 10.0.0.2 255.255.255.0');
