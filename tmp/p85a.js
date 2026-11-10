const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));const SW=c.find(s=>s.model==='generic-switch');
const t=new Topology();const sw=t.addDevice(SW);sw.name='SW1';
const s=new CliSession(sw,t,new Simulator(t));s.run('enable');
for(const cmd of ['show version','show interfaces counters','show cdp neighbors','show inventory','show users','show history','show processes cpu','show line','show sessions','show environment','show interfaces switchport','show switchport interface Fa0/1']){
  const o=s.run(cmd).output;console.log('=== '+cmd);o.slice(0,6).forEach(l=>console.log('  '+l));
}
