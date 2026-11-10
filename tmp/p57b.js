const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const lagLib=require('../engine/lag');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
const SW=c.find(s=>s.model==='generic-switch'),PC=c.find(s=>s.model==='generic-pc');
function lab(lag){
  const t=new Topology();const sw1=t.addDevice(SW);sw1.name='SW1';const sw2=t.addDevice(SW);sw2.name='SW2';
  const p1=t.addDevice(PC);p1.name='PC1';const p2=t.addDevice(PC);p2.name='PC2';
  t.connect(p1.id,'eth0',sw1.id,'Fa0/1');t.connect(p2.id,'eth0',sw2.id,'Fa0/1');
  t.connect(sw1.id,'Fa0/7',sw2.id,'Fa0/7');t.connect(sw1.id,'Fa0/8',sw2.id,'Fa0/8');
  const sim=new Simulator(t);
  const cfg=(dev,cmds)=>{const s=new CliSession(dev,t,sim);s.run('enable');s.run('configure terminal');for(const x of cmds)s.run(x);s.run('end');return s;};
  const ps=new CliSession(p1,t,sim); for(const x of ['enable','configure terminal','interface eth0','ip address 10.0.0.1 255.255.255.0','end']) ps.run(x);
  const ps2=new CliSession(p2,t,sim); for(const x of ['enable','configure terminal','interface eth0','ip address 10.0.0.2 255.255.255.0','end']) ps2.run(x);
  if(lag){for(const sw of [sw1,sw2]) cfg(sw,['interface Fa0/7','switchport mode trunk','channel-group 1 mode active','exit','interface Fa0/8','switchport mode trunk','channel-group 1 mode active','exit']);}
  else {for(const sw of [sw1,sw2]) cfg(sw,['interface Fa0/7','switchport mode trunk','exit','interface Fa0/8','switchport mode trunk','exit']);}
  return {t,sw1,sw2,sim,ps};
}
const a=lab(true);
const h=new CliSession(a.t.devices.get(a.ps.device.id), a.t, a.sim);
console.log('ping with lag:', a.ps.run('ping 10.0.0.2 count 4').output.slice(-2).join(' | '));
const s1=new CliSession(a.sw1,a.t,a.sim); s1.run('enable');
console.log('show etherchannel:', s1.run('show etherchannel').output.join(' | '));
console.log('counters:', s1.run('show interfaces counters Fa0/7').output.join(' | '), '//', s1.run('show interfaces counters Fa0/8').output.join(' | '));
console.log('stp:', s1.run('show spanning-tree').output.join(' | '));
console.log('validateLag:', JSON.stringify(lagLib.validateLag(Object.assign({id:'1'},a.sw1.config.lags['1']), []).errors||[]));
const b=lab(false);
const s1b=new CliSession(b.sw1,b.t,b.sim); s1b.run('enable');
console.log('no-lag ping:', b.ps.run('ping 10.0.0.2 count 4').output.slice(-2).join(' | '));
console.log('no-lag counters 7/8:', s1b.run('show interfaces counters Fa0/7').output.join(' | '), '//', s1b.run('show interfaces counters Fa0/8').output.join(' | '));
console.log('no-lag stp:', s1b.run('show spanning-tree').output.join(' | '));
