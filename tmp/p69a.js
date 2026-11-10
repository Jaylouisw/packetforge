const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch'),PC=c.find(s=>s.model==='generic-pc');
// triangle of switches -> STP loop
const t=new Topology();const s1=t.addDevice(SW);s1.name='SW1';const s2=t.addDevice(SW);s2.name='SW2';const s3=t.addDevice(SW);s3.name='SW3';
t.connect(s1.id,'Fa0/1',s2.id,'Fa0/1');t.connect(s2.id,'Fa0/2',s3.id,'Fa0/1');t.connect(s3.id,'Fa0/2',s1.id,'Fa0/2');
const sim=new Simulator(t);
const cfg=(d,cmds)=>{const s=new CliSession(d,sim?t:t,sim);s.run('enable');s.run('configure terminal');for(const x of cmds){const o=s.run(x).output;if(o.some(l=>/^%/.test(l)))console.log('  REFUSED ['+d.name+'] '+x+' => '+o[0]);}s.run('end');return s;};
const a=cfg(s1,[]);const b=cfg(s2,[]);const d3=cfg(s3,[]);
const show=(s,x)=>{console.log('['+s.device.name+'] $ '+x);const o=s.run(x).output;o.forEach(l=>console.log('   '+l));if(!o.length)console.log('   (SILENT)');};
show(a,'show spanning-tree');
show(a,'show spanning-tree brief');
console.log('--- config verbs');
const e=cfg(s1,['spanning-tree vlan 1 root primary']);
show(a,'show spanning-tree');
const f=cfg(s1,['spanning-tree vlan 1 priority 4096']);
show(a,'show spanning-tree');
const g=cfg(s1,['interface Fa0/1','spanning-tree portfast','spanning-tree bpduguard enable','spanning-tree cost 19','spanning-tree port-priority 16','exit']);
show(a,'show spanning-tree Fa0/1');
