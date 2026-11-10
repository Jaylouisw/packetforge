const {Topology,Simulator}=require('../engine');
const {CliSession}=require('../engine/cli');
const {loadCatalog}=require('../devices/registry');
const catalog=loadCatalog('C:/Users/jay/packetforge/devices');
const mk=(n)=>catalog.find(x=>x.model===n);
const t=new Topology(); const r=t.addDevice(mk('generic-router')); r.name='R1';
const sw=t.addDevice(mk('generic-switch')); sw.name='SW1';
const pc=t.addDevice(mk('generic-pc')); pc.name='PC1';
t.connect(pc.id,'eth0',r.id,'Gi0/0'); t.connect(sw.id,'Fa0/1',r.id,'Gi0/1');
const sim=new Simulator(t); const s=new CliSession(r,t,sim); s.run('enable'); s.run('ping 10.0.0.1 count 1');
const cases=[
 'show vlan 99','show vlan abc','show power inline 1/1/9','show lldp neighbors 1/1/9',
 'show ip ospf neighbor extra','show ip bgp extra','show ip bgp neighbor extra',
 'show logging last 1.5','show logging last 0x10','show logging last  3','show logging last +2',
 'show logging extra','show logging summary extra','show logging drop extra',
 'show flows counters 99','show flows 1 extra',
 'converge abc','converge -1','converge 100 extra',
 'show interfaces counters Gi0/0 extra','show arp Gi0/0 extra',
 'show mac address-table interface Gi0/0 extra','show spanning-tree at 100 extra',
 'show ip route connected extra','show ip route summary extra',
 'show ip interface brief Gi0/0 extra','show interfaces Gi0/0 extra','show interfaces transceiver Gi0/0 extra',
 'show dns extra','show scion paths extra','show dhcp binding extra',
 'show power inline extra','show clock extra','show version extra',
];
for (const c of cases){ const o=s.run(c).output; console.log('$ '+c+'\n    '+(o.join('\n    ')||'(no output)')); }
