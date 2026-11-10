const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const SW=c.find(s=>s.model==='generic-switch'),R=c.find(s=>s.model==='generic-router');
function lab(dev,name){const t=new Topology();const d=t.addDevice(dev);d.name=name;const s=new CliSession(d,t,new Simulator(t));s.run('enable');s.run('configure terminal');return s;}
const sw=lab(SW,'SW1');
const step=(s,cmds)=>{for(const x of cmds){const o=s.run(x).output;console.log('$ '+x+(o.length?'\n    '+o.join('\n    '):''));}};
console.log('=== interface verbs on a switch port');
step(sw,['interface Fa0/1','description','description a b c','mtu','mtu abc','mtu 99999','mtu 1500',
 'speed','speed abc','speed 1000','duplex','duplex bogus','duplex full',
 'spanning-tree','spanning-tree port-priority','spanning-tree port-priority abc','spanning-tree cost 99999999',
 'no description','no mtu','no speed','no duplex','no spanning-tree','shutdown','no shutdown']);
console.log('=== channel-group');
step(sw,['interface Fa0/2','channel-group','channel-group abc','channel-group 1 mode bogus','channel-group 1 mode active','no channel-group','no channel-group 9']);
const r=lab(R,'R1');
console.log('=== router interface verbs');
step(r,['interface Gi0/0','ip address 10.0.0.1/24','ip ospf cost abc','ip ospf cost','ip ospf cost 10',
 'ip mtu','ip mtu abc','ip helper-address','ip helper-address not-an-ip','ip access-group','ip access-group 101','ip access-group abc in',
 'shutdown','no ip address']);
