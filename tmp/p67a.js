const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const R=c.find(s=>s.model==='generic-router'),PC=c.find(s=>s.model==='generic-pc');
// DHCP server on R1, client PC
const t=new Topology();const r1=t.addDevice(R);r1.name='R1';const pc=t.addDevice(PC);pc.name='PC1';
t.connect(r1.id,'Gi0/0',pc.id,'eth0');const sim=new Simulator(t);
const cfg=(d,cmds,tag)=>{const s=new CliSession(d,t,sim);s.run('enable');s.run('configure terminal');for(const x of cmds){const o=s.run(x).output;if(o.some(l=>/^%/.test(l)))console.log('  REFUSED ['+(tag||d.name)+'] '+x+' => '+o[0]);}s.run('end');return s;};
const sr=cfg(r1,['interface Gi0/0','ip address 192.168.5.1 255.255.255.0','exit','ip dhcp pool LAN','network 192.168.5.0 255.255.255.0','default-router 192.168.5.1','dns-server 192.168.5.1','exit']);
const sp=cfg(pc,['interface eth0','ip address dhcp','exit'],'PC1');
const show=(s,x)=>{console.log('$ ['+s.mode+'] '+x);const o=s.run(x).output;o.forEach(l=>console.log('   '+l));if(!o.length)console.log('   (SILENT)');};
show(sp,'show ip interface brief');
show(sp,'show ip dhcp binding');
show(sp,'ping 192.168.5.1 count 2');
show(sp,'renew dhcp');
show(sp,'release dhcp');
show(sp,'show ip interface brief');
show(sr,'show ip dhcp pool');
show(sr,'show ip dhcp binding');
show(sr,'show running-config');
