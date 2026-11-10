const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const SW=c.find(s=>s.model==='generic-switch'),PC=c.find(s=>s.model==='generic-pc');
function lab(tag){
  const t=new Topology();const sw=t.addDevice(SW);sw.name='SW1';
  const p1=t.addDevice(PC);p1.name='PC1';const p2=t.addDevice(PC);p2.name='PC2';
  t.connect(p1.id,'eth0',sw.id,'Fa0/1');t.connect(p2.id,'eth0',sw.id,'Fa0/2');
  const sim=new Simulator(t);const s=new CliSession(sw,t,sim);s.run('enable');
  for (const [pc,a] of [[p1,'10.0.30.1'],[p2,'10.0.30.2']]){const ps=new CliSession(pc,t,sim);ps.run('enable');ps.run('configure terminal');ps.run('interface eth0');ps.run('ip address '+a+' 255.255.255.0');ps.run('end');}
  s.run('configure terminal');
  for (const port of ['Fa0/1','Fa0/2']){s.run('interface '+port);s.run('switchport mode access');s.run('switchport access vlan 30');s.run('exit');}
  s.run('end');
  const h=new CliSession(p1,t,sim);h.run('enable');
  console.log(tag+' ping:', h.run('ping 10.0.30.2 count 1').output.join(' | '));
  console.log(tag+' show vlan:', s.run('show vlan').output.join(' | '));
  return {t,sw,sim,s,p1};
}
const a=lab('first');
const b=lab('second');
// now the same lab but with vlan 30 declared explicitly first
const t=new Topology();const sw=t.addDevice(SW);sw.name='SW1';
const p1=t.addDevice(PC);p1.name='PC1';const p2=t.addDevice(PC);p2.name='PC2';
t.connect(p1.id,'eth0',sw.id,'Fa0/1');t.connect(p2.id,'eth0',sw.id,'Fa0/2');
const sim=new Simulator(t);const s=new CliSession(sw,t,sim);s.run('enable');
for (const [pc,ad] of [[p1,'10.0.30.1'],[p2,'10.0.30.2']]){const ps=new CliSession(pc,t,sim);ps.run('enable');ps.run('configure terminal');ps.run('interface eth0');ps.run('ip address '+ad+' 255.255.255.0');ps.run('end');}
s.run('configure terminal'); s.run('vlan 30');
for (const port of ['Fa0/1','Fa0/2']){s.run('interface '+port);s.run('switchport mode access');s.run('switchport access vlan 30');s.run('exit');}
s.run('end');
const h=new CliSession(p1,t,sim);h.run('enable');
console.log('declared-first ping:', h.run('ping 10.0.30.2 count 1').output.join(' | '));
console.log('show vlan:', s.run('show vlan').output.join(' | '));
