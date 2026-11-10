const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch');
// A router configured with as many verbs as it accepts, then dumped and pasted into a twin.
function build(spec, cmds, name){
  const t=new Topology();const d=t.addDevice(spec);const s=new CliSession(d,t,new Simulator(t));s.run('enable');
  s.run('configure terminal');
  const refused=[];
  for(const x of cmds){const o=s.run(x).output;if(o.some(l=>/^%/.test(l)))refused.push(x+' => '+o.join(' / '));}
  s.run('end');
  return {s,d,refused};
}
const ROUTER_CMDS=[
 'hostname R1',
 'interface Gi0/0','ip address 10.0.0.1 255.255.255.0','description uplink to core','mtu 1400','speed 100','duplex full','exit',
 'interface Gi0/0.30','ip address 10.30.0.1 255.255.255.0','encapsulation dot1q 30','exit',
 'interface Gi0/1','ip address 203.0.113.2 255.255.255.0','ip nat outside','exit',
 'interface Gi0/0','ip nat inside','exit',
 'ip route 10.9.0.0 255.255.255.0 203.0.113.254',
 'ip default-gateway 203.0.113.254',
 'ip name-server 1.1.1.1',
 'access-list 1 permit 10.0.0.0 0.0.0.255',
 'ip access-list extended BLOCK','deny tcp any any eq 23','permit ip any any','exit',
 'ip nat inside source list 1 interface Gi0/1 overload',
 'ip nat inside source static 10.0.0.50 203.0.113.50',
 'router bgp 65001','bgp router-id 1.1.1.1','bgp neighbor 203.0.113.254 remote-as 65002','exit',
 'ospf router-id 1.1.1.1','ospf area 0',
 'ipv6 unicast-routing','ipv6 route 2001:db8:9::/64 2030::1','ipv6 gateway 2030::1',
 'dns zone lab.test','dns add www.lab.test A 10.0.0.9',
 'ip dhcp pool LAN','network 10.0.0.0 255.255.255.0','default-router 10.0.0.1','dns-server 1.1.1.1','range 10.0.0.100 10.0.0.150','lease 1 2 3','exit',
 'vlan 30 base',
];
const SWITCH_CMDS=[
 'hostname SW1',
 'vlan 10 users','vlan 20 voice',
 'interface Fa0/1','switchport mode access','switchport access vlan 10','description desk port','mtu 9000','spanning-tree cost 19','exit',
 'interface Fa0/2','switchport mode trunk','switchport trunk native vlan 10','switchport trunk allowed vlan 10,20','exit',
 'interface Fa0/3','channel-group 1 mode active','exit',
 'interface Fa0/4','channel-group 1 mode active','exit',
 'interface vlan 10','ip address 10.10.0.2 255.255.255.0','exit',
 'spanning-tree vlan 1 priority 4096',
 'spanning-tree vlan 20 root primary',
];
const r=build(R,ROUTER_CMDS,'R1');
console.log('ROUTER refused: '+(r.refused.length?('\n  '+r.refused.join('\n  ')):'none'));
const dump=r.s.run('show running-config').output;
console.log('\n--- ROUTER DUMP ---');dump.forEach(l=>console.log('  '+l));
const sw=build(SW,SWITCH_CMDS,'SW1');
console.log('\nSWITCH refused: '+(sw.refused.length?('\n  '+sw.refused.join('\n  ')):'none'));
const dump2=sw.s.run('show running-config').output;
console.log('\n--- SWITCH DUMP ---');dump2.forEach(l=>console.log('  '+l));
// paste each dump into a twin and compare the dumps
function repaste(spec, dump, name){
  const t=new Topology();const d=t.addDevice(spec);const s=new CliSession(d,t,new Simulator(t));s.run('enable');s.run('configure terminal');
  const refused=[];
  for(const line of dump.slice(1)){ if(/^!/.test(line)||/^end$/.test(line))continue;
    const o=s.run(line).output; if(o.some(l=>/^%/.test(l)))refused.push(line+' => '+o.join(' / '));}
  s.run('end');
  const again=s.run('show running-config').output;
  console.log('\n['+name+'] repaste refused: '+(refused.length?('\n  '+refused.join('\n  ')):'none'));
  const a=dump.filter(x=>!/^!/.test(x)&&x!=='end'), b=again.filter(x=>!/^!/.test(x)&&x!=='end');
  const lost=a.filter(x=>b.indexOf(x)===-1), gained=b.filter(x=>a.indexOf(x)===-1);
  if(lost.length) console.log('  LOST ON REPASTE:\n    '+lost.join('\n    '));
  if(gained.length) console.log('  APPEARED:\n    '+gained.join('\n    '));
  if(!lost.length&&!gained.length) console.log('  identical dump');
}
repaste(R,dump,'router');
repaste(SW,dump2,'switch');
