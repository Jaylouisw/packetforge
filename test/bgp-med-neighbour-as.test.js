"use strict";

// MED is comparable only between paths learned from the same neighbouring AS.
//
// `comparePaths()` compared MED unconditionally, and the file header said so ("a deliberate
// simplification: real BGP only compares MED between paths learned from the same neighbour AS").
// The consequence is a table that installs a route a real box would not: two external peers in
// *different* ASes offering the same prefix with different MEDs were separated on MED, when a real box
// treats them as tied at that step and goes on to "eBGP over iBGP", then the advertising router ID.
//
// RFC 4271 9.1.2.2(c) is the rule:
//   "MULTI_EXIT_DISC is only comparable between routes learned from the same neighboring AS."
// Cisco states the same test on the AS_PATH, which is what this engine can see:
//   "This comparison only occurs if the first (the neighboring) AS is the same in the two paths. Any
//    confederation sub-ASs are ignored. In other words, MEDs are compared only if the first AS in the
//    AS_SEQUENCE is the same for multiple paths."   (Select BGP-path Algorithm, doc 13753, step 6)
//   https://www.rfc-editor.org/rfc/rfc4271.txt (9.1.2.2)
//   https://www.cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/13753-25.html
//
// `docs/BGP-POLICY.md` already stated the rule as MED-3/MED-4; the engine was the half that disagreed.

const pathLib = require('path');
const { Topology, Simulator, CliSession, runCommands } = require('../engine');
const bgp = require('../engine/bgp');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ' + String.fromCharCode(10003) + ' ' + msg); }
  else { failed++; console.error('  ' + String.fromCharCode(10007) + ' ' + msg); }
}
function eq(got, want, msg) {
  ok(got === want, msg + ' (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')');
}

const catalog = loadCatalog(pathLib.join(__dirname, '..', 'devices'));
function spec(vendor, model) {
  const s = catalog.find(function (x) { return x.vendor === vendor && x.model === model; });
  if (!s) throw new Error('missing spec ' + vendor + '/' + model);
  return s;
}
function cli(t, dev, cmds) {
  return runCommands(dev, t, null, ['enable', 'configure terminal'].concat(cmds)).lines;
}

// A path that ties with another on everything above MED, so the MED step is the one under test.
function peerPath(over) {
  return Object.assign({
    dest: '10.9.9.0', mask: '255.255.255.0',
    asPath: [65002], origin: bgp.BGP_ORIGIN.IGP,
    localPreference: 100, med: 0, weight: 0,
    session: 'ebgp', nextHop: null, from: 'peer',
    routerId: '1.1.1.1', fromIp: '10.0.12.2'
  }, over || {});
}

console.log('One neighbouring AS: the lower MED still wins, in either argument order');
{
  const low = peerPath({ asPath: [65002], med: 10 });
  const high = peerPath({ asPath: [65002], med: 50 });
  ok(bgp.comparePaths(low, high) < 0, 'MED 10 beats MED 50 from the same AS 65002');
  ok(bgp.comparePaths(high, low) > 0, 'and the answer does not depend on argument order');
  eq(bgp.bestPath([high, low]).med, 10, 'bestPath installs the MED-10 path');
  eq(bgp.bestPath([low, high]).med, 10, 'in both orders');
  // A deeper path through the same neighbouring AS is still a same-AS comparison: the AS we entered
  // from is the leftmost one, whatever depth the path has behind it.
  ok(bgp.comparePaths(peerPath({ asPath: [65002, 65010], med: 10 }),
    peerPath({ asPath: [65002, 65010], med: 50 })) < 0, 'same first AS, deeper path: MED still decides');
}

console.log('\nTwo neighbouring ASes: MED is not compared at all');
{
  // The higher MED is on the path with the lower router ID, so a MED comparison would pick the other
  // one. After the change the tie falls through to the router ID.
  const fromAs2 = peerPath({ asPath: [65002], med: 50, routerId: '1.1.1.1', fromIp: '10.0.12.2' });
  const fromAs3 = peerPath({ asPath: [65003], med: 10, routerId: '3.3.3.3', fromIp: '10.0.13.3' });
  ok(bgp.comparePaths(fromAs2, fromAs3) < 0,
    'AS 65002 with MED 50 beats AS 65003 with MED 10 on the lower router ID');
  ok(bgp.comparePaths(fromAs3, fromAs2) > 0, 'in either argument order');
  eq(bgp.bestPath([fromAs3, fromAs2]).med, 50, 'bestPath installs the higher-MED path, as a box does');
  // Swap the identifiers and the other path wins - by its ID, not by its MED.
  const flipped2 = peerPath({ asPath: [65002], med: 50, routerId: '3.3.3.3', fromIp: '10.0.12.2' });
  const flipped3 = peerPath({ asPath: [65003], med: 10, routerId: '1.1.1.1', fromIp: '10.0.13.3' });
  eq(bgp.bestPath([flipped2, flipped3]).med, 10, 'with the IDs swapped the other path wins');
}

