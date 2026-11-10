const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch');
function mk(spec){const t=new Topology();const d=t.addDevice(spec);const s=new CliSession(d,t,new Simulator(t));s.run('enable');return s;}
const probes = [
 ['exec','show ip nat ?'],['exec','clear ip nat ?'],['exec','show ip bgp ?'],['exec','show ip ospf neighbor ?'],
 ['exec','show access-lists ?'],['exec','show spanning-tree ?'],['exec','show vrrp ?'],['exec','show ipv6 ?'],
 ['exec','ping ipv6 ?'],['exec','traceroute ?'],['exec','renew ?'],['exec','release ?'],['exec','show ip dhcp ?'],
 ['exec','show etherchannel ?'],['exec','show interfaces ?'],['exec','show mac ?'],['exec','show arp ?'],
 ['cfg','no ip nat inside ?'],['cfg','ip nat inside ?'],['cfg','ip nat inside source ?'],['cfg','ip access-list ?'],
 ['cfg','spanning-tree ?'],['cfg','spanning-tree vlan ?'],['cfg','ipv6 ?'],['cfg','router bgp ?'],['cfg','ospf ?'],
 ['cfg','no spanning-tree ?'],['cfg','vlan ?'],['cfg','no vlan ?'],['cfg','ip dhcp pool ?'],['cfg','dns ?'],
 ['if','ip nat ?'],['if','no ip nat ?'],['if','spanning-tree ?'],['if','no spanning-tree ?'],['if','ip ospf ?'],
 ['if','ipv6 ?'],['if','channel-group ?'],['if','switchport ?'],['if','encapsulation ?'],
];
for (const [mode,cmd] of probes) {
  const s = mk(R); // fresh per probe: modes do not leak
  s.run('enable');
  if (mode==='cfg') s.run('configure terminal');
  if (mode==='if') { s.run('configure terminal'); s.run('interface Gi0/0'); }
  const before = s.mode;
  const o = s.run(cmd).output;
  const bad = o.some(l=>/% (No completions|Nothing after)/.test(l));
  console.log((bad?'MISS ':'ok   ')+'['+mode+'] '+cmd+(bad?'  => '+o[0]:'  => '+(o[0]||'').replace(/Completions for /,'').slice(0,60)));
  if (bad) { const w=s.run('?').output.filter(l=>/^\s{4}\S/.test(l)); console.log('        mode words: '+w.slice(0,40).map(x=>x.trim().split(/\s+/)[0]).join(' ')); }
}
