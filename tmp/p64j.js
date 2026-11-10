const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const SW=c.find(s=>s.model==='generic-switch');
const t=new Topology();const sw=t.addDevice(SW);sw.name='SW1';const s=new CliSession(sw,t,new Simulator(t));
s.run('enable');s.run('configure terminal');s.run('interface Fa0/1');
const iface=sw.interfaces.get('Fa0/1');
console.log('direct call:', JSON.stringify(s._switchport(['trunk','allowed','vlan','all'], iface)));
console.log('direct call 2:', JSON.stringify(s._switchport(['trunk','allowed','vlan','ALL'], iface)));
console.log('via run:', JSON.stringify(s.run('switchport trunk allowed vlan all').output));
console.log('tokens check:', JSON.stringify('switchport trunk allowed vlan all'.trim().split(/\s+/)));
