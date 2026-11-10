const fs=require('fs');
const {Topology,Simulator}=require('../engine');
const {CliSession}=require('../engine/cli');
const {loadCatalog}=require('../devices/registry');
const catalog=loadCatalog('C:/Users/jay/packetforge/devices');
const mk=(n)=>catalog.find(x=>x.model===n);
const src=fs.readFileSync('engine/cli.js','utf8');
const spans=new Map();
for (const m of src.matchAll(/`([^`\n]{2,70})`/g)) spans.set(m[1].trim(),'backtick');
for (const m of src.matchAll(/"([^"\n]{2,70})"/g)) spans.set(m[1].trim(),'quote');
const EXEC=/^(show|ping|traceroute|converge|nslookup|flow|clear|write|copy|help|links)\b/;
const VALUES={'<port>':'Gi0/0','<name>':'www.lab.test','<ms>':'1000','<n>':'1','<dest>':'10.0.0.1','<addr>':'10.0.0.1','<ip>':'10.0.0.1','<id>':'1','<as>':'65001','<isd-as>':'1-ff00:0:1','<len>':'24','<mask>':'255.255.255.0','<type>':'A','<vlan>':'10','<what>':'ip route','<proto>':'tcp','<seq>':'10','<action>':'permit'};
function fill(t){ for(const k of Object.keys(VALUES)) t=t.split(k).join(VALUES[k]); return t; }
const cands=[...spans.keys()].filter(t=>EXEC.test(t) && !/…|\.\.\.|\?|'|\+/.test(t));
const out=[];
for (const text of cands){
  const t=new Topology(); const r=t.addDevice(mk('generic-router')); r.name='R1';
  const sim=new Simulator(t); const s=new CliSession(r,t,sim); s.run('enable');
  const res=s.run(fill(text)).output.join(' | ');
  out.push({text, filled:fill(text), res});
}
for (const o of out) console.log((/% Unrecognized|% Invalid exec command/.test(o.res)?'✗ ':'  ')+JSON.stringify(o.filled)+' -> '+o.res.slice(0,110));
