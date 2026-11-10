const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const SW=c.find(s=>s.model==='generic-switch'),PC=c.find(s=>s.model==='generic-pc');
const t=new Topology();const sw=t.addDevice(SW);sw.name='SW1';
const p1=t.addDevice(PC);p1.name='PC1';const p2=t.addDevice(PC);p2.name='PC2';
t.connect(p1.id,'eth0',sw.id,'Fa0/1');t.connect(p2.id,'eth0',sw.id,'Fa0/2');
const sim=new Simulator(t);const s=new CliSession(sw,t,sim);s.run('enable');
for (const [pc,a] of [[p1,'10.0.30.1'],[p2,'10.0.30.2']]){const ps=new CliSession(pc,t,sim);ps.run('enable');ps.run('configure terminal');ps.run('interface eth0');ps.run('ip address '+a+' 255.255.255.0');ps.run('end');}
s.run('configure terminal'); s.run('vlan 30');
for (const p of ['Fa0/1','Fa0/2']) { s.run('interface '+p); s.run('switchport mode access'); s.run('switchport access vlan 30'); s.run('exit'); }
s.run('end');
const R=(x)=>{const o=new CliSession(x===null?sw:(x),t,sim); return o;};
console.log('ping before:', s.run('ping 10.0.30.2 count 1').output.join(' | '));
console.log('show vlan before:', s.run('show vlan').output.join(' | '));
s.run('configure terminal'); console.log('no vlan 30:', s.run('no vlan 30').output.join(' | ')); s.run('end');
console.log('show vlan after:', s.run('show vlan').output.join(' | '));
const p=s.run('show ip interface brief').output; console.log('intf brief:', p.join(' | '));
console.log('ping after:', s.run('ping 10.0.30.2 count 1').output.join(' | '));
console.log('running-config after:', s.run('show running-config').output.join(' | '));
console.log('port detail:', s.run('show interfaces Fa0/1').output.join(' | '));
