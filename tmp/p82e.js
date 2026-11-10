const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');
const {loadCatalog}=require('../devices/registry');const path=require('path');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const SW=c.find(s=>s.model==='generic-switch');
function sess(){const t=new Topology();const sw=t.addDevice(SW);sw.name='SW1';return new CliSession(sw,t,new Simulator(t));}
const s=sess();
console.log('exec (not enabled):');
s.run('clear port-security counters').output.forEach(l=>console.log('  '+l));
s.run('clear arp').output.forEach(l=>console.log('  arp: '+l));
s.run('enable');
s.run('configure terminal');
console.log('config mode:');
s.run('clear port-security counters').output.forEach(l=>console.log('  ps : '+l));
s.run('clear arp').output.forEach(l=>console.log('  arp: '+l));
