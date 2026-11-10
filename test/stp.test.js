'use strict';
// stp.test.js -- 802.1D root election, port roles and blocking.
const stp = require('../engine/stp');

const STP_DEFAULT_PRIORITY = stp.STP_DEFAULT_PRIORITY;
const validateBridgePriority = stp.validateBridgePriority;
const runStp = stp.runStp;

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

// Build a port that faces another bridge.
function link(name, peer, peerPort, cost) {
  const p = { name: name, to: { bridge: peer, port: peerPort } };
  if (cost !== undefined) p.cost = cost;
  return p;
}
// Edge / host port.
function edge(name, cost) {
  const p = { name: name, to: null };
  if (cost !== undefined) p.cost = cost;
  return p;
}
function bridge(key, priority, mac, ports) {
  return { key: key, priority: priority, mac: mac, ports: ports };
}
function countBlocked(res) { return res.blocked.length; }
function rolesOf(res, key) {
  const out = {};
  Object.keys(res.ports[key] || {}).forEach(function (p) { out[p] = res.ports[key][p].role; });
  return out;
}

// ---------------------------------------------------------------------------
console.log('validateBridgePriority');
{
  ok(STP_DEFAULT_PRIORITY === 32768, 'STP_DEFAULT_PRIORITY is 32768');
  ok(validateBridgePriority(0) === true, 'accepts 0');
  ok(validateBridgePriority(4096) === true, 'accepts 4096');
  ok(validateBridgePriority(32768) === true, 'accepts 32768');
  ok(validateBridgePriority(61440) === true, 'accepts 61440');
  ok(validateBridgePriority(1000) === false, 'rejects 1000 (not a multiple of 4096)');
  ok(validateBridgePriority(65536) === false, 'rejects 65536 (above 61440)');
  ok(validateBridgePriority(-4096) === false, 'rejects negative priority');
  ok(validateBridgePriority(4096.5) === false, 'rejects fractional priority');
  ok(validateBridgePriority(null) === false, 'rejects null');
  ok(validateBridgePriority('32768') === false, 'rejects a string');
}

// ---------------------------------------------------------------------------
console.log('\nsingle bridge is the root, all ports designated');
{
  const res = runStp({
    bridges: [
      bridge('sw1', 32768, '00:00:00:00:00:0a', [edge('Gi0/1'), edge('Gi0/2'), edge('Gi0/3')])
    ]
  });
  ok(res.root.priority === 32768, 'root priority is 32768');
  ok(res.root.mac === '00:00:00:00:00:0a', 'root mac is reported');
  ok(countBlocked(res) === 0, 'nothing blocks');
  const r = rolesOf(res, 'sw1');
  ok(r['Gi0/1'] === 'designated' && r['Gi0/2'] === 'designated' && r['Gi0/3'] === 'designated',
    'every port is designated');
  ok(Object.keys(res.ports.sw1).every(function (p) { return res.ports.sw1[p].state === 'forwarding'; }),
    'every port forwards');
  ok(res.ports.sw1['Gi0/1'].cost === 20000, 'default port cost is 20000');
}

// ---------------------------------------------------------------------------
console.log('\ntwo bridges, one link');
{
  const res = runStp({
    bridges: [
      bridge('sw1', 32768, '00:00:00:00:00:01', [edge('Gi0/1'), link('Gi0/9', 'sw2', 'Gi0/9')]),
      bridge('sw2', 32768, '00:00:00:00:00:02', [edge('Gi0/1'), link('Gi0/9', 'sw1', 'Gi0/9')])
    ]
  });
  ok(res.root.mac === '00:00:00:00:00:01', 'lowest MAC wins between equal priorities');
  ok(res.ports.sw1['Gi0/9'].role === 'designated', 'root bridge port is designated');
  ok(res.ports.sw1['Gi0/9'].state === 'forwarding', 'root bridge port forwards');
  ok(res.ports.sw2['Gi0/9'].role === 'root', 'far bridge port is the root port');
  ok(res.ports.sw2['Gi0/9'].state === 'forwarding', 'root port forwards');
  ok(res.ports.sw2['Gi0/1'].role === 'designated', 'edge port on the far bridge is designated');
  ok(countBlocked(res) === 0, 'a single link blocks nothing');
}

// ---------------------------------------------------------------------------
console.log('\npriority beats MAC in root election');
{
  const res = runStp({
    bridges: [
      bridge('sw1', 32768, '00:00:00:00:00:01', [link('Gi0/9', 'sw2', 'Gi0/9')]),
      bridge('sw2', 4096, '00:00:00:00:00:ff', [link('Gi0/9', 'sw1', 'Gi0/9')])
    ]
  });
  ok(res.root.mac === '00:00:00:00:00:ff', 'priority 4096 wins despite the higher MAC');
  ok(res.root.priority === 4096, 'root priority reported as 4096');
  ok(res.ports.sw2['Gi0/9'].role === 'designated', 'the priority winner owns the designated port');
  ok(res.ports.sw1['Gi0/9'].role === 'root', 'the other bridge uses it as its root port');
}

