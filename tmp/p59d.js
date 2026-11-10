const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog('C:/Users/jay/packetforge/devices');const R=c.find(s=>s.model==='generic-router');
const t=new Topology();const d=t.addDevice(R);d.name='R1';const s=new CliSession(d,t,new Simulator(t));s.run('enable');s.run('configure terminal');
const p=(x)=>{const o=s.run(x).output;console.log('$ '+x+(o.length?'\n    '+o.join('\n    '):'    (silent)'))};
p('dns zone example.test'); p('dns add www A 10.0.0.5'); p('dns add note TXT hello world');
p('dns add lab MX 10 mail.lab.test'); p('dns add dup A 10.0.0.5'); p('dns add dup A 10.0.0.5');
p('dns add www CNAME other.test');
p('exit'); p('show dns'); p('show running-config');
p('ping www.example.test count 1');
