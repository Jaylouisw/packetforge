const path=require('path');
const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const catalog=loadCatalog('C:/Users/jay/packetforge/devices');
const SWITCH=catalog.find(s=>s.model==='generic-switch');
const PC=catalog.find(s=>s.model==='generic-pc');
const t=new Topology();const sw=t.addDevice(SWITCH);sw.name='SW1';
const mk=(n)=>{const p=t.addDevice(PC);p.name=n;return p;};
const pc1=mk('PC1'),pc2=mk('PC2'),pc3=mk('PC3');
t.connect(pc1.id,'eth0',sw.id,'Fa0/1');t.connect(pc2.id,'eth0',sw.id,'Fa0/2');t.connect(pc3.id,'eth0',sw.id,'Fa0/3');
const sim=new Simulator(t);const session=new CliSession(sw,t,sim);const s=(c)=>session.run(c).output;
console.log('enable:',JSON.stringify(s('enable')));
console.log('cfg:',JSON.stringify(s('configure terminal')));
for (const [port,vlan] of [['Fa0/1','10'],['Fa0/2','10'],['Fa0/3','20']]) {
  console.log(port, JSON.stringify(s('interface '+port)), JSON.stringify(s('switchport mode access')), JSON.stringify(s('switchport access vlan '+vlan)), JSON.stringify(s('exit')));
}
console.log('vlan30:', JSON.stringify(s('vlan 30')));
console.log('end:', JSON.stringify(s('end')));
console.log('show vlan:'); for (const l of s('show vlan')) console.log('   '+l);
console.log('show vlan 30:', JSON.stringify(s('show vlan 30')));
console.log('show vlan 99:', JSON.stringify(s('show vlan 99')));
