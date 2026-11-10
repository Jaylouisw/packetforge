const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const SW=c.find(s=>s.model==='generic-switch'), PC=c.find(s=>s.model==='generic-pc');
const t=new Topology();const sw=t.addDevice(SW),p=t.addDevice(PC);sw.name='SW1';p.name='PC1';
const ports=Array.from(sw.interfaces.keys()).filter(n=>!sw.interfaces.get(n).svi);
t.connect(p.id,'eth0',sw.id,ports[0]);
const sim=new Simulator(t);const s=new CliSession(sw,t,sim);s.run('enable');
const try_=(cmd)=>{const o=s.run(cmd).output;const head=o[0]===undefined?'(no output)':o[0];
  console.log(String(cmd).padEnd(38)+' | '+head.slice(0,110));};
[
 'show lldp neighbors detail','show lldp neighbors interface '+ports[0],'show lldp traffic','show lldp interface',
 'show cdp neighbors','show cdp neighbors detail','show cdp',
 'show interfaces counters errors','show interfaces counters errors '+ports[0],'show interfaces '+ports[0]+' counters errors',
 'show interfaces '+ports[0]+' transceiver','show interface '+ports[0],
 'show span','show spanning-tree detail','show spanning-tree interface '+ports[0],'show spanning-tree summary',
 'show vlan brief','show vlan id 1','show vlan name VLAN0001',
 'show mac address-table interface '+ports[0],'show mac address-table static','show mac address-table vlan 1',
 'show etherchannel summary','show etherchannel port-channel','show etherchannel 1',
 'show power inline','show power inline interface '+ports[0],
 'show port-security','show port-security interface '+ports[0],
 'show switchport','show switchport interface '+ports[0],'show interfaces switchport',
 'show inventory','show environment','show version','show running-config interface '+ports[0],
 'show startup-config','show users','show sessions','show history','show line','show processes cpu',
 'show ip','show ip interface','show ip route','show arp','show clock','show banner',
].forEach(try_);
