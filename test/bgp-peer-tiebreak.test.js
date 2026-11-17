"use strict";

// Which of two equal BGP paths wins: the advertising router's ID, then the peer address.
//
// `comparePaths()` documented eight decision steps and compared seven: no candidate ever carried a
// `routerId`, so step 8 compared undefined with undefined, returned 0, and the best path fell out of
// Array.prototype.sort in insertion order. Two peers offering the same prefix with the same AS path
// therefore won by whichever was walked first - a fact about topology device order, not about BGP.
//
// RFC 4271 9.1.2.2 ends Phase 2 with:
//   f) Remove from consideration all routes other than the route that was advertised by the BGP speaker
//      with the lowest BGP Identifier value.
//   g) Prefer the route received from the lowest peer address.
// Cisco, "Select BGP-path Algorithm" (doc 13753), states the same pair as steps 11 and 13 - step 12,
// minimum cluster list length, only exists in a route-reflector topology this model does not have.
//   https://www.rfc-editor.org/rfc/rfc4271.txt (9.1.2.2)
//   https://www.cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/13753-25.html

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

// Two equal external paths to the same prefix.
function equalPaths(over) {
  const base = {
    dest: '10.9.9.0', mask: '255.255.255.0',
    asPath: [65002], origin: bgp.BGP_ORIGIN.IGP,
    localPreference: 100, med: 0, weight: 0,
    session: 'ebgp', nextHop: null, from: 'peer'
  };
  return Object.assign(base, over || {});
}

console.log('The lowest advertising router ID wins, in either argument order:');
{
  const low = equalPaths({ routerId: '1.1.1.1', fromIp: '10.0.12.2' });
  const high = equalPaths({ routerId: '3.3.3.3', fromIp: '10.0.13.3' });
  ok(bgp.comparePaths(low, high) < 0, 'ID 1.1.1.1 beats ID 3.3.3.3');
  ok(bgp.comparePaths(high, low) > 0, 'and the answer does not depend on which side is passed first');
  eq(bgp.bestPath([high, low]).routerId, '1.1.1.1', 'bestPath picks the 1.1.1.1 path for [high, low]');
  eq(bgp.bestPath([low, high]).routerId, '1.1.1.1', 'and for the other order too');
}

console.log('\nThe ID is compared as a number, not as a string:');
{
  const a = equalPaths({ routerId: '10.0.0.9' });
  const b = equalPaths({ routerId: '10.0.0.10' });
  eq(bgp.bestPath([b, a]).routerId, '10.0.0.9', '10.0.0.9 is lower than 10.0.0.10');
}

console.log('\nWith the same ID, the lowest peer address wins:');
{
  const r9 = equalPaths({ routerId: '1.1.1.1', fromIp: '10.0.0.9' });
  const r10 = equalPaths({ routerId: '1.1.1.1', fromIp: '10.0.0.10' });
  eq(bgp.bestPath([r10, r9]).fromIp, '10.0.0.9', '10.0.0.9 is the lower peer, not the lower string');
  eq(bgp.bestPath([r9, r10]).fromIp, '10.0.0.9', 'in either order');
  const lowId = equalPaths({ routerId: '1.1.1.1', fromIp: '10.0.0.99' });
  const highId = equalPaths({ routerId: '2.2.2.2', fromIp: '10.0.0.1' });
  eq(bgp.bestPath([highId, lowId]).routerId, '1.1.1.1', 'the ID is decided before the peer address');
}

console.log('\nA path with no peer address (locally originated) sorts after one that has:');
{
  const local = equalPaths({ routerId: '1.1.1.1', fromIp: null, session: 'ibgp' });
  const learned = equalPaths({ routerId: '1.1.1.1', fromIp: '10.0.0.9' });
  eq(bgp.bestPath([local, learned]).fromIp, '10.0.0.9', 'the learned path wins the last step');
  ok(bgp.comparePaths(learned, local) < 0, 'and the comparison says so');
}

