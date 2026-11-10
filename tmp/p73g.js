const path=require('path');const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));const R=c.find(s=>s.model==='generic-router');
const t=new Topology();const r=t.addDevice(R);const s=new CliSession(r,t,new Simulator(t));s.run('enable');s.run('configure terminal');
['no span?','no rou?','no ip route?','no ospf ?','no vlan ?','no ip nat ?','no bgp neighbor ?','no ip name-server ?'].forEach(x=>{console.log('$ '+x);s.run(x).output.forEach(l=>console.log('  |'+l));});
