const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch');
function sess(spec){const t=new Topology();const d=t.addDevice(spec);const s=new CliSession(d,t,new Simulator(t));s.run('enable');return s;}
const s=sess(R);
s.run('configure terminal');
s.run('router bgp 65001'); s.run('bgp router-id 1.1.1.1');
console.log('mode in bgp block:', JSON.stringify(s.mode));
for (const cmd of ['ospf router-id 1.1.1.1','vlan 30','dns zone lab.test','ipv6 unicast-routing','ip name-server 2.2.2.2','interface Gi0/2','hostname Z','ip route 10.9.0.0 255.255.255.0 203.0.113.254','access-list 2 permit 10.0.0.0 0.0.0.255','end']) {
  const o=s.run(cmd).output;console.log('  ['+cmd+'] mode='+s.mode+' => '+o.join(' / '));
}
console.log('\n=== mtu/speed/duplex:');
for (const [name,spec,setup] of [['router',R,['configure terminal','interface Gi0/0']],['switch',SW,['configure terminal','interface Fa0/1']]]) {
  const x=sess(spec);setup.forEach(cm=>x.run(cm));
  for (const cmd of ['mtu 1400','speed 100','duplex full','no mtu','no speed','no duplex']) {
    const o=x.run(cmd).output;console.log('  '+name+' ['+cmd+'] => '+o.join(' / '));
  }
}
console.log('\n=== grep: is mtu handled anywhere?');
