const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const R=c.find(s=>s.model==='generic-router');
const t=new Topology();const r1=t.addDevice(R);r1.name='R1';const r2=t.addDevice(R);r2.name='R2';
t.connect(r1.id,'Gi0/0',r2.id,'Gi0/0');const sim=new Simulator(t);
const cfg=(d,cmds)=>{const s=new CliSession(d,t,sim);s.run('enable');s.run('configure terminal');for(const x of cmds)s.run(x);s.run('end');return s;};
cfg(r1,['interface Gi0/0','ip address 10.0.0.1 255.255.255.0','exit','ospf router-id 1.1.1.1','ospf area 0']);
cfg(r2,['interface Gi0/0','ip address 10.0.0.2 255.255.255.0','exit','interface Gi0/1','ip address 10.9.9.2 255.255.255.0','exit','ospf router-id 2.2.2.2','ospf area 0']);
const s=new CliSession(r1,t,sim);s.run('enable');
console.log('ping neighbour:', s.run('ping 10.0.0.2 count 2').output.slice(-2).join(' | '));
console.log('R2 route to 10.0.0.1:', JSON.stringify(r2.routeTo('10.0.0.1')));
const res = sim.ping(r1.id, '10.9.9.2', {count:2});
console.log('sim.ping replies:', JSON.stringify(res.replies));
try { console.log('events:', (sim.events||sim.eventLog||[]).slice(-8).map(e=>e.type||e.kind||JSON.stringify(e).slice(0,80)).join(' | ')); } catch(e) { console.log('no events', e.message); }
console.log('keys:', Object.keys(sim).slice(0,20).join(','));