// ---------------------------------------------------------------------------
console.log('\ntwo bridges, two parallel links (one must block)');
{
  const res = runStp({
    bridges: [
      bridge('sw1', 32768, '00:00:00:00:00:01', [link('Gi0/1', 'sw2', 'Gi0/1'), link('Gi0/2', 'sw2', 'Gi0/2')]),
      bridge('sw2', 32768, '00:00:00:00:00:02', [link('Gi0/1', 'sw1', 'Gi0/1'), link('Gi0/2', 'sw1', 'Gi0/2')])
    ]
  });
  ok(res.root.mac === '00:00:00:00:00:01', 'sw1 is root');
  ok(countBlocked(res) === 1, 'exactly one port blocks');
  ok(res.blocked[0].bridge === 'sw2', 'the blocked port is on the non-root bridge');
  ok(res.ports.sw2['Gi0/1'].role === 'root' && res.ports.sw2['Gi0/1'].state === 'forwarding',
    'one port is the forwarding root port');
  const other = res.blocked[0].port;
  ok(res.ports.sw2[other].role === 'alternate' && res.ports.sw2[other].state === 'blocking',
    'the other port is alternate/blocking');
  ok(res.ports.sw1['Gi0/1'].state === 'forwarding' && res.ports.sw1['Gi0/2'].state === 'forwarding',
    'both root-side ports stay designated/forwarding');
}

// ---------------------------------------------------------------------------
console.log('\nthree-bridge triangle (one loop -> one block)');
{
  const res = runStp({
    bridges: [
      bridge('A', 32768, '00:00:00:00:00:01', [edge('Fa0/1'), link('Gi0/1', 'B', 'Gi0/1'), link('Gi0/2', 'C', 'Gi0/2')]),
      bridge('B', 32768, '00:00:00:00:00:02', [edge('Fa0/1'), link('Gi0/1', 'A', 'Gi0/1'), link('Gi0/2', 'C', 'Gi0/1')]),
      bridge('C', 32768, '00:00:00:00:00:03', [edge('Fa0/1'), link('Gi0/1', 'B', 'Gi0/2'), link('Gi0/2', 'A', 'Gi0/2')])
    ]
  });
  ok(res.root.mac === '00:00:00:00:00:01', 'A is root');
  ok(countBlocked(res) === 1, 'exactly one port blocks in the triangle');
  const blockedBridges = res.blocked.map(function (b) { return b.bridge; });
  ok(blockedBridges.indexOf('B') !== -1 || blockedBridges.indexOf('C') !== -1, 'the block is on B or C, not the root');
  ok(blockedBridges.indexOf('A') === -1, 'no port on the root bridge blocks');
  ok(res.ports.B['Gi0/1'].role === 'root' && res.ports.C['Gi0/2'].role === 'root',
    'B and C each have a root port toward A');
  ok(res.ports.A['Fa0/1'].state === 'forwarding' && res.ports.B['Fa0/1'].state === 'forwarding' &&
     res.ports.C['Fa0/1'].state === 'forwarding', 'all edge ports forward');
  let total = 0;
  Object.keys(res.ports).forEach(function (k) { total += Object.keys(res.ports[k]).length; });
  ok(total === 9, 'every port of every bridge is accounted for (' + total + ')');
  const forwarding = Object.keys(res.ports).reduce(function (n, k) {
    return n + Object.keys(res.ports[k]).filter(function (p) { return res.ports[k][p].state === 'forwarding'; }).length;
  }, 0);
  ok(forwarding === 8, 'eight ports forward, one blocks (' + forwarding + ')');
}

// ---------------------------------------------------------------------------
console.log('\nfour-bridge square (one loop -> one block)');
{
  const res = runStp({
    bridges: [
      bridge('A', 32768, '00:00:00:00:00:01', [link('Gi0/1', 'B', 'Gi0/1'), link('Gi0/2', 'D', 'Gi0/1')]),
      bridge('B', 32768, '00:00:00:00:00:02', [link('Gi0/1', 'A', 'Gi0/1'), link('Gi0/2', 'C', 'Gi0/1')]),
      bridge('C', 32768, '00:00:00:00:00:03', [link('Gi0/1', 'B', 'Gi0/2'), link('Gi0/2', 'D', 'Gi0/2')]),
      bridge('D', 32768, '00:00:00:00:00:04', [link('Gi0/1', 'A', 'Gi0/2'), link('Gi0/2', 'C', 'Gi0/2')])
    ]
  });
  ok(countBlocked(res) === 1, 'a single loop in a square blocks exactly one port');
  ok(res.blocked[0].bridge === 'C', 'the far bridge (C) blocks its port toward D');
  ok(res.ports.C['Gi0/1'].role === 'root', 'C roots through B (equal cost, lower neighbour bridge ID)');
  ok(res.ports.C['Gi0/2'].role === 'alternate', 'C Gi0/2 toward D is alternate');
  ok(res.ports.C['Gi0/2'].state === 'blocking', 'C Gi0/2 is blocking');
  ok(res.ports.B['Gi0/2'].state === 'forwarding' && res.ports.D['Gi0/2'].state === 'forwarding',
    'the loop is broken on the C-D segment only');
}

