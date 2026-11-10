const {Topology,Simulator,runCommands}=require('../engine');
const {loadCatalog}=require('../devices/registry');
const catalog=loadCatalog('C:/Users/jay/packetforge/devices');
const model=(n)=>catalog.find(x=>x.model===n);
const t=new Topology();
const r1=t.addDevice(model('generic-router')); r1.name='R1';
const r2=t.addDevice(model('generic-router')); r2.name='R2';
t.connect(r1.id,'Gi0/0',r2.id,'Gi0/0');
const sim=new Simulator(t);
runCommands(r1,t,sim,['enable','configure terminal','ospf router-id 1.1.1.1','ospf area 0',
 'interface Gi0/0','ip address 10.0.12.1 255.255.255.0','ip ospf area 0','exit',
 'router bgp 65001','bgp router-id 1.1.1.1','bgp neighbor 10.0.12.2 remote-as 65002','exit','exit']);
runCommands(r2,t,sim,['enable','configure terminal','ospf router-id 2.2.2.2','ospf area 0',
 'interface Gi0/0','ip address 10.0.12.2 255.255.255.0','ip ospf area 0','exit',
 'interface Gi0/1','ip address 10.0.99.1 255.255.255.0','ip ospf area 0','exit',
 'router bgp 65002','bgp router-id 2.2.2.2','bgp neighbor 10.0.12.1 remote-as 65001','exit','exit']);
const cli=(dev,cmds)=>runCommands(dev,t,sim,['enable'].concat(cmds)).lines.join('\n');
console.log(cli(r1,['show ip route']));
console.log('--- bgp:');
console.log(cli(r1,['show ip bgp']));
console.log('routeTo:', JSON.stringify(r1.routeTo('10.0.99.5'), null, 0).slice(0,200));
