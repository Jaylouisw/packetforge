const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch');
function run(allowed) {
  const t=new Topology();const r1=t.addDevice(R);r1.name='R1';const sw=t.addDevice(SW);sw.name='SW1';const r2=t.addDevice(R);r2.name='R2';
  t.connect(r1.id,'Gi0/0',sw.id,'Fa0/1');t.connect(sw.id,'Fa0/2',r2.id,'Gi0/0');const sim=new Simulator(t);
  const cfg=(d,cmds)=>{const s=new CliSession(d,t,sim);s.run('enable');s.run('configure terminal');let bad=[];for(const x of cmds){const o=s.run(x).output;if(o.some(l=>/^%/.test(l)))bad.push(x+':'+o[0]);}s.run('end');return {s,bad};};
  const w=cfg(sw,['vlan 10','vlan 20','interface Fa0/1','switchport mode trunk','switchport trunk allowed vlan '+allowed,'exit','interface Fa0/2','switchport mode trunk','switchport trunk allowed vlan '+allowed,'exit']);
  const s1=cfg(r1,['interface Gi0/0.10','ip address 10.10.0.1 255.255.255.0','exit','interface Gi0/0.20','ip address 10.20.0.1 255.255.255.0','exit']).s;
  cfg(r2,['interface Gi0/0.10','ip address 10.10.0.2 255.255.255.0','exit','interface Gi0/0.20','ip address 10.20.0.2 255.255.255.0','exit']);
  const rate=(o)=>{const m=/Success rate is (\d+) percent/.exec(o.join(' '));return m?m[1]+'%':'?'};
  return 'allowed='+allowed.padEnd(6)+' fa1='+JSON.stringify(sw.interfaces.get('Fa0/1').vlan.allowedVlans).padEnd(9)+' v10='+rate(s1.run('ping 10.10.0.2 count 2').output).padEnd(5)+' v20='+rate(s1.run('ping 10.20.0.2 count 2').output).padEnd(5)+(w.bad.length?' REFUSED '+w.bad.join(';'):'');
}
for (const a of ['all','10','10,20']) console.log(run(a));
