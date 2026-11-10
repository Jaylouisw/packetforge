const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const SW=c.find(s=>s.model==='generic-switch');
const t=new Topology();const sw=t.addDevice(SW);sw.name='SW1';
const s=new CliSession(sw,t,new Simulator(t)); s.run('enable'); s.run('configure terminal'); s.run('vlan 30'); s.run('end');
for (const cmd of ['show vlan brief','show vlan id 10','show vlan 10 brief','show vlan 99','show vlan abc','show vlan 1 2','show vlan id'])
  console.log('$ '+cmd+' -> '+s.run(cmd).output.join(' | ').slice(0,100));
