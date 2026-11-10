const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const R=c.find(s=>s.model==='generic-router'),PC=c.find(s=>s.model==='generic-pc'),SW=c.find(s=>s.model==='generic-switch');
const t=new Topology();const r1=t.addDevice(R);r1.name='R1';const sw=t.addDevice(SW);sw.name='SW1';const pc=t.addDevice(PC);pc.name='PC1';
t.connect(pc.id,'eth0',sw.id,'Fa0/1');t.connect(sw.id,'Fa0/2',r1.id,'Gi0/0');
const sim=new Simulator(t);
const s1=new CliSession(r1,t,sim);s1.run('enable');
const cfg=(s,cmds)=>{s.run('configure terminal');cmds.forEach(x=>{const o=s.run(x).output;if(o.some(l=>/^%/.test(l)))console.log('  REFUSED: '+x+' => '+o.join(' / '));});s.run('end');};
cfg(s1,['interface Gi0/0','ip address 10.0.0.1 255.255.255.0','exit',
 'access-list 101 deny icmp any host 10.0.0.99','access-list 101 permit ip any any',
 'interface Gi0/0','ip access-group 101 in','exit']);
const sp=new CliSession(pc,t,sim);sp.run('enable');cfg(sp,['interface eth0','ip address 10.0.0.50 255.255.255.0','ip default-gateway 10.0.0.1','exit']);
const show=(s,x)=>{console.log('['+s.device.name+'] $ '+x);const o=s.run(x).output;o.forEach(l=>console.log('   '+l));if(!o.length)console.log('   (SILENT)');};
sp.run('ping 10.0.0.99 count 2');sp.run('ping 10.0.0.1 count 2');
show(s1,'show access-lists');
console.log('--- dump');
show(s1,'show running-config');
