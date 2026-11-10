const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch'),PC=c.find(s=>s.model==='generic-pc');
const t=new Topology();const r1=t.addDevice(R);r1.name='R1';const sw=t.addDevice(SW);sw.name='SW1';const pc=t.addDevice(PC);pc.name='PC1';
t.connect(pc.id,'eth0',sw.id,'Fa0/1');t.connect(sw.id,'Fa0/2',r1.id,'Gi0/0');
const sim=new Simulator(t);
const s1=new CliSession(r1,t,sim);s1.run('enable');
const cfg=(s,cmds)=>{s.run('configure terminal');cmds.forEach(x=>{const o=s.run(x).output;if(o.some(l=>/^%/.test(l)))console.log('  REFUSED: '+x+' => '+o.join(' / '));});s.run('end');};
cfg(s1,['interface Gi0/0','ip address 10.0.0.1 255.255.255.0','exit',
 'ip access-list extended BLOCK','deny ip any host 10.0.0.99','permit ip any any','exit',
 'interface Gi0/0','ip access-group BLOCK in','exit']);
const sp=new CliSession(pc,t,sim);sp.run('enable');cfg(sp,['interface eth0','ip address 10.0.0.50 255.255.255.0','ip default-gateway 10.0.0.1','exit']);
const show=(s,x)=>{console.log('['+s.device.name+'] $ '+x);const o=s.run(x).output;o.forEach(l=>console.log('   '+l));if(!o.length)console.log('   (SILENT)');};
sp.run('ping 10.0.0.99 count 2');sp.run('ping 10.0.0.1 count 2');
show(s1,'show access-lists');
show(s1,'show ip access-lists');
show(s1,'clear ip access-list counters');
show(s1,'clear access-list counters');
show(s1,'show access-lists');
console.log('--- NAT');
cfg(s1,['interface Gi0/0','ip nat inside','exit','interface Gi0/1','ip address 203.0.113.2 255.255.255.0','ip nat outside','exit','ip nat inside source list 1 interface Gi0/1 overload','access-list 1 permit 10.0.0.0 0.0.0.255']);
show(s1,'show ip nat translations');
show(s1,'show ip nat statistics');
console.log('--- BGP / OSPF detail');
cfg(s1,['router bgp 65001','bgp neighbor 203.0.113.9 remote-as 65002','exit']);
show(s1,'show ip bgp summary');
cfg(s1,['ospf router-id 1.1.1.1','ospf area 0','interface Gi0/0','ip ospf 1 area 0','exit']);
show(s1,'show ip ospf interface');
show(s1,'show ip ospf database');
