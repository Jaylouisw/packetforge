const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch');
const t=new Topology();const r1=t.addDevice(R);r1.name='R1';const sw=t.addDevice(SW);sw.name='SW1';
t.connect(r1.id,'Gi0/0',sw.id,'Fa0/1');const sim=new Simulator(t);
const s=new CliSession(sw,t,sim);s.run('enable');s.run('configure terminal');
for (const x of ['vlan 10','exit','interface Fa0/1','switchport mode trunk','switchport trunk allowed vlan 10','exit']) {
  console.log('$ '+x+'  ->  '+JSON.stringify(s.run(x).output));
}
const i=sw.interfaces.get('Fa0/1'); console.log('fields:', JSON.stringify(i.vlan));
