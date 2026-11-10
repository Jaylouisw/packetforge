const fs=require('fs');
const src=fs.readFileSync('engine/cli.js','utf8');
const cands=new Map();
for (const m of src.matchAll(/`([^`\n]{2,70})`/g)) cands.set(m[1], 'backtick');
for (const m of src.matchAll(/"([^"\n]{2,70})"/g)) cands.set(m[1], 'quote');
const ROOTS=new Set(['show','ping','traceroute','tracert','converge','clear','write','copy','interface','no','ip','ipv6','vrrp','dns','scion','ospf','router','bgp','flow','link','links','help','exit','end','do','enable','configure','conf','nslookup','hostname','vlan','access-list','snmp','logging','clock','power','lldp','spanning-tree','switchport','bridge','set']);
const list=[];
for (const [text,kind] of cands){
  const first=text.trim().split(/\s+/)[0].toLowerCase();
  if (!ROOTS.has(first)) continue;
  list.push({text:text.trim(), kind});
}
list.sort((a,b)=>a.text.localeCompare(b.text));
console.log('candidates with a command-root first word: '+list.length);
for (const c of list) console.log('  ['+c.kind+'] '+c.text);
