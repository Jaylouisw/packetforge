const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch');
function mk(spec){const t=new Topology();const d=t.addDevice(spec);const s=new CliSession(d,t,new Simulator(t));s.run('enable');return s;}
const r=mk(R), sw=mk(SW);
const q=(s,x)=>{const o=s.run(x).output;console.log('\n$ '+x);o.slice(0,14).forEach(l=>console.log('  '+l));if(!o.length)console.log('  (SILENT)');};
q(r,'show ip nat ?');q(r,'show ip ?');q(r,'clear ?');q(r,'show ip bgp ?');q(r,'show ip ospf ?');
r.run('configure terminal');
q(r,'ip nat ?');q(r,'ip ?');q(r,'no ip nat ?');
r.run('interface Gi0/0');
q(r,'ip nat ?');q(r,'?');
console.log('\n=== switch:');
sw.run('configure terminal');
q(sw,'ip nat ?');q(sw,'show ?');
