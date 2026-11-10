const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));const R=c.find(s=>s.model==='generic-router'),SW=c.find(s=>s.model==='generic-switch');
const t=new Topology();const r=t.addDevice(R),sw=t.addDevice(SW);r.name='R1';sw.name='SW1';
const sim=new Simulator(t);const mk=d=>{const s=new CliSession(d,t,sim);s.run('enable');return s;};
const a=mk(r),b=mk(sw);
const tryCmd=(s,cmds,tag)=>{s.run('configure terminal');for(const cmd of cmds){const o=s.run(cmd).output;const bad=o.some(l=>/^%/.test(l));console.log((bad?'  MISS ':'  ok   ')+tag+' | '+cmd+(bad?'  => '+o[0]:'  => '+(o[0]||'(silent)')));}s.run('end');};
tryCmd(a,['motd test banner','banner motd hello','banner motd ^Chello^C','ip domain-name lab.test','ip domain-lookup',
 'no ip domain-lookup','ip name-server 10.0.0.53','spanning-tree mode rapid-pvst','vtp mode transparent',
 'arp 10.0.0.5 0011.2233.4455 arpa','ip arp 10.0.0.5 0011.2233.4455','logging host 10.0.0.9',
 'snmp-server community public RO','line vty 0 4','username admin secret pw','enable secret pw',
 'ip tftp source-interface Gi0/0','ip http server','ntp server 10.0.0.7','service password-encryption',
 'ip classless','no ip classless','ip subnet-zero','ip cef','clock timezone GMT 0','ipv6 unicast-routing',
 'spanning-tree portfast default','errdisable recovery cause all','cdp run','lldp run','no lldp run'],'R1');
tryCmd(b,['switching mode','ip http server','lldp transmit','no lldp receive','power inline auto'],'SW1');
// what does show run say about motd / lldp?
a.run('configure terminal');a.run('motd test banner');a.run('end');
console.log('--- motd in dump:', a.run('show running-config').output.filter(l=>/motd|banner/.test(l)).join(' | ')||'(none)');
console.log('--- config.motd =', JSON.stringify(r.config.motd));
