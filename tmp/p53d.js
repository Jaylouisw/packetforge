const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const SW=c.find(s=>s.model==='generic-switch');
function mk(){const t=new Topology();const sw=t.addDevice(SW);sw.name='SW1';return {t,sw,s:new CliSession(sw,t,new Simulator(t))};}
const a=mk(); a.s.run('enable'); a.s.run('configure terminal'); a.s.run('vlan 30'); a.s.run('interface Fa0/1'); a.s.run('switchport access vlan 30'); a.s.run('end');
const rc=a.s.run('show running-config').output;
const b=mk(); b.s.run('enable'); b.s.run('configure terminal');
for (const line of rc) { const o=b.s.run(line).output; console.log('  '+JSON.stringify(line)+' -> '+JSON.stringify(o)); }
b.s.run('end');
console.log('vlans:', JSON.stringify(b.sw.config.vlans));
console.log('RENDEZVOUS ok?');
const rc2=b.s.run('show running-config').output;
console.log('DIFF:', JSON.stringify(rc.filter(l=>!/^!/.test(l)))===JSON.stringify(rc2.filter(l=>!/^!/.test(l))) ? 'identical' : 'DIFFERENT');
console.log('  a:', JSON.stringify(rc.filter(l=>!/^!/.test(l))));
console.log('  b:', JSON.stringify(rc2.filter(l=>!/^!/.test(l))));
