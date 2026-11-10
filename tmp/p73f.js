const path=require('path');const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));const R=c.find(s=>s.model==='generic-router');
const t=new Topology();const r=t.addDevice(R);const s=new CliSession(r,t,new Simulator(t));s.run('enable');s.run('configure terminal');
const forms=s._helpFormRows(s._completionMode(['no','ip']));
const kw=forms.filter(x=>{const t2=x.tokens[2];return typeof t2==='string'&&t2.toLowerCase().startsWith('rou');});
console.log('rows:',kw.length);
const descs=new Set(kw.map(x=>x.desc));console.log('descs:',JSON.stringify([...descs]));
console.log('token3:',JSON.stringify(kw.map(x=>String(typeof x.tokens[3]==='object'?'<'+x.tokens[3].placeholder+'>':x.tokens[3]))));
console.log('complete out:');s.run('no ip rou?').output.forEach(l=>console.log('  |'+l));
