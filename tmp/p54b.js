const path=require('path');
const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const catalog=loadCatalog('C:/Users/jay/packetforge/devices');
const SWITCH=catalog.find(s=>s.model==='generic-switch'),PC=catalog.find(s=>s.model==='generic-pc');
function switchLab(){
  const t=new Topology();const sw=t.addDevice(SWITCH);sw.name='SW1';
  const pc1=t.addDevice(PC);pc1.name='PC1';const pc2=t.addDevice(PC);pc2.name='PC2';
  t.connect(pc1.id,'eth0',sw.id,'Fa0/1');t.connect(pc2.id,'eth0',sw.id,'Fa0/2');
  const sim=new Simulator(t);const c=new CliSession(sw,t,sim);c.run('enable');
  for (const [pc,addr] of [[pc1,'10.0.30.1'],[pc2,'10.0.30.2']]){
    const ps=new CliSession(pc,t,sim);ps.run('enable');ps.run('configure terminal');ps.run('interface eth0');
    ps.run('ip address '+addr+' 255.255.255.0');ps.run('end');
  }
  const host=(pc)=>{const h=new CliSession(pc,t,sim);h.run('enable');return h;};
  return {t,sw,pc1,pc2,sim,c,host};
}
function twoPortsIn30(){
  const l=switchLab();l.c.run('configure terminal');l.c.run('vlan 30');
  for (const port of ['Fa0/1','Fa0/2']){l.c.run('interface '+port);l.c.run('switchport mode access');l.c.run('switchport access vlan 30');l.c.run('exit');}
  l.c.run('end');return l;
}
const l=twoPortsIn30();
console.log('ping:', l.host(l.pc1).run('ping 10.0.30.2 count 1').output.join(' | '));
console.log('show vlan:', l.c.run('show vlan').output.join(' | '));
console.log('intf Fa0/1:', l.c.run('show interfaces Fa0/1').output.slice(0,3).join(' | '));
const pc1Addr = l.pc1.config;
console.log('pc1 config:', JSON.stringify(pc1Addr.interfaces ? Array.from(pc1Addr.interfaces.entries()).slice(0,1) : pc1Addr));
