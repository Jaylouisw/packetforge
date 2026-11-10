const path=require('path');const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));const SW=c.find(s=>s.model==='generic-switch');const R=c.find(s=>s.model==='generic-router');
const t=new Topology();const d=t.addDevice(SW);const s=new CliSession(d,t,new Simulator(t));s.run('enable');s.run('configure terminal');s.run('interface Fa0/1');
['ipv6 nd suppress-ra','ipv6 address 2001:db8::1/64','ip ospf cost 10','no encapsulation dot1q','encapsulation dot1q 20'].forEach(x=>console.log('SW '+x+' => '+s.run(x).output.join(' | ')));
const t2=new Topology();const r=t2.addDevice(R);const s2=new CliSession(r,t2,new Simulator(t2));s2.run('enable');s2.run('configure terminal');
console.log('--- no ip rou? =>'); s2.run('no ip rou?').output.forEach(l=>console.log('   '+l));
