const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch');
function sess(spec){const t=new Topology();const d=t.addDevice(spec);const s=new CliSession(d,t,new Simulator(t));s.run('enable');return s;}
// hypothesis A: `bgp neighbor` opens a sub-mode that then swallows global commands
const s=sess(R);s.run('configure terminal');
for(const cmd of ['router bgp 65001','bgp router-id 1.1.1.1','bgp neighbor 10.9.0.2 remote-as 65002','ospf router-id 2.2.2.2','vlan 44','dns zone a.test','end']){
  const o=s.run(cmd).output;console.log('A ['+cmd+'] mode='+s.mode+' => '+o.join(' / '));
}
// hypothesis B: mtu/speed/duplex need a switchport mode first
const sw=sess(SW);sw.run('configure terminal');sw.run('interface Fa0/1');sw.run('switchport mode access');
for(const cmd of ['mtu 9000','speed 100','duplex full','no mtu','no speed','no duplex','?']){
  const o=sw.run(cmd).output;if(cmd==='?'){console.log('B iface help has mtu/speed/duplex: '+o.filter(l=>/mtu|speed|duplex/.test(l)).join(' | '));continue;}
  console.log('B ['+cmd+'] => '+o.join(' / '));
}
// hypothesis C: docs claim mtu exists
