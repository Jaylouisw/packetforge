const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch'),PC=c.find(s=>s.model==='generic-pc');
const t=new Topology();const r1=t.addDevice(R);r1.name='R1';const r2=t.addDevice(R);r2.name='R2';const sw=t.addDevice(SW);sw.name='SW1';const pc=t.addDevice(PC);pc.name='PC1';
t.connect(r1.id,'Gi0/0',r2.id,'Gi0/0');t.connect(pc.id,'eth0',sw.id,'Fa0/1');t.connect(sw.id,'Fa0/2',r1.id,'Gi0/1');
const sim=new Simulator(t);
const mk=d=>{const s=new CliSession(d,t,sim);s.run('enable');return s;};
const a=mk(r1),b=mk(r2),sp=mk(pc);
const cfg=(s,cmds)=>{s.run('configure terminal');cmds.forEach(x=>{const o=s.run(x).output;if(o.some(l=>/^%/.test(l)))console.log('  REFUSED ['+s.device.name+'] '+x+' => '+o.join(' / '));});s.run('end');};
cfg(a,['hostname R1','interface Gi0/0','ip address 10.9.0.1 255.255.255.0','exit','interface Gi0/1','ip address 10.0.0.1 255.255.255.0','exit',
 'ospf router-id 1.1.1.1','ospf area 0','interface Gi0/0','ip ospf area 0','exit','interface Gi0/1','ip ospf area 0','exit']);
cfg(b,['hostname R2','interface Gi0/0','ip address 10.9.0.2 255.255.255.0','exit','interface Gi0/1','ip address 10.1.0.1 255.255.255.0','exit',
 'ospf router-id 2.2.2.2','ospf area 0','interface Gi0/0','ip ospf area 0','exit','interface Gi0/1','ip ospf area 0','exit']);
cfg(sp,['hostname PC1','interface eth0','ip address 10.0.0.50 255.255.255.0','ip default-gateway 10.0.0.1','exit']);
sp.run('ping 10.1.0.1 count 1');
const show=(s,x)=>{console.log('['+(s.device.config.hostname||s.device.name)+'] $ '+x);const o=s.run(x).output;o.forEach(l=>console.log('   '+l));if(!o.length)console.log('   (SILENT)');};
show(a,'show ip ospf neighbor');
show(a,'show ip ospf database');
show(a,'show ip ospf interface');
show(a,'show ip route');
console.log('--- BGP');
cfg(a,['router bgp 65001','bgp neighbor 10.9.0.2 remote-as 65002','exit']);
cfg(b,['router bgp 65002','bgp neighbor 10.9.0.1 remote-as 65001','exit']);
show(a,'show ip bgp summary');
show(a,'show ip bgp neighbors');
