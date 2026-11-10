const path=require('path');
const {Topology}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const SW=c.find(s=>s.model==='generic-switch'),PC=c.find(s=>s.model==='generic-pc');
const t=new Topology();const sw=t.addDevice(SW),p1=t.addDevice(PC),p2=t.addDevice(PC);
const port=[...sw.interfaces.keys()][0];
try{ t.connect(p1.id,'eth0',sw.id,port); }catch(e){console.log('c1:',e.message);}
try{ t.connect(p2.id,'eth0',sw.id,port); console.log('two devices on one port: OK'); }catch(e){console.log('c2 refused:',e.message);}
const peer=sw.interfaces.get(port).peer; console.log('peer after both connects:', JSON.stringify(peer));
