'use strict';
// ospf-area.test.js - `ospf area` was configured, displayed, and never compared.
//
// Measured before this pass, on two routers cabled together:
//   R1: ospf area 1        R2: ospf area 2
//   R1#show ip ospf neighbor  -> 2.2.2.2  1  FULL  10.0.0.2  Gi0/0
//   ...and R2's 10.9.9.0/24 arrived in R1's table as an OSPF route. RFC 2328's first rule is that
//   both ends of a link must be in the same area. engine/ospf.js's own header says so too.
//
// And the id was read with parseInt, so:
//   ospf area 255.255.255.255  -> "OSPF area 255"     (truncated at the first dot)
//   ospf area 4294967296       -> refused, but the model allows 0-4294967295, so half the range
//                                 was unreachable and the dotted-quad form could not be typed at all
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) + ')'));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });

function console_(d, t, sim) {
  const s = new CliSession(d, t, sim);
  s.run('enable');
  return s;
}

console.log('\nAn area id is an area id, in both spellings the model allows:');
{
  const t = new Topology();
  const r = t.addDevice(ROUTER); r.name = 'R1';
  const s = console_(r, t, new Simulator(t));
  s.run('configure terminal');
  eq(s.run('ospf area 0').output[0], 'OSPF area 0', 'a plain integer is accepted');
  eq(s.run('ospf area 1').output[0], 'OSPF area 1', 'and so is 1');
  eq(s.run('ospf area 255.255.255.255').output[0], 'OSPF area 4294967295',
    'a dotted quad is converted, not truncated at its first dot');
  eq(r.config.ospf.areaId, 4294967295, 'and stored as the 32-bit value the model compares');
  eq(s.run('ospf area 0.0.0.1').output[0], 'OSPF area 1', 'the dotted form of area 1 is area 1');
  eq(r.config.ospf.areaId, 1, 'and compares equal to the integer form');
  eq(s.run('ospf area 4294967296').output[0],
    '% "4294967296" is not an area id (0-4294967295, or a dotted quad like 0.0.0.1)',
    'anything outside 32 bits is refused by name');
  eq(s.run('ospf area abc').output[0],
    '% "abc" is not an area id (0-4294967295, or a dotted quad like 0.0.0.1)',
    'and a word is refused by name');
  eq(s.run('ospf area 1 extra').output[0],
    '% Unexpected argument "extra" - ospf area <id> takes no more',
    'a trailing word is refused, since the command has no slot for it');
  eq(r.config.ospf.areaId, 1, 'and none of the refusals changed the configured area');
}

console.log('\nThe router-id is an address, not the shape of one:');
{
  const t = new Topology();
  const r = t.addDevice(ROUTER); r.name = 'R1';
  const s = console_(r, t, new Simulator(t));
  s.run('configure terminal');
  eq(s.run('ospf router-id 1.1.1.999').output[0],
    '% "1.1.1.999" is not an IPv4 address, so it cannot be a router-id',
    'an out-of-range octet is refused');
  eq(r.config.ospf === undefined || r.config.ospf === null, true, 'and no OSPF process was created');
  eq(s.run('ospf router-id 1.1.1.1').output[0], 'OSPF enabled, router-id 1.1.1.1 area 0',
    'a real address is accepted');
  eq(s.run('ospf router-id 1.1.1.1 extra').output[0],
    '% Unexpected argument "extra" - ospf router-id <ip> takes no more',
    'and a trailing word is refused');
}

// Two routers cabled together, R2 holding a second subnet that R1 can only learn over OSPF.
function lab(r1Area, r2Area, r1IfaceArea) {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const r2 = t.addDevice(ROUTER); r2.name = 'R2';
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  const cfg = function (d, cmds) {
    const s = console_(d, t, sim);
    s.run('configure terminal');
    for (const cmd of cmds) s.run(cmd);
    s.run('end');
    return s;
  };
  const cmds1 = ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'ospf router-id 1.1.1.1', 'ospf area ' + r1Area];
  if (r1IfaceArea !== undefined) {
    cmds1.push('interface Gi0/0', 'ip ospf area ' + r1IfaceArea, 'exit');
  }
  cfg(r1, cmds1);
  cfg(r2, ['interface Gi0/0', 'ip address 10.0.0.2 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.9.9.2 255.255.255.0', 'exit',
    'ospf router-id 2.2.2.2', 'ospf area ' + r2Area]);
  return { t: t, r1: r1, r2: r2, sim: sim, s: console_(r1, t, sim) };
}

console.log('\nTwo ends of one link must share an area - and a mismatch says so:');
{
  const env = lab(1, 2);
  const nb = env.s.run('show ip ospf neighbor').output;
  ok(!/FULL/.test(nb.join('\n')), 'no adjacency forms across an area mismatch');
  ok(nb.some(function (l) { return /R2 on Gi0\/0 is in area 2 and this interface is in area 1/.test(l); }),
    'and the table says which link was excluded and why');
  ok(!/10\.9\.9/.test(env.s.run('show ip route ospf').output.join('\n')),
    'no OSPF route is learned over the mismatched link');
  ok(!/10\.9\.9/.test(env.s.run('show ip route').output.join('\n')),
    'so R2\'s second subnet is not in R1\'s table at all');
  eq(env.s.run('ping 10.9.9.2 count 2').output.filter(function (l) {
    return /Success rate is 0 percent/.test(l);
  }).length, 1, 'and a ping to it fails, which is what the missing route means');
}

console.log('\nThe same link, with matching areas, works:');
{
  const env = lab(0, 0);
  ok(/FULL/.test(env.s.run('show ip ospf neighbor').output.join('\n')), 'both ends in area 0 form FULL');
  ok(/10\.9\.9/.test(env.s.run('show ip route ospf').output.join('\n')), 'and the route is learned');
  eq(/Success rate is (\d+) percent/.exec(env.s.run('ping 10.9.9.2 count 2').output.join(' '))[1], '100',
    'and two pings to the far subnet come back');
}

console.log('\nThe dotted form of an area is the same area:');
{
  // `0.0.0.1` and `1` are the same area in OSPF. With parseInt they were not: the dotted form
  // became 0, so one end was in area 0 and the other in area 1 - which is exactly the mismatch
  // above, and it used to form an adjacency anyway.
  const env = lab('0.0.0.1', 1);
  ok(/FULL/.test(env.s.run('show ip ospf neighbor').output.join('\n')),
    'area 0.0.0.1 and area 1 are the same area, so the adjacency forms');
  eq(env.r1.config.ospf.areaId, env.r2.config.ospf.areaId, 'and both store the same integer');

  const allOnes = lab('255.255.255.255', 255);
  ok(!/FULL/.test(allOnes.s.run('show ip ospf neighbor').output.join('\n')),
    'while 255.255.255.255 (4294967295) and 255 are different areas, and no adjacency forms');
}

console.log('\nA per-interface area overrides the process default:');
{
  const env = lab(1, 2, 2);
  ok(/FULL/.test(env.s.run('show ip ospf neighbor').output.join('\n')),
    'process area 1, interface area 2, peer area 2 -> FULL');
  ok(/10\.9\.9/.test(env.s.run('show ip route ospf').output.join('\n')), 'and the route is learned');
  const shown = env.s.run('show ip ospf').output.join('\n');
  ok(/Gi0\/0\s+\d+\s+2\s/.test(shown), 'and show ip ospf reports the interface in area 2, not the process default');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
