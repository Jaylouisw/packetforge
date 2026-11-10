const {Topology,Simulator}=require('../engine');
const {CliSession}=require('../engine/cli');
const {loadCatalog}=require('../devices/registry');
const catalog=loadCatalog('C:/Users/jay/packetforge/devices');
const mk=(n)=>catalog.find(x=>x.model===n);
const t=new Topology();
const r=t.addDevice(mk('generic-router')); r.name='R1';
const sw=t.addDevice(mk('generic-switch')); sw.name='SW1';
const sim=new Simulator(t);
const s=new CliSession(r,t,sim); s.run('enable');
const cases=[
 ['show ip bgp','enable'],
 ['show ip ospf','enable'],
 ['show ip ospf neighbor','enable'],
 ['show scion','enable'],
 ['show vrrp','enable'],
 ['bgp neighbor 10.0.0.2 remote-as 65002','enable','configure terminal'],
 ['ospf area 0','enable','configure terminal'],
 ['vrrp 10 ip 10.0.0.254','enable','configure terminal'],
 ['dns add www.lab.test A 10.0.0.1','enable','configure terminal'],
 ['scion paths','enable'],
];
for (const [cmd,...pre] of cases){
  const c=new CliSession(r,t,sim); for (const p of pre) c.run(p);
  const out=c.run(cmd).output;
  console.log('$ '+cmd+'   ['+pre.join(' / ')+']');
  for (const l of out) console.log('    '+l);
}
const c2=new CliSession(sw,t,sim); c2.run('enable');
console.log('$ SW1 show vrrp (L2):'); for (const l of c2.run('show vrrp').output) console.log('    '+l);
const c3=new CliSession(r,t,sim);
console.log('$ (no enable) clear counters:'); for (const l of c3.run('clear counters').output) console.log('    '+l);
