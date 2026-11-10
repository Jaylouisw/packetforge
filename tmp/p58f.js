const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');
for (const model of ['generic-router','generic-switch','generic-pc']) {
  const spec=c.find(s=>s.model===model); const t=new Topology(); const d=t.addDevice(spec); d.name='D';
  const s=new CliSession(d,t,new Simulator(t)); s.run('enable'); s.run('configure terminal');
  console.log(model, '->', JSON.stringify(s.run('ip default-gateway 10.0.0.1').output),
    'stored=', JSON.stringify(d.config.defaultGateway), 'mode=', s.mode);
}
console.log('--- does the branch exist? grep role gate:');
