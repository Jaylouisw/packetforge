const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch'),PC=c.find(s=>s.model==='generic-pc');
const t=new Topology();const sw=t.addDevice(SW),r=t.addDevice(R),pc=t.addDevice(PC);
sw.name='SW1';r.name='R1';pc.name='PC1';
t.connect(pc.id,'eth0',sw.id,'Fa0/1');t.connect(sw.id,'Fa0/2',r.id,'Gi0/0');
const sim=new Simulator(t);const mk=d=>{const s=new CliSession(d,t,sim);s.run('enable');return s;};
const s1=mk(sw),rr=mk(r),sp=mk(pc);
const cfg=(s,cm)=>{s.run('configure terminal');cm.forEach(x=>{const o=s.run(x).output;if(o.some(l=>/^%/.test(l)))console.log('REFUSED '+x+' => '+o.join(' | '));});s.run('end');};
cfg(sp,['hostname PC1','interface eth0','ip address 10.0.0.50 255.255.255.0','ip default-gateway 10.0.0.1','exit']);
cfg(rr,['hostname R1','interface Gi0/0','ip address 10.0.0.1 255.255.255.0','duplex full','exit']);
cfg(s1,['hostname SW1','interface Fa0/1','description to PC1','speed 100','exit',
 'interface Fa0/2','description uplink to R1','exit',
 'interface Fa0/4','description spare port (unused)','shutdown','exit',
 'interface Fa0/3','switchport access vlan 20','exit','vlan 20','name printers','exit']);
sp.run('ping 10.0.0.1 count 1');
const show=(s,x)=>{console.log('$ '+x);const o=s.run(x).output;o.forEach(l=>console.log('  '+l));};
show(s1,'show interfaces status');
show(s1,'show interfaces description');
show(s1,'show interfaces description Fa0/2');
show(rr,'show interfaces status');
show(rr,'show interfaces description');
show(rr,'show ip interface');
show(s1,'show ip interface Fa0/1');
show(rr,'show ip interface Gi0/0 extra');
