const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const R=c.find(s=>s.model==='generic-router');
function lab(a1,a2,a3){const t=new Topology();const r1=t.addDevice(R);r1.name='R1';const r2=t.addDevice(R);r2.name='R2';
 t.connect(r1.id,'Gi0/0',r2.id,'Gi0/0');const sim=new Simulator(t);
 const cfg=(d,cmds)=>{const s=new CliSession(d,t,sim);s.run('enable');s.run('configure terminal');for(const x of cmds)s.run(x);s.run('end');return s;};
 cfg(r1,['interface Gi0/0','ip address 10.0.0.1 255.255.255.0','exit','ospf router-id 1.1.1.1','ospf area '+a1]);
 cfg(r2,['interface Gi0/0','ip address 10.0.0.2 255.255.255.0','exit','interface Gi0/1','ip address 10.9.9.2 255.255.255.0','exit','ospf router-id 2.2.2.2','ospf area '+a2]);
 if (a3 !== undefined) { const s=new CliSession(r1,t,sim); s.run('enable'); s.run('configure terminal'); s.run('interface Gi0/0'); s.run('ip ospf area '+a3); s.run('end'); }
 const s=new CliSession(r1,t,sim);s.run('enable');
 return {s,r1,r2,sim};}
for (const [a,b,a3,label] of [['0','0',undefined,'both area 0'],['0.0.0.1','1',undefined,'dotted 0.0.0.1 vs 1'],['255.255.255.255','255',undefined,'dotted all-ones vs 255'],['1','2',undefined,'1 vs 2 (must differ)'],['1','2','2','per-interface override back to 2']]) {
 const L=lab(a,b,a3);
 const nb=L.s.run('show ip ospf neighbor').output.join('\n');
 const rt=L.s.run('show ip route ospf').output.join('\n');
 console.log('--- '+label);
 console.log('  neighbor:', /FULL/.test(nb)?'FULL':'none', '| route:', /10\.9\.9/.test(rt)?'learned':'absent');
 const m=nb.split('\n').filter(l=>/area/.test(l)); if(m.length) console.log('  says:', m.join(' / '));
}
