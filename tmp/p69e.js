const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const SW=c.find(s=>s.model==='generic-switch');
const t=new Topology();const s1=t.addDevice(SW);s1.name='SW1';const sim=new Simulator(t);
const s=new CliSession(s1,t,sim);s.run('enable');
s.run('configure terminal','spanning-tree vlan 1 priority 4096','interface Fa0/1','spanning-tree cost 100','exit','end');
s.run('show running-config').output.forEach(l=>console.log(l));
console.log('--- help rows containing spanning:');
s.run('configure terminal');s.run('help').output.filter(l=>/spanning/.test(l)).forEach(l=>console.log(l));
s.run('interface Fa0/1');s.run('help').output.filter(l=>/spanning/.test(l)).forEach(l=>console.log(l));
