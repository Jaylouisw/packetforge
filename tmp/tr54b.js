const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const SW=c.find(s=>s.model==='generic-switch'),R=c.find(s=>s.model==='generic-router');
function lab(S,name){const t=new Topology();const d=t.addDevice(S);d.name=name;const s=new CliSession(d,t,new Simulator(t));s.run('enable');return s;}
const s=lab(R,'R1');
s.run('configure terminal'); console.log('R1(config)#vlan 99 users'); s.run('vlan 99 users').output.forEach(l=>console.log(l)); s.run('end');
console.log('R1#show vlan'); s.run('show vlan').output.forEach(l=>console.log(l));
console.log('---trunk native---');
const m=lab(SW,'SW1'); m.run('configure terminal');
[['vlan 30'],['interface Fa0/8'],['switchport mode trunk'],['switchport trunk native vlan 30'],['exit'],['no vlan 30']].forEach(([x])=>{const o=m.run(x).output;console.log('SW1(config)#'+x);o.forEach(l=>console.log(l));});
console.log('---trunk pruned---');
const n=lab(SW,'SW1'); n.run('configure terminal');
[['vlan 30'],['interface Fa0/8'],['switchport mode trunk'],['switchport trunk allowed vlan 10,30'],['exit'],['no vlan 30']].forEach(([x])=>{const o=n.run(x).output;console.log('SW1(config)#'+x);o.forEach(l=>console.log(l));});
n.run('end'); console.log('SW1#show vlan'); n.run('show vlan').output.forEach(l=>console.log(l));
