'use strict';
// An OSPF area id is a 32-bit number, and the console must read it as one (#1843).
//
// `ospf area 0.0.0.1` was parsed with `parseInt`, which keeps everything before the first dot: the command
// answered "OSPF area 0" and stored 0. Two consequences, both real and both visible from outside:
//
//   * two routers in DIFFERENT areas (0.0.0.1 and 0.0.0.2) formed a full adjacency and exchanged routes,
//     because both had been read as area 0;
//   * `ospf area 0.0.0.999` was accepted as area 0 - parseInt never looks at the last octet - and
//     `ospf area 4294967295`, a valid id, was refused because the range check stopped at 2^31-1.
//
// The rule: an area id is "A 32 bit number identifying the area that this packet belongs to" (RFC 2328
// section 9, https://www.rfc-editor.org/rfc/rfc2328), and the box takes it written either way - "A decimal
// value in the range from 0 to 4294967295, or an IP address in the dotted-decimal format" (Cisco IOS XE,
// `ip ospf area`, https://www.cisco.com/c/en/us/td/docs/routers/sdwan/command/iosxe/qualified-cli-command-reference-guide/m-ip-ospf-commands.html).
// The id keeps the form it was configured with, because the box echoes that form back: a switch configured
// with 0.0.0.1 prints "Area 0.0.0.1" and one configured with 0 prints "Area 0" (Dell OS9 9.14 `show ip ospf
// interface`, https://www.dell.com/support/manuals/en-gb/dell-emc-os-9/s6000-9.14.2.6-cli-pub/show-ip-ospf-interface).
// What decides an adjacency is the 32-bit value on the wire, so "0.0.0.1" and "1" are one area - and that is
// asserted here as hard as the difference between 0.0.0.1 and 0.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function eq(got, want, msg) {
  ok(got === want, msg + ' (got ' + JSON.stringify(got) + ')');
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.filter(function (s) { return !s.error && s.vendor === 'generic' && s.model === 'generic-router'; })[0];

function session(dev, topo, sim) {
  const s = new CliSession(dev, topo, sim || new Simulator(topo));
  s.run('enable');
  return s;
}
function config(dev, topo, cmds) {
  const s = session(dev, topo);
  s.run('configure terminal');
  for (const c of cmds) s.run(c);
  s.run('end');
  return s;
}
function said(s, cmd) { return (s.run(cmd).output || []).join('\n'); }

// Two routers joined by one cable. aCmds / bCmds run after the addressing, in config mode.
function lab(aCmds, bCmds) {
  const topo = new Topology();
  const a = topo.addDevice(ROUTER);
  const b = topo.addDevice(ROUTER);
  topo.connect(a.id, 'Gi0/1', b.id, 'Gi0/0');
  config(a, topo, ['interface Gi0/1', 'ip address 10.0.0.1 255.255.255.0', 'exit'].concat(aCmds));
  config(b, topo, ['interface Gi0/0', 'ip address 10.0.0.2 255.255.255.0', 'exit'].concat(bCmds));
  const sim = new Simulator(topo);
  sim.computeOspf();
  return { topo: topo, a: a, b: b, sim: sim };
}

// ---------------------------------------------------------------------------
console.log('the command reads a 32-bit area, decimal or dotted');
{
  const topo = new Topology();
  const r = topo.addDevice(ROUTER);
  const s = session(r, topo);
  s.run('configure terminal');
  eq(said(s, 'ospf area 0.0.0.1'), 'OSPF area 0.0.0.1', 'a dotted area is echoed as typed');
  eq(r.config.ospf.areaId, '0.0.0.1', 'and stored as 0.0.0.1, not 0');
  eq(said(s, 'ospf area 0.0.0.2'), 'OSPF area 0.0.0.2', 'a second dotted area replaces it');
  eq(said(s, 'ospf area 4294967295'), 'OSPF area 4294967295',
    '4294967295 is a valid id (the vendor range is 0-4294967295)');
  eq(said(s, 'ospf area 007'), 'OSPF area 7', 'a decimal id is stored without leading zeros');
  eq(said(s, 'ospf area 0.0.0.1'), 'OSPF area 0.0.0.1', 'back to a dotted id for the next checks');

  const refused = function (cmd, why) {
    const out = said(s, cmd);
    ok(/^% Invalid area id/.test(out), why + ' is refused', out);
    eq(r.config.ospf.areaId, '0.0.0.1', why + ' does not change the stored area');
  };
  refused('ospf area 4294967296', '4294967296 (one past the 32-bit ceiling)');
  refused('ospf area 0.0.0.999', '0.0.0.999 (an octet out of range, which used to be area 0)');
  refused('ospf area 0.0.0', '0.0.0 (three octets)');
  refused('ospf area abc', 'abc (not a number)');
  refused('ospf area -1', '-1 (negative)');
  ok(/32-bit number \(0-4294967295\) or a dotted quad/.test(said(s, 'ospf area abc')),
    'the refusal states the rule instead of just saying no');
}

