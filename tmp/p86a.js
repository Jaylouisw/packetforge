// Probe: does a full configuration survive a dump-and-paste round trip?
const path=require('path');
const {Topology,Simulator}=require('../engine');const {CliSession}=require('../engine/cli');const {loadCatalog}=require('../devices/registry');
const c=loadCatalog(path.join(__dirname,'..','devices'));
const SW=c.find(s=>s.model==='generic-switch'), R=c.find(s=>s.model==='generic-router'), PC=c.find(s=>s.model==='generic-pc');
const CFG={
 SW1:['hostname SW1','vlan 10 name users','vlan 20 name voice',
  'interface Fa0/1','switchport mode access','switchport access vlan 10','description desk 12',
  'mtu 1400','speed 100','duplex full','spanning-tree cost 30','switchport port-security',
  'switchport port-security maximum 2','switchport port-security violation restrict',
  'switchport port-security aging time 5','switchport port-security aging type inactivity',
  'exit',
  'interface Fa0/2','switchport mode trunk','switchport trunk native vlan 10',
  'switchport trunk allowed vlan 10,20','exit',
  'interface Fa0/3','channel-group 1 mode active','exit',
  'interface Fa0/4','channel-group 1 mode active','exit',
  'interface Vlan10','ip address 10.10.0.2 255.255.255.0','exit',
  'ip default-gateway 10.10.0.1','ip domain-name lab.test','lldp run',
  'interface Fa0/5','power inline never','no lldp transmit','exit',
  'spanning-tree vlan 10 priority 4096'],
 R1:['hostname R1','interface Gi0/0','ip address 10.10.0.1 255.255.255.0','ip nat outside','exit',
  'interface Gi0/1','ip address 192.168.5.1 255.255.255.0','ip nat inside','exit',
  'ip route 10.0.0.0 255.255.0.0 10.10.0.254','ip domain-name lab.test','no ip domain-lookup',
  'arp 192.168.5.9 0200.0000.0009 arpa',
  'ip nat inside source static 192.168.5.10 10.10.0.99',
  'access-list 110 permit tcp 192.168.5.0 0.0.0.255 any eq 443',
  'ip nat inside source list 110 interface Gi0/0 overload',
  'vrrp 1 ip 192.168.5.1','router ospf 1','network 10.10.0.0 0.0.0.255 area 0','exit']
};
function build(){
  const t=new Topology();
  const sw=t.addDevice(SW);sw.name='SW1';const r=t.addDevice(R);r.name='R1';const pc=t.addDevice(PC);pc.name='PC1';
  const swp=Array.from(sw.interfaces.keys()).filter(n=>!sw.interfaces.get(n).svi&&!sw.interfaces.get(n).parent);
  t.connect(r.id,'Gi0/0',sw.id,swp[0]);t.connect(pc.id,'eth0',sw.id,swp[1]);
  return {t,sw,r,pc,swp};
}
function apply(lab,cmds){
  const sim=new Simulator(lab.t);
  const sessions={SW1:new CliSession(lab.sw,lab.t,sim),R1:new CliSession(lab.r,lab.t,sim)};
  for(const k of Object.keys(sessions)) sessions[k].run('enable');
  const errs=[];
  for(const dev of Object.keys(cmds)){
    const s=sessions[dev];
    s.run('configure terminal');
    for(const line of cmds[dev]){
      const o=s.run(line).output||[];
      const bad=o.filter(l=>/^(%|.*not modelled|Unexpected)/.test(l));
      if(bad.length) errs.push(dev+': '+line+' -> '+bad[0]);
    }
    s.run('end');
  }
  return {sim,sessions,errs};
}
const A=build(); const a=apply(A,CFG);
console.log('== refusals while applying the reference config:'); a.errs.forEach(e=>console.log('  '+e));
const dumpA={};
for(const k of Object.keys(a.sessions)) dumpA[k]=a.sessions[k].run('show running-config').output;
// paste into a fresh lab
const B=build(); const b=apply(B,{SW1:[],R1:[]});
for(const k of Object.keys(dumpA)){
  const s=b.sessions[k]; s.run('configure terminal');
  for(const line of dumpA[k]){
    if(/^!/.test(line)||/^end$/.test(line)||/^Building configuration/.test(line)||/^Current configuration/.test(line)) continue;
    s.run(line);
  }
  s.run('end');
}
let diffs=0;
for(const k of Object.keys(dumpA)){
  const dumpB=b.sessions[k].run('show running-config').output;
  const A1=dumpA[k].join('\n'), B1=dumpB.join('\n');
  if(A1===B1){console.log('== '+k+': round trip identical ('+dumpA[k].length+' lines)');continue;}
  diffs++;
  const la=dumpA[k], lb=dumpB;
  console.log('== '+k+': DIFFERS');
  const max=Math.max(la.length,lb.length);
  for(let i=0;i<max;i++){ if((la[i]||'')!==(lb[i]||'')){
    console.log('  line '+i+' A: '+JSON.stringify(la[i]));console.log('  line '+i+' B: '+JSON.stringify(lb[i])); if(i>3)break;} }
}
console.log('diffs='+diffs);
