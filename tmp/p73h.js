const path=require('path');const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));const R=c.find(s=>s.model==='generic-router');
const t=new Topology();const r=t.addDevice(R);const s=new CliSession(r,t,new Simulator(t));s.run('enable');s.run('configure terminal');s.run('interface Gi0/0');
console.log(JSON.stringify(s.run('ipv6 nd suppress-ra extra').output,null,0));
console.log(JSON.stringify(s.run('wibble').output));
