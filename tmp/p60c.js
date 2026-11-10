const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const R=c.find(s=>s.model==='generic-router');
function lab(a1,a2){const t=new Topology();const r1=t.addDevice(R);r1.name='R1';const r2=t.addDevice(R);r2.name='R2';
 t.connect(r1.id,'Gi0/0',r2.id,'Gi0/0');const sim=new Simulator(t);
 const cfg=(d,cmds)=>{const s=new CliSession(d,t,sim);s.run('enable');s.run('configure terminal');for(const x of cmds)s.run(x);s.run('end');return s;};
 cfg(r1,['interface Gi0/0','ip address 10.0.0.1 255.255.255.0','exit','ospf router-id 1.1.1.1','ospf area '+a1]);
 cfg(r2,['interface Gi0/0','ip address 10.0.0.2 255.255.255.0','exit','interface Gi0/1','ip address 10.9.9.2 255.255.255.0','exit','ospf router-id 2.2.2.2','ospf area '+a2]);
 const s=new CliSession(r1,t,sim);s.run('enable');
 return {s,r1,r2,sim};}
for (const [a,b,label] of [['0','0','both area 0'],['0.0.0.1','1','dotted 0.0.0.1 vs 1'],['255.255.255.255','255','dotted all-ones vs 255'],['1','2','1 vs 2 (must differ)']]) {
 const L=lab(a,b);
 const ospf=L.s.run('show ip route ospf').output.join(' | ');
 const nb=L.s.run('show ip ospf neighbor').output.join(' | ');
 console.log(label.padEnd(30), 'neighbor:', /FULL/.test(nb)?'FULL':'none', '| ospf routes:', (ospf.match(/O\s+10\.9\.9/g)||['none']).length>0?'learned 10.9.9.0':'no 10.9.9.0');
}
