const {Topology,Simulator,CliSession}=require('../engine');
const {loadCatalog}=require('../devices/registry');
const cat=loadCatalog('C:/Users/jay/packetforge/devices');
const model=(m)=>cat.find(x=>x.model===m);
function lab(){
  const t=new Topology();
  const r1=t.addDevice(model('generic-router')); r1.name='R1';
  const r2=t.addDevice(model('generic-router')); r2.name='R2';
  const sw=t.addDevice(model('CX 6000 24G CL4 PoE 4SFP 370W')); sw.name='SW1';
  const pc=t.addDevice(model('generic-pc')); pc.name='PC1';
  t.connect(r1.id,'Gi0/0',sw.id,'1/1/1');
  t.connect(r2.id,'Gi0/0',sw.id,'1/1/2');
  t.connect(pc.id,'eth0',sw.id,'1/1/3');
  const sim=new Simulator(t);
  const c1=new CliSession(r1,t,sim); c1.run('enable');
  const cfg=['configure terminal','interface Gi0/0','ip address 10.0.1.1 255.255.255.0','no shutdown','exit',
    'interface Gi0/1','ip address 10.0.2.1 255.255.255.0','exit','ospf router-id 1.1.1.1','ospf area 0',
    'ip dhcp pool p1','network 10.0.2.0 255.255.255.0','default-router 10.0.2.1','range 10.0.2.10 10.0.2.20','exit',
    'ip route 10.9.9.0 255.255.255.0 10.0.1.254','exit'];
  for (const line of cfg) c1.run(line);
  const c2=new CliSession(r2,t,sim); c2.run('enable');
  for (const line of ['configure terminal','interface Gi0/0','ip address 10.0.1.2 255.255.255.0','no shutdown','exit','ospf router-id 2.2.2.2','ospf area 0','exit']) c2.run(line);
  const cs=new CliSession(sw,t,sim); cs.run('enable');
  const cp=new CliSession(pc,t,sim);
  return {t,sim,c1,c2,cs,cp};
}
const env=lab();
const show=(cl,label,cmd)=>{const o=cl.run(cmd).output;console.log('--- '+label+': '+cmd);for(const l of o.slice(0,8))console.log('   ',l);};
// fresh: nothing has run yet
show(env.c1,'fresh','show ip route');
show(env.c1,'fresh','show ip ospf neighbor');
show(env.c1,'fresh','show ip bgp');
show(env.c1,'fresh','show ip dhcp binding');
show(env.cs,'fresh','show lldp neighbors');
show(env.cs,'fresh','show spanning-tree');
show(env.cp,'fresh','show ip interface brief');
