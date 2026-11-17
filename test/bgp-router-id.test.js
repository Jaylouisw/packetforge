'use strict';

// Which address a box elects as its own BGP router identifier when nobody typed `bgp router-id`.
//
// It is the answer to a question an operator asks on every BGP session ever built - "whose router ID is
// that in `show ip bgp`?" - and it is what step 11 of the best-path algorithm compares, so an engine that
// gets it wrong picks routes by a number nobody configured and nobody can read.
//
// Cisco, IP Routing: BGP Command Reference, `bgp router-id` (Command Default): a loopback's address if
// one is configured (the highest, when several are), otherwise the highest address on a physical
// interface. `show ip bgp`'s field description gives the same order: the configured router ID, a loopback
// address, or the highest IP address.
//
// This console elected the FIRST address its interface table yielded (`addrs[0].ip`), so the identifier
// printed by `show ip bgp` was a fact about catalogue order: on a router holding 10.0.0.1 on Gi0/0 and
// 192.168.1.1 on Gi0/1 it printed 10.0.0.1, where a real box prints 192.168.1.1.

const path = require('path');
const { Topology, Simulator, CliSession, runCommands } = require('../engine');
const bgp = require('../engine/bgp');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(got, want, msg) {
  ok(got === want, msg + ' (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')');
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(vendor, model) {
  const s = catalog.find(function (x) { return x.vendor === vendor && x.model === model; });
  if (!s) throw new Error('missing spec ' + vendor + '/' + model);
  return s;
}
function cli(t, dev, cmds) {
  return runCommands(dev, t, null, ['enable', 'configure terminal'].concat(cmds)).lines;
}
function show(t, dev, sim, cmd) {
  return new CliSession(dev, t, sim).run(cmd).output.join('\n');
}

console.log('The election is a maximum over a set, and the set is chosen by kind first:');
{
  eq(bgp.deriveRouterId([
    { name: 'Gi0/0', type: 'ethernet', ip: '10.0.0.1' },
    { name: 'Gi0/1', type: 'ethernet', ip: '192.168.1.1' }
  ]), '192.168.1.1', 'the highest port address wins, whatever order the ports are listed in');

  eq(bgp.deriveRouterId([
    { name: 'Gi0/1', type: 'ethernet', ip: '192.168.1.1' },
    { name: 'Gi0/0', type: 'ethernet', ip: '10.0.0.1' }
  ]), '192.168.1.1', 'and the answer does not depend on that order');

  // 10.0.0.10 is greater than 10.0.0.9 and smaller than it as a string: the comparison is numeric.
  eq(bgp.deriveRouterId([
    { name: 'Gi0/0', type: 'ethernet', ip: '10.0.0.9' },
    { name: 'Gi0/1', type: 'ethernet', ip: '10.0.0.10' }
  ]), '10.0.0.10', 'addresses compare as numbers, not as strings');

  // The documented preference: a loopback outranks a port even when its address is numerically smaller.
  eq(bgp.deriveRouterId([
    { name: 'Gi0/0', type: 'ethernet', ip: '192.168.1.1' },
    { name: 'Lo0', type: 'loopback', ip: '10.0.1.1' }
  ]), '10.0.1.1', 'a loopback address beats a higher port address');

  eq(bgp.deriveRouterId([
    { name: 'Lo0', type: 'loopback', ip: '10.0.1.1' },
    { name: 'Lo9', type: 'loopback', ip: '10.0.1.9' },
    { name: 'Gi0/0', type: 'ethernet', ip: '192.168.1.1' }
  ]), '10.0.1.9', 'among loopbacks, the highest wins');

  // A lab written by hand may carry the name and no type; the spelling table `interface Loopback0` is
  // resolved with has to answer for the name then.
  eq(bgp.deriveRouterId([
    { name: 'Loopback0', ip: '172.16.0.9' },
    { name: 'GigabitEthernet0/0', ip: '192.168.1.1' }
  ]), '172.16.0.9', 'the name alone identifies a loopback');

  eq(bgp.deriveRouterId([
    { name: 'Gi0/0', type: 'ethernet', ip: '' },
    { name: 'Gi0/1', type: 'ethernet' },
    { name: 'Gi0/2', type: 'ethernet', ip: '10.0.0.300' }
  ]), null, 'an unassigned and an unparseable address elect nothing');
  eq(bgp.deriveRouterId([]), null, 'a box with no address has no identifier');
  eq(bgp.deriveRouterId(null), null, 'and asking without a list is not a crash');
}

console.log('\nA router with no `bgp router-id` shows the elected one in `show ip bgp`:');
{
  const t = new Topology();
  const r1 = t.addDevice(spec('generic', 'generic-router'));
  const r2 = t.addDevice(spec('generic', 'generic-router'));
  r1.name = 'R1'; r2.name = 'R2';
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');

  cli(t, r1, [
    'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    // A second port, addressed and unused: 192.168.1.1 is the highest address the box holds, so it is
    // the one a real box elects - and the one this console used to ignore.
    'interface Gi0/1', 'ip address 192.168.1.1 255.255.255.0', 'exit',
    'router bgp 65001', 'neighbor 10.0.0.2 remote-as 65002', 'exit'
  ]);
  cli(t, r2, [
    'interface Gi0/0', 'ip address 10.0.0.2 255.255.255.0', 'exit',
    'router bgp 65002', 'neighbor 10.0.0.1 remote-as 65001', 'exit'
  ]);

  const sim = new Simulator(t);
  sim.computeBgp();
  eq(r1.bgpRouterId, '192.168.1.1', 'the simulator records the highest address as the R1 identifier');
  eq(r2.bgpRouterId, '10.0.0.2', 'R2, holding one address, elects it');

  const out1 = show(t, r1, sim, 'show ip bgp');
  ok(out1.split('\n')[0] === 'BGP router identifier 192.168.1.1, local AS number 65001',
    'the header line of `show ip bgp` names it: ' + out1.split('\n')[0]);

  const out2 = show(t, r2, sim, 'show ip bgp');
  ok(out2.split('\n')[0] === 'BGP router identifier 10.0.0.2, local AS number 65002',
    'and each box answers about itself: ' + out2.split('\n')[0]);
}

console.log('\nA configured `bgp router-id` still wins over the election:');
{
  const t = new Topology();
  const r1 = t.addDevice(spec('generic', 'generic-router'));
  const r2 = t.addDevice(spec('generic', 'generic-router'));
  r1.name = 'R1'; r2.name = 'R2';
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');

  cli(t, r1, [
    'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 192.168.1.1 255.255.255.0', 'exit',
    'router bgp 65001', 'bgp router-id 1.1.1.1', 'neighbor 10.0.0.2 remote-as 65002', 'exit'
  ]);
  cli(t, r2, [
    'interface Gi0/0', 'ip address 10.0.0.2 255.255.255.0', 'exit',
    'router bgp 65002', 'neighbor 10.0.0.1 remote-as 65001', 'exit'
  ]);
  const sim = new Simulator(t);
  sim.computeBgp();
  eq(r1.bgpRouterId, '1.1.1.1', 'the typed identifier is the one the box uses');
  const out = show(t, r1, sim, 'show ip bgp');
  ok(out.split('\n')[0] === 'BGP router identifier 1.1.1.1, local AS number 65001',
    'and it is what `show ip bgp` prints: ' + out.split('\n')[0]);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
