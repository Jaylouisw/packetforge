
const fs=require('fs'),path=require('path');
const dir=path.join(__dirname,'..','engine');
const cli=fs.readFileSync(path.join(dir,'cli.js'),'utf8');
// Fields the console writes, and whether anything outside cli.js reads them.
const writes=new Set();
const re=/\b(?:i|iface|port|dev|this\.device|cfg|config|st|cur|v|sec)\.([a-zA-Z][a-zA-Z0-9_]*)\s*=(?!=)/g;
let m; while((m=re.exec(cli))) writes.add(m[1]);
const others=['simulator.js','device.js','stp.js','vlan.js','portsecurity.js','lldp.js','nat.js','acl.js','ospf.js','vrrp.js','dhcp.js','dns.js','ipv6.js','lag.js','nat.js'];
const text=others.map(f=>{try{return fs.readFileSync(path.join(dir,f),'utf8')}catch(e){return ''}}).join('\n');
const unread=[...writes].filter(f=>{
  const r=new RegExp('\\.'+f+'\\b');
  return !r.test(text);
}).sort();
console.log('fields written by cli.js and never read by the engine:',unread.length);
console.log(unread.join(' '));
