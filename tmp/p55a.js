const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const SW=c.find(s=>s.model==='generic-switch'),R=c.find(s=>s.model==='generic-router');
function run(dev,cmds){const t=new Topology();const d=t.addDevice(dev);d.name='X1';const s=new CliSession(d,t,new Simulator(t));s.run('enable');
 for(const x of cmds){const o=s.run(x).output;console.log('$ '+x+(o.length?'\n    '+o.join('\n    '):''));}
 return {d,s,t};}
console.log('=== switchport access/native on a switch Fa0/1');
run(SW,['configure terminal','interface Fa0/1',
 'switchport access vlan abc','switchport access vlan 0','switchport access vlan 9999','switchport access vlan',
 'switchport mode bogus','switchport mode','switchport trunk native vlan 9999','switchport trunk native vlan abc',
 'switchport trunk allowed vlan 9999','switchport trunk allowed vlan abc','switchport trunk allowed vlan','switchport trunk allowed',
 'switchport','switchport bogus 1','no switchport access vlan','no switchport trunk allowed vlan 10',
 'no switchport mode','no switchport']);
console.log('=== switchport on a router Gi0/0');
run(R,['configure terminal','interface Gi0/0','switchport','switchport mode access','switchport access vlan 10']);
console.log('=== switchport on an SVI');
run(SW,['configure terminal','vlan 10','interface vlan 10','switchport','switchport access vlan 10','ip address 10.0.0.1 255.255.255.0']);
