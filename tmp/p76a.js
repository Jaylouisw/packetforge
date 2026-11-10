const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch'),PC=c.find(s=>s.model==='generic-pc');
const t=new Topology();const sw=t.addDevice(SW),r=t.addDevice(R),pc=t.addDevice(PC);
sw.name='SW1';r.name='R1';pc.name='PC1';
t.connect(pc.id,'eth0',sw.id,'Fa0/1');t.connect(sw.id,'Fa0/2',r.id,'Gi0/0');
const sim=new Simulator(t);const mk=d=>{const s=new CliSession(d,t,sim);s.run('enable');return s;};
const s1=mk(sw),rr=mk(r),sp=mk(pc);
const cfg=(s,cm)=>{s.run('configure terminal');cm.forEach(x=>s.run(x));s.run('end');};
cfg(sp,['hostname PC1','interface eth0','ip address 10.0.0.50 255.255.255.0','ip default-gateway 10.0.0.1','exit']);
cfg(rr,['hostname R1','interface Gi0/0','ip address 10.0.0.1 255.255.255.0','exit']);
cfg(s1,['hostname SW1','interface Fa0/1','description to PC1','exit','interface Fa0/4','description spare port (unused)','shutdown','exit']);
sp.run('ping 10.0.0.1 count 1');
const probe=(s,tag,cmds)=>{console.log('### '+tag);for(const cmd of cmds){const o=s.run(cmd).output;const bad=o.some(l=>/^%/.test(l));console.log((bad?'  MISS ':'  ok   ')+cmd+'  => '+(o[0]||'(silent)').slice(0,74));}};
probe(s1,'switch',['show interfaces status','show interfaces description','show ip interface','show ip interface brief',
 'show running-config interface Fa0/1','show run interface Fa0/1','show interfaces Fa0/1 status','show cdp neighbors',
 'show lldp','show lldp neighbors','show clock','show version','show inventory','show environment','show flash',
 'show power inline','show spanning-tree summary','show mac address-table count']);
probe(rr,'router',['show ip interface','show interfaces description','show running-config interface Gi0/0','show cdp neighbors']);
