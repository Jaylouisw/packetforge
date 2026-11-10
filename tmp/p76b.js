const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const SW=c.find(s=>s.model==='generic-switch'),R=c.find(s=>s.model==='generic-router');
console.log('spec ports sample:', JSON.stringify((SW.ports||SW.interfaces||[]).slice(0,2)));
const t=new Topology();const sw=t.addDevice(SW);sw.name='SW1';
const i=sw.interfaces.get('Fa0/1');
console.log('iface keys:', Object.keys(i).join(','));
console.log('iface:', JSON.stringify({name:i.name,desc:i.description,mode:i.mode,accessVlan:i.accessVlan,speed:i.speed,speedMbps:i.speedMbps,duplex:i.duplex,media:i.media,type:i.type,kind:i.kind,speedCaps:i.speedCaps,enabled:i.enabled,lineUp:i.lineUp}));
