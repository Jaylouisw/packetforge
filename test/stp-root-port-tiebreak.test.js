'use strict';
// Which port a bridge elects when two paths to the root cost the same (#fidelity: root-port tie-break).
//
// 802.1D compares five fields in order: root bridge ID, root path cost, sender bridge ID, sender port ID, and
// only then the receiving port ID. `engine/stp.js` compared three of them - cost, sender bridge ID, and the
// local port *name as a string* - so it skipped the one field that decides between two parallel links to the
// same neighbour, and the field it did use ordered `Fa0/10` ahead of `Fa0/9`, because '1' < '9'.
//
// Two links from a non-root bridge to the root, therefore, had their root port picked by the wrong rule twice
// over: the tree blocked the link the box forwards on. The vendor states the order in one sentence each, in
// "Information about Multiple Spanning Tree Protocol":
//
//   "If there is a tie with respect to the root path cost, port on local switch which receives the BPDU with
//    the lowest sender bridge ID is selected as root port."
//   "Where two paths from a given LAN segment have an equal cost, the selection is further determined by the
//    lowest bridge ID of the attached devices, and in the case of two attachments to the same device, by the
//    configured port priority and port ID of the neighboring attached ports."
//
// (research/stp-root-port-tiebreak.md carries the URLs.)
const path = require('path');
const stp = require('../engine/stp');
const { Topology, Simulator, runCommands, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const runStp = stp.runStp;
const comparePortIds = stp.comparePortIds;

function link(name, peer, peerPort, cost) {
  const p = { name: name, to: { bridge: peer, port: peerPort } };
  if (cost !== undefined) p.cost = cost;
  return p;
}
function bridge(key, priority, mac, ports) {
  return { key: key, priority: priority, mac: mac, ports: ports };
}

// ---------------------------------------------------------------------------
console.log('a port ID is a number, not a name');
{
  ok(comparePortIds('Fa0/9', 'Fa0/10') < 0, 'Fa0/9 is the lower port ID (string order said Fa0/10)',
    String(comparePortIds('Fa0/9', 'Fa0/10')));
  ok(comparePortIds('Fa0/10', 'Fa0/9') > 0, 'and the comparison is antisymmetric');
  ok(comparePortIds('Gi1/0/10', 'Gi2/0/1') < 0,
    'Gi1/0/10 is lower than Gi2/0/1: modules come before ports',
    String(comparePortIds('Gi1/0/10', 'Gi2/0/1')));
  ok(comparePortIds('Fa0/1', 'Fa0/1') === 0, 'a port compared with itself is equal');
  ok(comparePortIds('Po1', 'Po2') < 0, 'an aggregator name is compared the same way');
  ok(comparePortIds('Fa0/2', 'Gi0/1') < 0 && comparePortIds('Gi0/1', 'Fa0/2') > 0,
    'two different port types still compare one way round');
}

// ---------------------------------------------------------------------------
console.log('\ntwo parallel links to the root: the neighbour lower port wins');
{
  // sw1 is the root (priority 4096). Two equal-cost links: sw1 Fa0/9 - sw2 Fa0/2, and sw1 Fa0/10 - sw2 Fa0/1.
  // Same sender bridge, so only the sender port ID decides: Fa0/9 over Fa0/10, i.e. sw2 roots through Fa0/2.
  const res = runStp({
    bridges: [
      bridge('sw1', 4096, '00:00:00:00:00:01', [link('Fa0/9', 'sw2', 'Fa0/2'), link('Fa0/10', 'sw2', 'Fa0/1')]),
      bridge('sw2', 32768, '00:00:00:00:00:02', [link('Fa0/1', 'sw1', 'Fa0/10'), link('Fa0/2', 'sw1', 'Fa0/9')])
    ]
  });
  ok(res.root.key === 'sw1', 'sw1 is the root', res.root.key);
  ok(res.ports.sw2['Fa0/2'].role === 'root', 'sw2 roots through Fa0/2, the link from the root Fa0/9',
    res.ports.sw2['Fa0/2'].role);
  ok(res.ports.sw2['Fa0/2'].state === 'forwarding', 'and that port forwards');
  ok(res.ports.sw2['Fa0/1'].role === 'alternate', 'the other link is the alternate',
    res.ports.sw2['Fa0/1'].role);
  ok(res.ports.sw2['Fa0/1'].state === 'blocking', 'and it is the one blocking traffic');
  ok(res.blocked.length === 1 && res.blocked[0].bridge === 'sw2' && res.blocked[0].port === 'Fa0/1',
    'exactly one port is blocked, on sw2: Fa0/1', JSON.stringify(res.blocked));

  // The old chain - cost, sender bridge ID, then `p.name < bestPort.name` as strings - answered Fa0/1 root,
  // Fa0/2 alternate on this graph. Both halves of the fix are load-bearing: the sender port ID picks the link,
  // and a name comparison would still have picked the wrong one if it were reached.
  const reversed = runStp({
    bridges: [
      bridge('sw2', 32768, '00:00:00:00:00:02', [link('Fa0/2', 'sw1', 'Fa0/9'), link('Fa0/1', 'sw1', 'Fa0/10')]),
      bridge('sw1', 4096, '00:00:00:00:00:01', [link('Fa0/10', 'sw2', 'Fa0/1'), link('Fa0/9', 'sw2', 'Fa0/2')])
    ]
  });
  ok(reversed.ports.sw2['Fa0/2'].role === 'root' && reversed.ports.sw2['Fa0/1'].role === 'alternate',
    'the answer does not depend on the order the ports or the bridges are listed in');
}

// ---------------------------------------------------------------------------
console.log('\ncost still outranks every port ID');
{
  // The link through sw2 Fa0/1 is one cheap hop and the one through Fa0/2 is expensive, so the cheaper port is
  // the root port even though its sender port ID is the higher one. A tie-break must never beat the cost.
  const res = runStp({
    bridges: [
      bridge('sw1', 4096, '00:00:00:00:00:01', [link('Fa0/9', 'sw2', 'Fa0/2'), link('Fa0/10', 'sw2', 'Fa0/1')]),
      bridge('sw2', 32768, '00:00:00:00:00:02', [link('Fa0/1', 'sw1', 'Fa0/10', 4), link('Fa0/2', 'sw1', 'Fa0/9', 19)])
    ]
  });
  ok(res.ports.sw2['Fa0/1'].role === 'root', 'the 4-cost link is the root port', res.ports.sw2['Fa0/1'].role);
  ok(res.ports.sw2['Fa0/2'].role === 'alternate', 'the 19-cost link is the alternate');
}

// ---------------------------------------------------------------------------
console.log('\nthe receiving port is the last term, and it is a number too');
{
  // Two links onto one neighbour port cannot be cabled, so this is the only way to reach the fifth term: the
  // BPDUs are byte-identical and only the receiving port differs. It is asserted so a future graph shape cannot
  // quietly fall back to comparing names as strings - the old rule chose Fa0/10 over Fa0/9.
  const res = runStp({
    bridges: [
      bridge('sw1', 4096, '00:00:00:00:00:01', [link('Fa0/1', 'sw2', 'Fa0/1'), link('Fa0/1', 'sw2', 'Fa0/1')]),
      bridge('sw2', 32768, '00:00:00:00:00:02', [link('Fa0/10', 'sw1', 'Fa0/1'), link('Fa0/9', 'sw1', 'Fa0/1')])
    ]
  });
  ok(res.ports.sw2['Fa0/9'].role === 'root', 'the lower receiving port ID (Fa0/9) is the root port',
    res.ports.sw2['Fa0/9'].role);
  ok(res.ports.sw2['Fa0/10'].role === 'alternate', 'the higher one (Fa0/10) is the alternate',
    res.ports.sw2['Fa0/10'].role);
}

// ---------------------------------------------------------------------------
console.log('\nwhat an operator sees: `show spanning-tree` on the non-root bridge');
{
  const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
  const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
  const t = new Topology();
  const sw1 = t.addDevice(SWITCH, 'sw1');
  t.addDevice(SWITCH, 'sw2');
  // generic-switch ports are 1 Gb, so both links cost 4 - equal, which is the case being tested. The cables are
  // crossed so the sender port ID and the receiving port ID disagree: sw2 Fa0/1 faces sw1 Fa0/2, and sw2 Fa0/2
  // faces sw1 Fa0/1. The box roots through the link from sw1 Fa0/1, i.e. through its own Fa0/2; the old chain
  // compared the two local names and rooted through Fa0/1 instead.
  t.connect('sw1', 'Fa0/2', 'sw2', 'Fa0/1');
  t.connect('sw1', 'Fa0/1', 'sw2', 'Fa0/2');
  const sim = new Simulator(t);
  runCommands(sw1, t, sim, ['configure terminal', 'spanning-tree priority 4096']);
  sim.computeStp();
  const out = (new CliSession(t.getDevice('sw2'), t, sim).run('show spanning-tree').output || []).map(String);
  const row = function (port) {
    return out.filter(function (l) { return l.trim().split(/\s+/)[0] === port; })[0] || '';
  };
  ok(/Root\s+FWD/.test(row('Fa0/2')), 'sw2 lists Fa0/2 as Root, FWD', row('Fa0/2'));
  ok(/Altn\s+BLK/.test(row('Fa0/1')), 'sw2 lists Fa0/1 as Altn, BLK', row('Fa0/1'));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
