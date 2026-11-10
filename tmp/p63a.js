const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch'),PC=c.find(s=>s.model==='generic-pc');
const t=new Topology();const r1=t.addDevice(R);r1.name='R1';const sw=t.addDevice(SW);sw.name='SW1';
t.connect(r1.id,'Gi0/0',sw.id,'Fa0/1');const sim=new Simulator(t);
const s=new CliSession(r1,t,sim);s.run('enable');
const q=(x)=>{let o;try{o=s.run(x).output;}catch(e){console.log('> '+x+'\n    THREW: '+e.message);return;}console.log('> '+x+(o.length?'\n   '+o.join('\n   '):'   (SILENT)'))};
s.run('configure terminal');
console.log('=== addressing');
for (const x of ['interface Gi0/0','ip address 10.0.0.1 255.255.255.0','exit',
  'interface Gi0/1','ip address 10.0.0.2 255.255.255.0','exit',
  'interface Gi0/2','ip address 10.0.0.1 255.255.255.0','exit',
  'interface Gi0/0','ip address 10.0.0.1 255.255.255.0 secondary','exit',
  'interface Gi0/0','no ip address','exit',
  'interface Gi0/0','ip address 255.255.255.0 255.255.255.0','exit',
  'interface Gi0/0','ip address 0.0.0.0 0.0.0.0','exit']) q(x);
console.log('=== show ip interface brief:'); s.run('end'); s.run('show ip interface brief').output.forEach(l=>console.log('   '+l));
console.log('=== protocol config');
const q2=(x)=>{let o;try{o=s.run('configure terminal','\x20',x).output;}catch(e){console.log('> '+x+' THREW');return;}console.log('> '+x+(o.length?'\n   '+o.join('\n   '):'   (SILENT)'))};
for (const x of ['router bgp 65001','neighbor 10.0.0.2 remote-as abc','neighbor 10.0.0.2 remote-as 65002','neighbor 300.0.0.1 remote-as 65002','neighbor 10.0.0.2 description hi','network 10.0.0.0 mask 255.255.255.0','network abc mask 255.255.255.0','exit',
  'interface Gi0/0','vrrp 1 ip abc','vrrp 1 ip 10.0.0.254','vrrp 1 priority 300','vrrp 1 priority abc','vrrp 1 preempt extra','exit',
  'ip dhcp excluded-address 10.0.0.0','ip dhcp excluded-address abc 10.0.0.9','ip dhcp excluded-address 10.0.0.9 10.0.0.1',
  'no ip dhcp excluded-address 10.0.0.5','no ip dhcp excluded-address 10.9.9.9']) q2(x);
s.run('end');
for (const x of ['show ip bgp summary','show vrrp','show ip dhcp pool','show ip dhcp binding']) { console.log('> '+x); s.run(x).output.forEach(l=>console.log('   '+l)); }