// ---------------------------------------------------------------------------
console.log('\nexplicit costs steer root-port choice');
{
  // A--B cheap, A--C expensive, B--C medium: C must root through B.
  const res = runStp({
    bridges: [
      bridge('A', 32768, '00:00:00:00:00:01', [link('Gi0/1', 'B', 'Gi0/1', 1000), link('Gi0/2', 'C', 'Gi0/1', 5000)]),
      bridge('B', 32768, '00:00:00:00:00:02', [link('Gi0/1', 'A', 'Gi0/1', 1000), link('Gi0/2', 'C', 'Gi0/2', 2000)]),
      bridge('C', 32768, '00:00:00:00:00:05', [link('Gi0/1', 'A', 'Gi0/2', 5000), link('Gi0/2', 'B', 'Gi0/2', 2000)])
    ]
  });
  ok(res.ports.C['Gi0/2'].role === 'root', 'C roots through B (path cost 3000 < 5000)');
  ok(res.ports.C['Gi0/1'].role === 'alternate', 'C Gi0/1 toward A blocks');
  ok(countBlocked(res) === 1, 'one blocked port');
  ok(res.ports.A['Gi0/1'].cost === 1000 && res.ports.A['Gi0/2'].cost === 5000, 'explicit costs are honoured in the output');
}

// ---------------------------------------------------------------------------
console.log('\nadministratively disabled port');
{
  const res = runStp({
    bridges: [
      bridge('sw1', 32768, '00:00:00:00:00:01', [edge('Gi0/1'), link('Gi0/2', 'sw2', 'Gi0/1')]),
      bridge('sw2', 32768, '00:00:00:00:00:02', [
        { name: 'Gi0/1', cost: 20000, to: { bridge: 'sw1', port: 'Gi0/2' }, enabled: false },
        edge('Gi0/2')
      ])
    ]
  });
  ok(res.ports.sw2['Gi0/1'].role === 'disabled', 'disabled port gets role disabled');
  ok(res.ports.sw2['Gi0/1'].state === 'blocking', 'disabled port is blocking');
  ok(countBlocked(res) === 0, 'a disabled port is not reported as an alternate block');
  ok(res.ports.sw2['Gi0/2'].state === 'forwarding', 'the remaining edge port still forwards');
}

// ---------------------------------------------------------------------------
console.log('\nedge cases');
{
  const empty = runStp({ bridges: [] });
  // No bridges, no election, no root. This used to answer a root object with the default priority and a null MAC:
  // an identity for a tree that does not exist, which is what `show spanning-tree` printed as `root bridge
  // undefined` on every router in the catalogue (#1399). The absence is the fact, so the absence is what is
  // returned - `null`, the same answer the console gives when nothing has been measured.
  ok(empty.root === null, 'empty input has no root at all');
  ok(Array.isArray(empty.blocked) && empty.blocked.length === 0, 'empty input blocks nothing');

  const missingPriority = runStp({ bridges: [bridge('sw1', undefined, '00:00:00:00:00:07', [edge('Gi0/1')])] });
  ok(missingPriority.root.priority === 32768, 'absent priority defaults to 32768');

  const sameTwice = runStp({
    bridges: [
      bridge('sw1', 32768, '00:00:00:00:00:01', [link('Gi0/1', 'sw2', 'Gi0/1')]),
      bridge('sw2', 32768, '00:00:00:00:00:02', [link('Gi0/1', 'sw1', 'Gi0/1')])
    ]
  });
  const sameTwice2 = runStp({
    bridges: [
      bridge('sw1', 32768, '00:00:00:00:00:01', [link('Gi0/1', 'sw2', 'Gi0/1')]),
      bridge('sw2', 32768, '00:00:00:00:00:02', [link('Gi0/1', 'sw1', 'Gi0/1')])
    ]
  });
  ok(JSON.stringify(sameTwice) === JSON.stringify(sameTwice2), 'runStp is deterministic across runs');

  const reversedOrder = runStp({
    bridges: [
      bridge('sw2', 32768, '00:00:00:00:00:02', [link('Gi0/1', 'sw1', 'Gi0/1')]),
      bridge('sw1', 32768, '00:00:00:00:00:01', [link('Gi0/1', 'sw2', 'Gi0/1')])
    ]
  });
  ok(reversedOrder.root.mac === '00:00:00:00:00:01', 'root election does not depend on input order');
  ok(reversedOrder.ports.sw1['Gi0/1'].role === 'designated' && reversedOrder.ports.sw2['Gi0/1'].role === 'root',
    'roles are identical when the bridge list is reversed');

  const dangling = runStp({ bridges: [bridge('sw1', 32768, '00:00:00:00:00:01', [link('Gi0/1', 'ghost', 'Gi0/1')])] });
  ok(dangling.ports.sw1['Gi0/1'].state === 'forwarding', 'a port pointing at an unknown bridge stays forwarding');
  ok(countBlocked(dangling) === 0, 'a dangling link blocks nothing');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
