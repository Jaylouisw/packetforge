const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch');
const t=new Topology();const r=t.addDevice(R);r.name='R1';const sw=t.addDevice(SW);sw.name='SW1';
t.connect(r.id,'Gi0/0',sw.id,'Fa0/1');const sim=new Simulator(t);
const s=new CliSession(r,t,sim);s.run('enable');
s.run('configure terminal');s.run('interface Gi0/0.20');s.run('ip address 10.20.0.1 255.255.255.0');s.run('exit');s.run('end');
const sub=r.interfaces.get('Gi0/0.20');const par=r.interfaces.get('Gi0/0');
console.log('sub fields:', JSON.stringify({encap:sub.encap,vlan:sub.vlan,dot1q:sub.dot1q,parent:sub.parent&&sub.parent.name||sub.parent}));
console.log('parent fields:', JSON.stringify({mode:par.mode,native:par.trunkNative,allowed:par.trunkAllowed,encap:par.encap}));
console.log('--- running-config:'); s.run('show running-config').output.forEach(l=>console.log('  '+l));
// can this device paste its own dump?
const t2=new Topology();const r2=t2.addDevice(R);r2.name='R1';
for (const [n,i] of [...r.interfaces.entries()]) { /* no-op */ }
const s2=new CliSession(r2,t2,new Simulator(t2));s2.run('enable');s2.run('configure terminal');
for (const line of s.run('show running-config').output) {
  const cmd=line.trim();
  if (!cmd || cmd.startsWith('!')) continue;
  const o=s2.run(cmd).output;
  if (o.some(l=>/^%/.test(l))) console.log('REFUSED on a fresh device: "'+cmd+'" -> '+o.join(' | '));
}
console.log('--- after paste, fresh device config:'); s2.run('end').output; console.log(new CliSession(r2,t2,new Simulator(t2)).run('show running-config').output.join('\n'));
