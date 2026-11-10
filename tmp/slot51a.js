const {Topology,Simulator}=require('../engine');
const {CliSession}=require('../engine/cli');
const {loadCatalog}=require('../devices/registry');
const catalog=loadCatalog('C:/Users/jay/packetforge/devices');
const mk=(n)=>catalog.find(x=>x.model===n);
const t=new Topology(); const r=t.addDevice(mk('generic-router')); r.name='R1';
const sw=t.addDevice(mk('generic-switch')); sw.name='SW1';
const pc=t.addDevice(mk('generic-pc')); pc.name='PC1';
t.connect(pc.id,'eth0',r.id,'Gi0/0'); t.connect(sw.id,'Fa0/1',r.id,'Gi0/1');
const sim=new Simulator(t); const s=new CliSession(r,t,sim); s.run('enable');
s.run('ping 10.0.0.1 count 1');
const cases=[
 'show logging last','show logging last abc','show logging last 0','show logging last -2','show logging last 1e3',
 'show logging device','show logging device NOPE','show logging summary last 2',
 'show interfaces counters gi0/x','show interfaces transceiver gi0/x',
 'show flows 99','show flows abc','show flows counters extra',
 'show ip route at','show ip route 10.0.0.0/33','show ip route 10.0.0.1 at abc',
 'show ip dhcp binding at abc','show spanning-tree 1/1/9','show arp 1/1/9',
 'flow close','flow close 99','flow close abc',
 'clear counters 1/1/9','converge 5000 extra',
 'show vlan 99','show vlan abc','show power inline 1/1/9',
 'show lldp neighbors 1/1/9','show ip ospf neighbor extra','show ip bgp extra',
];
for (const c of cases){ const o=s.run(c).output; console.log('$ '+c+'\n    '+(o.join('\n    ')||'(no output)')); }
