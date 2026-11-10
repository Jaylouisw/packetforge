const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const R=c.find(s=>s.model==='generic-router'),PC=c.find(s=>s.model==='generic-pc');
const t=new Topology();const r1=t.addDevice(R);r1.name='R1';const r2=t.addDevice(R);r2.name='R2';const pc=t.addDevice(PC);pc.name='PC2';
t.connect(r1.id,'Gi0/0',r2.id,'Gi0/0');t.connect(r2.id,'Gi0/1',pc.id,'eth0');
const sim=new Simulator(t);
const cfg=(d,cmds)=>{const s=new CliSession(d,t,sim);s.run('enable');s.run('configure terminal');for(const x of cmds)s.run(x);s.run('end');return s;};
cfg(r1,['interface Gi0/0','ip address 10.0.0.1 255.255.255.252','exit']);
cfg(r2,['interface Gi0/0','ip address 10.0.0.2 255.255.255.252','exit','interface Gi0/1','ip address 192.168.2.1 255.255.255.0','exit']);
cfg(pc,['interface eth0','ip address 192.168.2.10 255.255.255.0','exit','ip default-gateway 192.168.2.1']);
const s=cfg(r1,[]);
const p=(x)=>{console.log('R1(config)#'+x);s.run('configure terminal');const o=s.run(x).output;o.forEach(l=>console.log(l));s.run('end');};
console.log('R1#configure terminal');
for (const x of ['ip route abc 255.0.0.0 1.1.1.1','ip route 192.168.2.0 255.255.255.0 abc',
  'ip route 192.168.2.0 255.255.255.0 10.0.0.2 250','ip route 192.168.2.0 255.255.255.0 Gi0/0',
  'ip route 10.9.9.0 255.255.255.0','ip route 192.168.2.0 255.255.255.0 10.0.0.2']) p(x);
console.log('R1(config)#no ip route 10.9.9.0 255.255.255.0'); s.run('configure terminal'); s.run('no ip route 10.9.9.0 255.255.255.0').output.forEach(l=>console.log(l)); s.run('end');
console.log('R1(config)#no ip route 192.168.2.0 255.255.255.0'); s.run('configure terminal'); s.run('no ip route 192.168.2.0 255.255.255.0').output.forEach(l=>console.log(l)); s.run('end');
s.run('configure terminal'); s.run('ip route 192.168.2.0 255.255.255.0 10.0.0.2'); s.run('end');
console.log('R1#show ip route'); s.run('show ip route').output.forEach(l=>console.log(l));
console.log('R1#ping 192.168.2.10 count 2'); s.run('ping 192.168.2.10 count 2').output.forEach(l=>console.log(l));
console.log('PC2(config)#ip default-gateway abc'); const pcS=cfg(pc,[]); pcS.run('configure terminal'); pcS.run('ip default-gateway abc').output.forEach(l=>console.log(l));
