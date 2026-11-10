const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const R=c.find(s=>s.model==='generic-router'),PC=c.find(s=>s.model==='generic-pc');
function lab(){const t=new Topology();
 const r1=t.addDevice(R);r1.name='R1';const r2=t.addDevice(R);r2.name='R2';const pc=t.addDevice(PC);pc.name='PC2';
 t.connect(r1.id,'Gi0/0',r2.id,'Gi0/0');t.connect(r2.id,'Gi0/1',pc.id,'eth0');
 const sim=new Simulator(t);
 const cfg=(d,cmds)=>{const s=new CliSession(d,t,sim);s.run('enable');s.run('configure terminal');for(const x of cmds)s.run(x);s.run('end');return s;};
 cfg(r1,['interface Gi0/0','ip address 10.0.0.1 255.255.255.252','exit']);
 cfg(r2,['interface Gi0/0','ip address 10.0.0.2 255.255.255.252','exit','interface Gi0/1','ip address 192.168.2.1 255.255.255.0','exit']);
 cfg(pc,['interface eth0','ip address 192.168.2.10 255.255.255.0','exit','ip default-gateway 192.168.2.1']);
 return {t,r1,r2,sim,cfg};}
const rate=(s,dst)=>{const m=/Success rate is (\d+) percent/.exec(s.run('ping '+dst+' count 4').output.join(' '));return m?Number(m[1]):null;};
let b=lab(); const s2=b.cfg(b.r1,['ip route 192.168.2.0 255.255.255.0 Gi0/0']);
console.log('add:', s2.run('configure terminal').output.join('')); s2.run('ip route 192.168.2.0 255.255.255.0 Gi0/0'); s2.run('end');
console.log('iface-only ping rate:', rate(s2,'192.168.2.10'));
console.log('running-config:', JSON.stringify(s2.run('show running-config').output.filter(l=>/route/.test(l))));
console.log('ping detail:', s2.run('ping 192.168.2.10 count 2').output.slice(-3).join(' | '));
