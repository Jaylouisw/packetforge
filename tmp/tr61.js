const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const R=c.find(s=>s.model==='generic-router'),PC=c.find(s=>s.model==='generic-pc');
const t=new Topology();const pc=t.addDevice(PC);pc.name='PC1';const r1=t.addDevice(R);r1.name='R1';const pc2=t.addDevice(PC);pc2.name='PC2';
t.connect(pc.id,'eth0',r1.id,'Gi0/0');t.connect(pc2.id,'eth0',r1.id,'Gi0/1');const sim=new Simulator(t);
const cfg=(d,cmds)=>{const s=new CliSession(d,t,sim);s.run('enable');s.run('configure terminal');for(const x of cmds)s.run(x);s.run('end');return s;};
cfg(r1,['interface Gi0/0','ip address 10.1.1.1 255.255.255.0','exit','interface Gi0/1','ip address 10.2.2.1 255.255.255.0','exit']);
cfg(pc,['interface eth0','ip address 10.1.1.10 255.255.255.0','exit','ip default-gateway 10.1.1.1']);
cfg(pc2,['interface eth0','ip address 10.2.2.10 255.255.255.0','exit','ip default-gateway 10.2.2.1']);
const s=new CliSession(pc,t,sim);s.run('enable');
for (const x of ['traceroute 10.2.2.10','traceroute 10.2.2.10 numeric','traceroute 10.2.2.10 numeric at 5000','show ip arp']) {
  console.log('> '+x); console.log(s.run(x).output.join('\n'));
}
