const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const R=c.find(s=>s.model==='generic-router'),PC=c.find(s=>s.model==='generic-pc');
function lab(){
  const t=new Topology();const r=t.addDevice(R),pc=t.addDevice(PC);r.name='R1';pc.name='PC1';
  t.connect(pc.id,'eth0',r.id,'Gi0/0');
  const sim=new Simulator(t);const mk=d=>{const s=new CliSession(d,t,sim);s.run('enable');return s;};
  const a=mk(r),sp=mk(pc);
  const cfg=(s,cm)=>{s.run('configure terminal');const o=[];for(const x of cm)o.push.apply(o,s.run(x).output);s.run('end');return o;};
  cfg(sp,['hostname PC1','interface eth0','ip address 10.0.0.50 255.255.255.0','exit']);
  cfg(a,['hostname R1','interface Gi0/0','ip address 10.0.0.1 255.255.255.0','exit']);
  return {t,sim,r,pc,a,sp,cfg};
}
let e=lab();
console.log('pc mac:', e.pc.interfaces.get('eth0').mac);
console.log('== arp verb:');
console.log(e.cfg(e.a,['arp 10.0.0.50 0011.2233.4455 arpa']).join('\n'));
console.log('== show arp:'); e.a.run('show arp').output.forEach(l=>console.log('  '+l));
console.log('== show ip arp 10.0.0.50:'); e.a.run('show ip arp 10.0.0.50').output.forEach(l=>console.log('  '+l));
console.log('== ping (should use static mac, no arp request):');
const before=e.sim.events?e.sim.events.length:0;
e.a.run('ping 10.0.0.50 count 1').output.forEach(l=>console.log('  '+l));
const ev=(e.sim.events||[]).slice(before);
console.log('  events:', ev.map(x=>x.type+(x.via?'/'+x.via:'')).join(', '));
console.log('== clear arp:'); e.a.run('clear arp').output.forEach(l=>console.log('  '+l));
e.a.run('show arp').output.forEach(l=>console.log('  '+l));
console.log('== bad words:');
for(const cm of ['arp 10.0.0.9 0011.2233','arp 10.0.0.9 zz:11:22:33:44:55','arp 10.0.0.9 0100.5e00.0001','arp abc 0011.2233.4455','arp 10.0.0.9','no arp','no arp 10.0.0.77','arp 10.0.0.50 0011.2233.4455 arpa extra'])
  console.log('  $ '+cm+'\n    '+e.cfg(e.a,[cm]).join('\n    '));
console.log('== dump:'); e.a.run('show running-config').output.filter(l=>/^arp /.test(l)).join('\n');
