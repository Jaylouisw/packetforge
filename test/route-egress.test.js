'use strict';
// route-egress.test.js - a route table that named no interface, for a route that used one.
//
// R1 -- SW1 -- R2, with R2 holding 172.16.0.1/24 and R1 holding a static route to it through R2's
// address. Three views of one decision, two answers:
//
//   R1#show ip route
//   S 172.16.0.0/16   1   10.0.0.2  -          <- "no interface"
//   R1#show ip route 172.16.0.0
//     Next hop  10.0.0.2
//     Interface -                             <- and again
//   R1#show arp
//   Internet  10.0.0.2  ...  Gi0/0  DYNAMIC   <- learned on Gi0/0, one ping ago
//
// The data path had the answer all along: `egressFor(nextHop)` picks the port whose subnet holds the
// next hop, and the ARP reply arrived on it. The table and the lookup just never asked. Both read
// that helper now, so the decision, the table and the cache cannot disagree. A gateway that is on no
// subnet here still earns `-`: there is nothing to name, and a guess would be worse than a dash.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };
function cells(line) { return line.trim().split(/\s{2,}/).map(function (c) { return c.trim(); }); }
// The Interface cell of one route row, found by its prefix.
function ifaceOf(body, prefix) {
  const row = body.split('\n').filter(function (l) {
    return new RegExp('\\b' + prefix.replace(/\./g, '\\.') + '\\b').test(l);
  })[0];
  if (!row) return null;
  const parts = cells(row);
  return parts[parts.length - 1];
}
function lookupIface(body) {
  const line = body.split('\n').filter(function (l) { return /^\s+Interface\s/.test(l); })[0];
  return line ? line.replace(/^\s+Interface\s+/, '').trim() : null;
}