// A spine, two external peers in the same AS, both offering the same prefix. Nothing else differs:
// same AS path length, same origin, same MED, both eBGP - so the whole decision is steps 11 and 13.
function build(order, ids) {
  const t = new Topology();
  const r1 = t.addDevice(spec('generic', 'generic-router'));
  r1.name = 'R1';
  const peers = [];
  const linkPorts = ['Gi0/1', 'Gi0/2'];
  const hostAddrs = ['10.9.9.2', '10.9.9.3'];
  const linkAddrs = ['10.0.12.2', '10.0.13.3'];
  const spineAddrs = ['10.0.12.1', '10.0.13.1'];
  const create = function (i) {
    const r = t.addDevice(spec('generic', 'generic-router'));
    r.name = 'R' + (i + 2);
    t.connect(r1.id, linkPorts[i], r.id, 'Gi0/1');
    cli(t, r, [
      'interface Gi0/0', 'ip address ' + hostAddrs[i] + ' 255.255.255.0', 'exit',
      'interface Gi0/1', 'ip address ' + linkAddrs[i] + ' 255.255.255.0', 'exit',
      'router bgp 65002', 'bgp router-id ' + ids[i],
      'neighbor ' + spineAddrs[i] + ' remote-as 65001',
      'network 10.9.9.0 mask 255.255.255.0', 'exit'
    ]);
    peers[i] = r;
  };
  for (const i of order) create(i);
  cli(t, r1, [
    'interface Gi0/1', 'ip address 10.0.12.1 255.255.255.0', 'exit',
    'interface Gi0/2', 'ip address 10.0.13.1 255.255.255.0', 'exit',
    'router bgp 65001',
    'neighbor 10.0.12.2 remote-as 65002',
    'neighbor 10.0.13.3 remote-as 65002', 'exit'
  ]);
  return { t: t, r1: r1, peers: peers };
}

function learned(lab, prefix) {
  return (lab.r1.bgpRoutes || []).filter(function (r) {
    return r.dest === prefix && String(r.mask) === '255.255.255.0';
  });
}

console.log('\nOn a lab, the lower-ID peer supplies the route - whichever device was added first:');
{
  const lab = build([0, 1], ['3.3.3.3', '1.1.1.1']);
  const sim = new Simulator(lab.t);
  sim.computeBgp();
  eq(sim.bgpSessions, 2, 'both eBGP sessions came up');
  const routes = learned(lab, '10.9.9.0');
  eq(routes.length, 1, 'one route to 10.9.9.0/24');
  eq(routes[0].nextHop, '10.0.13.3', 'next hop is the 1.1.1.1 peer, not the peer added first');
  const shown = new CliSession(lab.r1, lab.t, sim).run('show ip bgp').output.join('\n');
  ok(/10\.9\.9\.0\/24\s+10\.0\.13\.3/.test(shown), 'show ip bgp prints that next hop', shown);
}

console.log('\nAnd it is the same answer when the devices are added in the other order:');
{
  const lab = build([1, 0], ['3.3.3.3', '1.1.1.1']);
  const sim = new Simulator(lab.t);
  sim.computeBgp();
  const routes = learned(lab, '10.9.9.0');
  eq(routes.length, 1, 'one route');
  eq(routes[0].nextHop, '10.0.13.3', 'still the 1.1.1.1 peer');
}

console.log('\nTwo peers that advertise the same router ID are separated by peer address:');
{
  const lab = build([0, 1], ['1.1.1.1', '1.1.1.1']);
  const sim = new Simulator(lab.t);
  sim.computeBgp();
  const routes = learned(lab, '10.9.9.0');
  eq(routes.length, 1, 'one route');
  eq(routes[0].nextHop, '10.0.12.2', 'the lower peer address 10.0.12.2 wins');

  const flipped = build([1, 0], ['1.1.1.1', '1.1.1.1']);
  const sim2 = new Simulator(flipped.t);
  sim2.computeBgp();
  eq(learned(flipped, '10.9.9.0')[0].nextHop, '10.0.12.2', 'and again with the peers added in the other order');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
