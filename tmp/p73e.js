const path=require('path');const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));const R=c.find(s=>s.model==='generic-router');
const t=new Topology();const r=t.addDevice(R);const s=new CliSession(r,t,new Simulator(t));s.run('enable');s.run('configure terminal');
const rows=s._helpFormRows(s._completionMode(['no','ip'])).filter(x=>x.tokens[0]==='no'&&x.tokens[1]==='ip'&&String(x.tokens[2]||'').toLowerCase().startsWith('rou'));
rows.forEach(x=>console.log(JSON.stringify({tokens:x.tokens.map(v=>typeof v==='object'?'<'+v.placeholder+'>':v),desc:x.desc})));