console.log('\nA path that names no neighbouring AS is the local AS, so it stays comparable');
{
  // Empty AS_PATH: originated here. Step 3 settles a local path against a learned one before MED is
  // ever reached, which is asserted so that the null case below cannot start deciding that tie.
  ok(bgp.comparePaths(peerPath({ asPath: [], med: 10, session: 'ibgp' }),
    peerPath({ asPath: [65002], med: 50 })) < 0, 'a locally originated path still outranks a learned one');
  // AS_SET-leading: an aggregate, which 9.1.2.2(c) also treats as the local AS. Equal AS_PATH length
  // (an AS_SET counts as one hop), so MED is the deciding step.
  const aggregate = peerPath({ asPath: [[65010, 65020]], med: 0, routerId: '9.9.9.9' });
  const numbered = peerPath({ asPath: [65002], med: 40, routerId: '1.1.1.1' });
  eq(bgp.bestPath([numbered, aggregate]).med, 0,
    'an AS_SET-leading path is comparable with a numbered one, so its MED 0 wins');
}

console.log('\nThe neighbouring AS is read from the AS_PATH, number or string');
{
  ok(bgp.comparePaths(peerPath({ asPath: ['65002'], med: 10 }), peerPath({ asPath: [65002], med: 50 })) < 0,
    'a string AS number names the same neighbouring AS, so MED decides');
  // Different AS in different spellings, and equal router IDs: only the peer address can decide, which
  // it does only if MED was skipped.
  ok(bgp.comparePaths(peerPath({ asPath: ['65002'], med: 10, fromIp: '10.0.0.9' }),
    peerPath({ asPath: [65003], med: 50, fromIp: '10.0.0.8' })) > 0,
    'a string AS 65002 and a numbered AS 65003 are different neighbours: MED skipped, peer address decides');
}

// --- on a lab: the candidate a peer sends really does name its own AS first -------------------------
//
// The rule reads the leftmost AS of the AS_PATH. That is only the neighbouring AS because an eBGP
// speaker prepends its own AS when it advertises (RFC 4271 5.1.2(b)), so the lab asserts the shape the
// library rule depends on rather than a MED value: this engine has no route-map, so every originated
// route carries MED 0 and two peers cannot be given different MEDs on a lab.
function build(peers) {
  const t = new Topology();
  const r1 = t.addDevice(spec('generic', 'generic-router'));
  r1.name = 'R1';
  const ports = ['Gi0/1', 'Gi0/2'];
  const linkAddrs = ['10.0.12.2', '10.0.13.3'];
  const spineAddrs = ['10.0.12.1', '10.0.13.1'];
  const hostAddrs = ['10.9.9.2', '10.9.9.3'];
  const made = [];
  peers.forEach(function (p, i) {
    const r = t.addDevice(spec('generic', 'generic-router'));
    r.name = 'R' + (i + 2);
    t.connect(r1.id, ports[i], r.id, 'Gi0/1');
    cli(t, r, [
      'interface Gi0/0', 'ip address ' + hostAddrs[i] + ' 255.255.255.0', 'exit',
      'interface Gi0/1', 'ip address ' + linkAddrs[i] + ' 255.255.255.0', 'exit',
      'router bgp ' + p.as, 'bgp router-id ' + p.id,
      'neighbor ' + spineAddrs[i] + ' remote-as 65001',
      'network 10.9.9.0 mask 255.255.255.0', 'exit'
    ]);
    made.push(r);
  });
  cli(t, r1, ['interface Gi0/1', 'ip address 10.0.12.1 255.255.255.0', 'exit',
    'interface Gi0/2', 'ip address 10.0.13.1 255.255.255.0', 'exit',
    'router bgp 65001',
    'neighbor 10.0.12.2 remote-as ' + peers[0].as,
    'neighbor 10.0.13.3 remote-as ' + peers[1].as, 'exit']);
  return { t: t, r1: r1, peers: made };
}

function learnt(lab) {
  return (lab.r1.bgpRoutes || []).filter(function (r) {
    return r.dest === '10.9.9.0' && String(r.mask) === '255.255.255.0';
  });
}

console.log('\nOn a lab, an installed eBGP route begins with the peer AS:');
{
  const lab = build([{ as: 65002, id: '3.3.3.3' }, { as: 65003, id: '1.1.1.1' }]);
  const sim = new Simulator(lab.t);
  sim.computeBgp();
  eq(sim.bgpSessions, 2, 'both eBGP sessions came up');
  const routes = learnt(lab);
  eq(routes.length, 1, 'one route to 10.9.9.0/24');
  eq(routes[0].nextHop, '10.0.13.3', 'the 1.1.1.1 peer wins on router ID, AS 65003 being no better than 65002');
  eq(routes[0].asPath[0], 65003, 'and the AS_PATH names that peer AS first, the value the MED rule reads');
  eq(routes[0].peerAs, 65003, 'the installed route peerAs agrees');
  const shown = new CliSession(lab.r1, lab.t, sim).run('show ip bgp').output.join('\n');
  ok(/10\.9\.9\.0\/24\s+10\.0\.13\.3/.test(shown), 'show ip bgp prints that next hop', shown);
}

console.log('\nTwo peers in the same AS still install one route, and the path names that AS:');
{
  const lab = build([{ as: 65002, id: '3.3.3.3' }, { as: 65002, id: '1.1.1.1' }]);
  const sim = new Simulator(lab.t);
  sim.computeBgp();
  const routes = learnt(lab);
  eq(routes.length, 1, 'one route');
  eq(routes[0].nextHop, '10.0.13.3', 'the lower router ID wins, as before');
  eq(routes[0].asPath[0], 65002, 'the shared neighbouring AS, which is what makes their MEDs comparable');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
