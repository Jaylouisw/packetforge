const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const SW=c.find(s=>s.model==='generic-switch'),PC=c.find(s=>s.model==='generic-pc');
function lab(mode){
  const t=new Topology();const sw=t.addDevice(SW),p1=t.addDevice(PC);
  sw.name='SW1';p1.name='PC1';
  const ports=[...sw.interfaces.keys()].filter(n=>!sw.interfaces.get(n).svi);
  t.connect(p1.id,'eth0',sw.id,ports[0]);
  const sim=new Simulator(t);const mk=d=>{const s=new CliSession(d,t,sim);s.run('enable');return s;};
  const a=mk(sw),s1=mk(p1);
  const cfg=(s,cm)=>{s.run('configure terminal');const o=[];for(const x of cm)o.push.apply(o,s.run(x).output);s.run('end');return o;};
  cfg(s1,['hostname PC1','interface eth0','ip address 10.0.0.50 255.255.255.0','exit']);
  cfg(a,['interface '+ports[0],'switchport mode access','switchport port-security','switchport port-security violation '+mode]);
  return {t,sim,sw,p1,a,s1,cfg,port:ports[0]};
}
function speak(e, mac, ip){
  const frame={etherType:0x0806, srcMac:mac, dstMac:'ff:ff:ff:ff:ff:ff',
    arp:{op:'request', senderMac:mac, senderIp:ip, targetMac:'00:00:00:00:00:00', targetIp:'10.0.0.254'}};
  const n=(e.sim.events||[]).length;
  e.sim._processFrame(e.sw, frame, e.port);
  return (e.sim.events||[]).slice(n).map(x=>x.type+(x.mode?'/'+x.mode:'')+(x.errDisabled?'/err':''))
    .concat(['cam='+JSON.stringify(Array.from(e.sw.macTableFor(1).keys()))]);
}
for(const mode of ['shutdown','restrict','protect']){
  const e=lab(mode);
  const mac1=e.p1.interfaces.get('eth0').mac;
  console.log('== '+mode);
  console.log('  host 1st :', speak(e, mac1, '10.0.0.50').join(', '));
  console.log('  host 2nd :', speak(e, mac1, '10.0.0.50').join(', '));
  console.log('  intruder :', speak(e, '02:00:00:00:99:99', '10.0.0.99').join(', '));
  console.log('  intruder2:', speak(e, '02:00:00:00:99:99', '10.0.0.99').join(', '));
  const sum=e.a.run('show port-security').output;
  console.log('  ' + sum.filter(l=>l.includes('Fa0/1')||l.includes('violation')||l.includes('err-disabled')).join(' | '));
  console.log('  status:', e.a.run('show interfaces status').output.find(l=>l.startsWith(e.port)));
  console.log('  detail:', e.a.run('show port-security interface '+e.port).output.filter(l=>/Status|Violation Count|Last/.test(l)).map(l=>l.trim()).join(' | '));
  console.log('  addr  :', e.a.run('show port-security address').output.filter(l=>l.startsWith('02')||l.includes('secure address')).join(' | '));
}