// Two routers through a switch: the learner is two hops from the next hop it must resolve.
function twoRouters() {
  const t = new Topology();
  const r1 = t.addDevice(find('generic-router')); r1.name = 'R1';
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const r2 = t.addDevice(find('generic-router')); r2.name = 'R2';
  const swPorts = Array.from(sw.interfaces.values()).filter(function (i) { return !i.svi; }).map(function (i) { return i.name; });
  t.connect(r1.id, 'Gi0/0', sw.id, swPorts[0]);
  t.connect(sw.id, swPorts[1], r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  const s1 = new CliSession(r1, t, sim); s1.run('enable'); s1.run('configure terminal');
  s1.run('interface Gi0/0'); s1.run('ip address 10.0.0.1 255.255.255.0'); s1.run('exit'); s1.run('end');
  const s2 = new CliSession(r2, t, sim); s2.run('enable'); s2.run('configure terminal');
  s2.run('interface Gi0/0'); s2.run('ip address 10.0.0.2 255.255.255.0'); s2.run('exit');
  s2.run('interface Gi0/1'); s2.run('ip address 172.16.0.1 255.255.255.0'); s2.run('exit'); s2.run('end');
  return { t: t, sim: sim, r1: r1, r2: r2, s1: s1, s2: s2 };
}

console.log('A static route names the port its gateway is on:');
{
  const env = twoRouters();
  const added = text(env.s1.run('configure terminal'));
  ok(true, 'entered config');
  env.s1.run('ip route 172.16.0.0 255.255.0.0 10.0.0.2');
  env.s1.run('end');
  const table = text(env.s1.run('show ip route'));
  ok(ifaceOf(table, '172.16.0.0/16') === 'Gi0/0', 'the table names Gi0/0 (' + ifaceOf(table, '172.16.0.0/16') + ')');
  const lookup = text(env.s1.run('show ip route 172.16.0.0'));
  ok(lookupIface(lookup) === 'Gi0/0', 'and the lookup view agrees (' + lookupIface(lookup) + ')');
  const ping = text(env.s1.run('ping 172.16.0.1 count 3'));
  ok(/100 percent \(3\/3\)/.test(ping), 'the route forwards');
  // The third view: the next hop's MAC, learned on the very port the table now names.
  const arp = env.s1.run('show arp').output.join('\n');
  const arpRow = arp.split('\n').filter(function (l) { return /10\.0\.0\.2/.test(l); })[0];
  ok(arpRow && cells(arpRow)[4] === 'Gi0/0', 'and the cache holds the gateway on that port');
  ok(ifaceOf(table, '10.0.0.0/24') === 'Gi0/0', 'the connected route named it all along');
}

console.log('\nA gateway that is on no subnet here is not given a port:');
{
  const env = twoRouters();
  env.s1.run('configure terminal');
  env.s1.run('ip route 192.168.0.0 255.255.0.0 10.9.9.9');
  env.s1.run('end');
  const table = text(env.s1.run('show ip route'));
  ok(ifaceOf(table, '192.168.0.0/16') === '-', 'the table keeps "-" for an unreachable gateway');
  const lookup = text(env.s1.run('show ip route 192.168.0.0'));
  ok(lookupIface(lookup) === '-', 'and so does the lookup');
  const ping = text(env.s1.run('ping 192.168.1.1 count 1'));
  ok(!/100 percent/.test(ping), 'and nothing pretends the route works');
}

console.log('\nA host default gateway names the port it leaves by:');
{
  const t = new Topology();
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  const pc = t.addDevice(find('generic-pc')); pc.name = 'PC1';
  const pcPort = Array.from(pc.interfaces.values())[0].name;
  t.connect(r.id, 'Gi0/0', pc.id, pcPort);
  const sim = new Simulator(t);
  const sp = new CliSession(pc, t, sim); sp.run('enable'); sp.run('configure terminal');
  sp.run('interface ' + pcPort); sp.run('ip address 10.0.0.10 255.255.255.0');
  sp.run('ip default-gateway 10.0.0.1'); sp.run('exit'); sp.run('end');
  const table = text(sp.run('show ip route'));
  ok(ifaceOf(table, '0.0.0.0/0') === pcPort, 'the default route names ' + pcPort);
  const lookup = text(sp.run('show ip route 8.8.8.8'));
  ok(lookupIface(lookup) === pcPort, 'and a lookup through it agrees (' + lookupIface(lookup) + ')');
}

console.log('\nThe interface-only form is refused by name, not silently:');
{
  const env = twoRouters();
  env.s1.run('configure terminal');
  const ans = text(env.s1.run('ip route 10.5.0.0 255.255.0.0 Gi0/0'));
  env.s1.run('end');
  ok(/is an interface, not a next hop/.test(ans), 'the refusal says what was typed');
  ok(/ip route 10\.5\.0\.0 255\.255\.0\.0 <neighbour-ip>/.test(ans), 'and gives the form that works');
  ok(!/10\.5\.0\.0\/16/.test(text(env.s1.run('show ip route'))), 'nothing was installed behind it');
}

console.log('\nAn OSPF route names its port too (across a switch, which is the ordinary lab):');
{
  const env = twoRouters();
  env.s1.run('configure terminal'); env.s1.run('router ospf 1');
  env.s1.run('network 10.0.0.0 0.0.0.255 area 0'); env.s1.run('exit'); env.s1.run('end');
  env.s2.run('configure terminal'); env.s2.run('router ospf 1');
  env.s2.run('network 10.0.0.0 0.0.0.255 area 0');
  env.s2.run('network 172.16.0.0 0.0.0.255 area 0'); env.s2.run('exit'); env.s2.run('end');
  const table = text(env.s1.run('show ip route'));
  const ospf = table.split('\n').filter(function (l) { return /^\s*\*\s+O\s/.test(l); })[0];
  ok(!!ospf, 'R1 learned a route over OSPF');
  ok(ospf && cells(ospf)[cells(ospf).length - 1] === 'Gi0/0', 'and it names the port to Gi0/0: ' +
    (ospf ? cells(ospf)[cells(ospf).length - 1] : 'none'));
  const lookup = text(env.s1.run('show ip route 172.16.0.1'));
  ok(lookupIface(lookup) === 'Gi0/0', 'the lookup agrees with the table');
  const ping = text(env.s1.run('ping 172.16.0.1 count 3'));
  ok(/100 percent \(3\/3\)/.test(ping), 'and the path it names is the one that answers');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
