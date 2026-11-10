const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const pse=c.find(d=>/CBS350-24P/i.test(d.model))||c.find(d=>(d.interfaces||[]).some(i=>i.poeOut));
const pd=c.find(d=>/EP-R6/.test(d.model));
console.log('PSE:', pse.model, 'budget field:', pse.poeBudget || JSON.stringify(pse.poe));
console.log('PD:', pd.model, 'poeIn:', JSON.stringify((pd.interfaces||[]).map(i=>i.poeIn).filter(Boolean).slice(0,2)));
const t=new Topology();const sw=t.addDevice(pse);const ap=t.addDevice(pd);
sw.name='SW1';ap.name='AP1';
t.connect(ap.id,'eth0',sw.id,(sw.interfaces.has('Gi1/0/1')?'Gi1/0/1':Array.from(sw.interfaces.keys())[0]));
const sim=new Simulator(t);const mk=d=>{const s=new CliSession(d,t,sim);s.run('enable');return s;};
const s=mk(sw);
const show=x=>{const o=s.run(x).output;console.log('$ '+x);o.forEach(l=>console.log('  '+l));};
show('show power inline');
s.run('configure terminal');
for(const cmd of ['power inline never','power inline auto','power inline static','power inline 4000','no power inline']){
  const o=s.run('interface '+Array.from(sw.interfaces.keys())[0]).output; void o;
  const r=s.run(cmd).output; console.log('cfg: '+cmd+' => '+(r.join(' | ')||'(silent)'));
}
s.run('end');
show('show power inline');
show('show power inline Gi1/0/1');
