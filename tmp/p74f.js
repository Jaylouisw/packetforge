const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));const R=c.find(s=>s.model==='generic-router');
const t=new Topology();const r=t.addDevice(R);r.name='R1';
const s=new CliSession(r,t,new Simulator(t));s.run('enable');s.run('configure terminal');
s.run('interface Gi0/0');s.run('mtu 1400');s.run('speed 100');s.run('duplex full');s.run('exit');s.run('end');
console.log(s.run('show running-config').output.join('\n'));
