const {Topology,Simulator,CliSession}=require('../engine');
const {loadCatalog}=require('../devices/registry');
const cat=loadCatalog('C:/Users/jay/packetforge/devices');
const model=(m)=>cat.find(x=>x.model===m);
function build(){
  const t=new Topology();
  const sw=t.addDevice(model('CX 6000 24G CL4 PoE 4SFP 370W')); sw.name='SW1';
  const r1=t.addDevice(model('generic-router')); r1.name='R1';
  t.connect(r1.id,'Gi0/0',sw.id,'1/1/1');
  const sim=new Simulator(t);
  const s=new CliSession(sw,t,sim); s.run('enable');
  return {t,sim,s,sw};
}
// 1. first command is the show
let a=build();
console.log('A (show first):'); console.log(a.s.run('show spanning-tree').output.join('\n'));
console.log('   dev.stp after:', JSON.stringify(a.sw.stp));
// 2. show after a ping (which computes control planes)
let b=build();
b.t.addDevice(model('generic-pc'));
b.s.run('ping 10.0.0.1 count 1');
console.log('B (after a ping):'); console.log(b.s.run('show spanning-tree').output.join('\n'));
console.log('   dev.stp after:', JSON.stringify(b.sw.stp));
