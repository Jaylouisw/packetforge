const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const SW=c.find(s=>s.model==='generic-switch');
function mkSw(){const t=new Topology();const sw=t.addDevice(SW);sw.name='SW1';return {t,sw,s:new CliSession(sw,t,new Simulator(t))};}
const a=mkSw(); a.s.run('enable'); a.s.run('configure terminal'); a.s.run('vlan 30'); a.s.run('end');
const rc=a.s.run('show running-config').output;
console.log('RC:', JSON.stringify(rc));
const b=mkSw(); b.s.run('enable');
for (const line of rc) { const o=b.s.run(line).output; console.log('  '+JSON.stringify(line)+' -> '+JSON.stringify(o)); }
console.log('after paste, config.vlans =', JSON.stringify(b.sw.config.vlans));
console.log('show vlan:', JSON.stringify(b.s.run('show vlan').output));
