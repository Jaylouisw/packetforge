'use strict';
// `show spanning-tree` lists its ports in PORT order, not in character order.
//
// The table was built from `Object.keys(st.states).sort()`, a string sort. On any box with ten or more ports
// in the tree that printed `Gi1/0/1, Gi1/0/10, Gi1/0/11, Gi1/0/12, Gi1/0/2, ...` - an order no capture shows.
// Two live transcripts on Cisco hardware disagree with it and agree with each other:
//
//   * a 2960/9300 stack member's `#sh spanning-tree vlan 10` lists Gi1/0/4, Gi1/0/5, Gi1/0/6, Gi1/0/9,
//     Gi1/0/10, Gi1/0/11, Gi1/0/13 ... with Prio.Nbr 128.9 / 128.10 / 128.11 beside the rows
//     (community.spiceworks.com/t/dhcp-suddenly-fails-on-specific-vlan-and-specific-ports/795152);
//   * a C9300's `show spanning-tree` lists Gi1/0/1, Gi1/0/2, Gi1/0/6, Gi1/0/8, Gi1/0/10, Gi1/0/11, Gi1/0/13 ...
//     (community.cisco.com/t5/switching/td-p/4852991) - a string sort would have printed 10, 11, 13, 15, 17,
//     2, 20, 22, 23 before `Gi1/0/6`.
//
// A box walks its port list, and the port list is numbered. research/show-spanning-tree-port-order.md holds
// the evidence, and what the captures do not settle (the order between two *types* of port).
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }

// One 24-port Catalyst, and one peer switch per cable - only a cabled port is in the tree, so the cables are
// what decides which ports the table has to put in order.
function star(ports) {
  const t = new Topology();
  const sw = t.addDevice(spec('C2960X-24TS-L'), 'sw1');
  ports.forEach(function (p, i) {
    const peer = t.addDevice(spec('generic-switch'), 'sw' + (i + 2));
    t.connect(sw.id, p, peer.id, 'Fa0/1');
  });
  return { topo: t, sw: sw };
}

function rows(session) {
  const out = session.run('show spanning-tree').output.map(String);
  const head = out.indexOf('Interface           Role Sts Cost');
  // One line for the header, one for the rule under it, then the port rows.
  return head < 0 ? [] : out.slice(head + 2).filter(Boolean).map(function (l) { return l.split(/\s+/)[0]; });
}

function answer(t, sw) {
  const sim = new Simulator(t);
  sim.computeStp();
  sim.setRunTime(2000);
  const s = new CliSession(sw, t, sim);
  s.run('enable');
  return s;
}

console.log('A switch with twelve ports in the tree lists them 1, 2, 3, ... not 1, 10, 11, 12, 2, ...:');
{
  const want = [];
  for (let i = 1; i <= 12; i++) want.push('Gi1/0/' + i);
  const built = star(want);
  const got = rows(answer(built.topo, built.sw));
  ok(got.length === 12, 'all twelve ports are listed', String(got.length));
  ok(JSON.stringify(got) === JSON.stringify(want),
    'the rows run Gi1/0/1 .. Gi1/0/12 in order', got.join(' '));
  ok(got.indexOf('Gi1/0/10') === 9,
    'Gi1/0/10 sits between Gi1/0/9 and Gi1/0/11, as the Spiceworks transcript prints it',
    got.slice(7, 11).join(' '));
}

console.log('\nThe sparse shape a C9300 prints - 2, 6, 8, 10, 11 - in that order:');
{
  const built = star(['Gi1/0/2', 'Gi1/0/6', 'Gi1/0/8', 'Gi1/0/10', 'Gi1/0/11']);
  const got = rows(answer(built.topo, built.sw));
  ok(JSON.stringify(got) === JSON.stringify(['Gi1/0/2', 'Gi1/0/6', 'Gi1/0/8', 'Gi1/0/10', 'Gi1/0/11']),
    'the C9300 transcript order is reproduced', got.join(' '));
}

console.log('\nA bundle is one row, and this fix does not move it:');
{
  const t = new Topology();
  const a = t.addDevice(spec('C2960X-24TS-L'), 'sw1');
  const b = t.addDevice(spec('C2960X-24TS-L'), 'sw2');
  const c = t.addDevice(spec('generic-switch'), 'sw3');
  t.connect(a.id, 'Gi1/0/1', b.id, 'Gi1/0/1');
  t.connect(a.id, 'Gi1/0/2', b.id, 'Gi1/0/2');
  t.connect(a.id, 'Gi1/0/10', c.id, 'Fa0/1');
  for (const side of [a, b]) {
    const s = new CliSession(side, t, null);
    s.run('enable'); s.run('configure terminal');
    for (const p of ['Gi1/0/1', 'Gi1/0/2']) { s.run('interface ' + p); s.run('channel-group 1 mode on'); }
    s.run('end');
  }
  const got = rows(answer(t, a));
  ok(JSON.stringify(got) === JSON.stringify(['Gi1/0/10', 'Po1']),
    'the bundle is still printed as Po1 after the physical port, as before the fix', got.join(' '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
