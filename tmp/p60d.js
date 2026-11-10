const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const ospf=require('../engine/ospf');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const R=c.find(s=>s.model==='generic-router');
const t=new Topology();const r1=t.addDevice(R);r1.name='R1';const r2=t.addDevice(R);r2.name='R2';
t.connect(r1.id,'Gi0/0',r2.id,'Gi0/0');const sim=new Simulator(t);
const cfg=(d,cmds)=>{const s=new CliSession(d,t,sim);s.run('enable');s.run('configure terminal');for(const x of cmds)s.run(x);s.run('end');return s;};
cfg(r1,['interface Gi0/0','ip address 10.0.0.1 255.255.255.0','exit','ospf router-id 1.1.1.1','ospf area 1']);
cfg(r2,['interface Gi0/0','ip address 10.0.0.2 255.255.255.0','exit','ospf router-id 2.2.2.2','ospf area 2']);
console.log('r1 ospf cfg:', JSON.stringify(r1.config.ospf));
console.log('r2 ospf cfg:', JSON.stringify(r2.config.ospf));
const spec={routers:[{id:'R1',...r1.config.ospf,interfaces:[{name:'Gi0/0',ip:'10.0.0.1',mask:'255.255.255.0'}]},{id:'R2',...r2.config.ospf,interfaces:[{name:'Gi0/0',ip:'10.0.0.2',mask:'255.255.255.0'}]}],links:[{a:'R1',b:'R2'}]};
const nr=ospf.validateRouter ? 'has' : 'no';
console.log('exports:', Object.keys(ospf).join(','));
console.log('areasOf?', typeof ospf.areasOf);
try { console.log('areasOf(r1):', JSON.stringify(ospf.areasOf(r1))); } catch(e) { console.log('areasOf threw', e.message); }
const graph = ospf.buildGraph ? null : null;
console.log('r1.config.ospf.interfaces:', JSON.stringify(r1.config.ospf && r1.config.ospf.interfaces));
