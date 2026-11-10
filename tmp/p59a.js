const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch');
function lab(spec,name){const t=new Topology();const d=t.addDevice(spec);d.name=name;const s=new CliSession(d,t,new Simulator(t));s.run('enable');s.run('configure terminal');return s;}
const p=(s,x)=>{let o;try{o=s.run(x).output;}catch(e){console.log('$ '+x+'\n    THREW: '+e.message);return;}console.log('$ '+x+(o.length?'\n    '+o.join('\n    '):'    (silent)'))};
const r=lab(R,'R1');
console.log('=== ospf');
for (const x of ['ospf router-id abc','ospf router-id 1.1.1.1','ospf area 99','ospf area abc','router ospf 1','ospf']) p(r,x);
console.log('=== bgp');
for (const x of ['bgp router-id abc','bgp router-id 1.1.1.1','neighbor abc remote-as 65001','neighbor 10.0.0.2 remote-as abc','neighbor 10.0.0.2 remote-as 70000','neighbor 10.0.0.2','network 10.0.0.0','network abc','router bgp abc']) p(r,x);
console.log('=== dhcp pool');
for (const x of ['ip dhcp pool P1','network 10.0.0.0 255.255.255.0','network abc','default-router abc','dns-server abc','lease abc','lease 0','lease 99999999','exit']) p(r,x);
console.log('=== dns');
for (const x of ['dns zone example.test','dns record www A abc','dns record www A 10.0.0.5','dns record www AAAA zzzz','dns forwarder abc','dns forwarder 1.1.1.1','exit']) p(r,x);
console.log('=== misc globals');
for (const x of ['hostname','hostname ','enable secret','username bob','banner motd','clock rate abc','logging abc','line vty 0 4','transport input abc']) p(r,x);
