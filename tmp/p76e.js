const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));const SW=c.find(s=>s.model==='generic-switch');
const t=new Topology();const sw=t.addDevice(SW);sw.name='SW1';
const sim=new Simulator(t);const s=new CliSession(sw,t,sim);s.run('enable');s.run('configure terminal');
s.run('interface vlan 30');s.run('ip address 10.30.0.1 255.255.255.0');s.run('end');
const o=s.run('show ip interface Vlan30').output;o.forEach(l=>console.log('|'+l));
