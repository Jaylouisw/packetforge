const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch');
function lab(dev,name){const t=new Topology();const d=t.addDevice(dev);d.name=name;const s=new CliSession(d,t,new Simulator(t));s.run('enable');s.run('configure terminal');return s;}
const p=(s,x)=>{const o=s.run(x).output;console.log('$ '+x+(o.length?'\n    '+o.join('\n    '):''));};
const r=lab(R,'R1');
console.log('=== ip route');
for (const x of ['ip route 10.0.0.0 255.255.255.0 192.168.1.1','ip route 10.0.0.0 255.255.255.0','ip route abc 255.0.0.0 1.1.1.1','ip route 10.0.0.0 abc 1.1.1.1','ip route 10.0.0.0 255.255.255.0 abc','ip route 10.0.0.0 255.255.255.0 1.1.1.1 999','ip route 10.0.0.0 255.255.255.0 null0','ip route 0.0.0.0 0.0.0.0 10.0.0.1','ip route']) p(r,x);
console.log('=== vrrp / ospf');
for (const x of ['interface Gi0/0','ip address 10.0.0.1 255.255.255.0','vrrp abc ip 10.0.0.9','vrrp 300 ip 10.0.0.9','vrrp 1 ip abc','vrrp 1 ip','vrrp 1','ospf abc','ospf 1 area 0','ip ospf cost abc','ip ospf cost 10','ip ospf hello-interval abc','ip ospf priority abc']) p(r,x);
console.log('=== ipv6 route / nd');
for (const x of ['ipv6 route 2001:db8::/32','ipv6 route abc','ipv6 route 2001:db8::/32 2001:db8::1','ipv6 route 2001:db8::/32 9999::1','ipv6 nd ra interval abc','ipv6 nd ra lifetime abc']) p(r,x);
console.log('=== encapsulation');
for (const x of ['interface Gi0/1','encapsulation dot1q abc','encapsulation dot1q 9999','encapsulation dot1q 10','encapsulation dot1q']) p(r,x);
