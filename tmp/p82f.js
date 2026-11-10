const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');
const {loadCatalog}=require('../devices/registry');const path=require('path');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const SW=c.find(s=>s.model==='generic-switch');
const t=new Topology();const sw=t.addDevice(SW);sw.name='SW1';
const s=new CliSession(sw,t,new Simulator(t));s.run('enable');s.run('configure terminal');
// reproduce the extra-arguments lab: vlan 10 and 20 carried, vlan 30 declared empty
for(const x of ['vlan 10','vlan 20','vlan 30','interface Fa0/1','switchport access vlan 10','exit','interface Fa0/2','switchport access vlan 20','exit'])
  s.run(x);
s.run('end');
console.log('show vlan:'); s.run('show vlan').output.forEach(l=>console.log('  '+l));
console.log('show vlan 99:'); s.run('show vlan 99').output.forEach(l=>console.log('  '+l));
