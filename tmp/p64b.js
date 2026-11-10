const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch');
// clean router, no connections at all
{const t=new Topology();const r=t.addDevice(R);r.name='R1';const s=new CliSession(r,t,new Simulator(t));s.run('enable');
 console.log('--- clean router running-config:'); s.run('show running-config').output.forEach(l=>console.log('  '+l));
 console.log('--- switchport fields:', JSON.stringify([...r.interfaces.values()].map(i=>({n:i.name,mode:i.mode,vlan:i.accessVlan,native:i.trunkNative,allowed:i.trunkAllowed}))));
}
// router cabled to a trunk port of a switch
{const t=new Topology();const r=t.addDevice(R);r.name='R1';const sw=t.addDevice(SW);sw.name='SW1';
 t.connect(r.id,'Gi0/0',sw.id,'Fa0/1');const sim=new Simulator(t);
 const cfg=(d,cmds)=>{const s=new CliSession(d,t,sim);s.run('enable');s.run('configure terminal');for(const x of cmds)s.run(x);s.run('end');return s;};
 const sws=cfg(sw,['interface Fa0/1','switchport mode trunk','switchport trunk allowed vlan 10,20','exit']);
 const rs=cfg(r,['interface Gi0/0','ip address 10.0.0.1 255.255.255.0','exit']);
 console.log('--- cabled-to-trunk router running-config:'); rs.run('show running-config').output.forEach(l=>console.log('  '+l));
 console.log('--- R1 Gi0/0 switchport fields:', JSON.stringify((()=>{const i=r.interfaces.get('Gi0/0');return {mode:i.mode,vlan:i.accessVlan,native:i.trunkNative,allowed:i.trunkAllowed};})()));
}
