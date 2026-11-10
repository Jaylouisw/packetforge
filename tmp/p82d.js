const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');
const {loadCatalog}=require('../devices/registry');const path=require('path');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const SW=c.find(s=>s.model==='generic-switch');
const t=new Topology();const sw=t.addDevice(SW);sw.name='SW1';
const s=new CliSession(sw,t,new Simulator(t));s.run('enable');s.run('configure terminal');
for(const x of ['vlan 20 name users','vlan 30 sales','vlan 40','vlan 20 name','show vlan'])
  console.log('$ '+x+'\n  '+s.run(x).output.join('\n  '));