// ---------------------------------------------------------------------------
console.log('\ntwo routers in different areas do not become adjacent');
{
  const l = lab(['ospf router-id 1.1.1.1', 'ospf area 0.0.0.1'],
    ['ospf router-id 2.2.2.2', 'ospf area 0']);
  eq((l.a.ospfNeighbors || []).length, 0,
    '0.0.0.1 and 0 are different areas: no neighbour (this was the bug - both read as 0)');
  const rejected = (l.a.ospfRejected || []);
  eq(rejected.length, 1, 'the link is recorded as refused');
  eq(rejected[0] && rejected[0].reason, 'area', 'and the reason is the area, not the timers or the link');
  const out = said(session(l.a, l.topo, l.sim), 'show ip ospf neighbor');
  ok(/runs OSPF in area 0 and this box in area 0\.0\.0\.1/.test(out),
    'the neighbour view names both areas as configured', out);

  const l2 = lab(['ospf router-id 1.1.1.1', 'ospf area 0.0.0.1'],
    ['ospf router-id 2.2.2.2', 'ospf area 0.0.0.2']);
  eq((l2.a.ospfNeighbors || []).length, 0, '0.0.0.1 and 0.0.0.2 are different areas: no neighbour');
}

// ---------------------------------------------------------------------------
console.log('\nthe same 32-bit value in two spellings is one area');
{
  const l = lab(['ospf router-id 1.1.1.1', 'ospf area 0.0.0.1'],
    ['ospf router-id 2.2.2.2', 'ospf area 1']);
  eq((l.a.ospfNeighbors || []).length, 1, '0.0.0.1 and 1 put the same number in the Hello: adjacent');
  eq((l.a.ospfRejected || []).length, 0, 'and nothing is refused');

  const l2 = lab(['ospf router-id 1.1.1.1', 'ospf area 256'],
    ['ospf router-id 2.2.2.2', 'ospf area 0.0.1.0']);
  eq((l2.a.ospfNeighbors || []).length, 1, '256 and 0.0.1.0 are one area too');
}

// ---------------------------------------------------------------------------
console.log('\n`ip ospf area` follows the same rule');
{
  const l = lab(['ospf router-id 1.1.1.1', 'ospf area 0', 'interface Gi0/1', 'ip ospf area 0.0.2.0', 'exit'],
    ['ospf router-id 2.2.2.2', 'ospf area 0', 'interface Gi0/0', 'ip ospf area 512', 'exit']);
  eq((l.a.ospfNeighbors || []).length, 1, 'an interface in 0.0.2.0 is adjacent to one in 512');
  const s = session(l.a, l.topo, l.sim);
  const ifTable = said(s, 'show ip ospf interface');
  ok(/0\.0\.2\.0\s+1\s+/.test(ifTable),
    'the Area column prints 0.0.2.0 and still leaves the Cost column alone', ifTable);
  ok(/^\s+ip ospf area 0\.0\.2\.0$/m.test(said(s, 'show running-config')),
    'running-config prints the dotted form the interface was given');

  const l2 = lab(['ospf router-id 1.1.1.1', 'ospf area 0', 'interface Gi0/1', 'ip ospf area 0.0.2.0', 'exit'],
    ['ospf router-id 2.2.2.2', 'ospf area 0', 'interface Gi0/0', 'ip ospf area 0.0.3.0', 'exit']);
  eq((l2.a.ospfNeighbors || []).length, 0, '0.0.2.0 and 0.0.3.0 on the interfaces: no adjacency');
  const out = said(session(l2.a, l2.topo, l2.sim), 'show ip ospf neighbor');
  ok(/area 0\.0\.3\.0 and this box in area 0\.0\.2\.0/.test(out), 'and the refusal names both interface areas');

  const bad = lab(['ospf router-id 1.1.1.1', 'ospf area 0', 'interface Gi0/1', 'ip ospf area 0.0.9.999', 'exit'],
    ['ospf router-id 2.2.2.2', 'ospf area 0']);
  const out2 = said(session(bad.a, bad.topo, bad.sim), 'show running-config');
  ok(!/ip ospf area/.test(out2), 'an invalid dotted interface area is refused, not stored as 0', out2);
}

// ---------------------------------------------------------------------------
console.log('\nwhat the running config prints is what the box answers');
{
  const l = lab(['ospf router-id 1.1.1.1', 'ospf area 0.0.0.1'], ['ospf router-id 2.2.2.2', 'ospf area 0']);
  const cfg = said(session(l.a, l.topo, l.sim), 'show running-config');
  ok(/^ospf area 0\.0\.0\.1$/m.test(cfg), 'the dotted area is in the config', cfg);

  // Type the same line into a fresh router and ask the same question: the area must survive the trip.
  const topo = new Topology();
  const fresh = topo.addDevice(ROUTER);
  config(fresh, topo, ['ospf router-id 1.1.1.1', 'ospf area 0.0.0.1']);
  eq(fresh.config.ospf.areaId, '0.0.0.1', 'and re-typing it lands on the same area');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
