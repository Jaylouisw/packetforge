const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const SW=c.find(s=>s.model==='generic-switch');
const t=new Topology();const sw=t.addDevice(SW);sw.name='SW1';const s=new CliSession(sw,t,new Simulator(t));s.run('enable');s.run('configure terminal');
const I=(x)=>{console.log('SW1(config-if)#'+x); s.run(x).output.forEach(l=>console.log(l));};
const E=(x)=>{console.log('SW1(config)#'+x); s.run(x).output.forEach(l=>console.log(l));};
for (const port of ['Fa0/3','Fa0/4','Fa0/5']) { s.run('interface '+port); I('channel-group 1 mode static'); s.run('exit'); }
E('interface Fa0/6');
I('channel-group abc');
I('channel-group 2 mode');
I('channel-group 2 mode on');
I('no channel-group 9');
I('description');
I('description uplink to core');
I('no description');
s.run('end');
console.log('SW1#show etherchannel'); s.run('show etherchannel').output.forEach(l=>console.log(l));
