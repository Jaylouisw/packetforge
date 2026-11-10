// reproduce the test's cli() wrapper exactly
const {Topology,Simulator,CliSession}=require('../engine');const {loadCatalog}=require('../devices/registry');
const catalog=loadCatalog('C:/Users/jay/packetforge/devices');
const SWITCH=catalog.find(s=>s.model==='generic-switch'),PC=catalog.find(s=>s.model==='generic-pc');
const t=new Topology();const sw=t.addDevice(SWITCH);sw.name='SW1';
const mk=(n)=>{const p=t.addDevice(PC);p.name=n;return p;};
const pc1=mk('PC1');
t.connect(pc1.id,'eth0',sw.id,'Fa0/1');
const sim=new Simulator(t);const session=new CliSession(sw,t,sim);const s=(c)=>session.run(c).output;
s('enable');s('configure terminal');s('interface Fa0/1');s('switchport mode access');s('switchport access vlan 10');s('exit');
s('vlan 30');s('end');
const cli=(c)=>{ const pre=s('end'); const out=s(c); return {pre, out}; };
console.log('end at exec:', JSON.stringify(cli('show vlan 30').pre));
console.log('show vlan 30:', JSON.stringify(cli('show vlan 30').out));
console.log('show vlan 99:', JSON.stringify(cli('show vlan 99').out));
