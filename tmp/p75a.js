const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch');
function sess(spec){const t=new Topology();const d=t.addDevice(spec);const s=new CliSession(d,t,new Simulator(t));s.run('enable');return s;}
const r=sess(R), sw=sess(SW);
const shows=['show version','show inventory','show environment','show clock','show power inline','show poe',
 'show interfaces status','show interfaces description','show interfaces summary','show ip interface',
 'show spanning-tree summary','show spanning-tree root','show mac address-table count','show mac address-table dynamic',
 'show vlan brief','show etherchannel summary','show etherchannel 1','show port-security','show lldp neighbors',
 'show lldp','show cdp neighbors','show logging','show users','show sessions','show run interface Gi0/0',
 'show startup-config','show flash','show file systems','show ip protocols','show ip ospf interface brief',
 'show ip bgp','show ip route summary','show ip route 10.0.0.0','show ip arp 10.0.0.1','show dhcp','show ip dhcp pool',
 'show controllers','show processes cpu','show memory','show hardware','show module','show stack'];
for (const cmd of shows) {
  const o=r.run(cmd).output;
  const bad=o.some(l=>/% (Invalid show command|Unrecognized|No .* named)/.test(l));
  console.log((bad?'MISS ':'ok   ')+cmd+(bad?'  => '+(o[0]||''):'  => '+(o[0]||'').slice(0,70)));
}
