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
// next-hop form
let a=lab(); let s1=a.cfg(a.r1,['ip route 192.168.2.0 255.255.255.0 10.0.0.2']);
console.log('next-hop form:', s1.run('ping 192.168.2.10 count 4').output.slice(-2).join(' | '), '=', rate(s1,'192.168.2.10'));
console.log('running-config:', s1.run('show running-config').output.filter(l=>/route/.test(l)).join(' | '));
console.log('show ip route:', s1.run('show ip route').output.slice(-2).join(' | '));
// interface-only form
let b=lab(); let s2=b.cfg(b.r1,['ip route 192.168.2.0 255.255.255.0 Gi0/0']);
console.log('iface-only add:', s2.run('configure terminal').output.concat(['x']).slice(0,1).join(''), s2.run('interface Gi0/0').output.join(''));
s2.run('exit');
console.log('iface-only ping:', s2.run('ping 192.168.2.10 count 4').output.slice(-2).join(' | '), '= rate', rate(s2,'192.168.2.10'));
console.log('iface-only running-config:', s2.run('show running-config').output.filter(l=>/route/.test(l)).join(' | '));
console.log('iface-only show ip route:', s2.run('show ip route').output.slice(-2).join(' | '));
