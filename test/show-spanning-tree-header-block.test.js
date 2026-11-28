'use strict';
// The block above `show spanning-tree`'s port table, transcribed from a machine-recorded Catalyst session.
//
// Every capture of the view opens the same way - a `VLAN0001` heading, `  Spanning tree enabled protocol ieee`
// two spaces under it, the Root ID block, a blank line, the Bridge ID block, a blank line, then the table
// (ntc-templates, tests/cisco_ios/show_spanning-tree/cisco_ios_show_spanning_tree.raw - a recorded session, so
// the spacing survived; Cisco doc 221191 and the 6500 12.1E command reference print the same fields; the
// captures are in `research/show-spanning-tree-header-block.md`).
//
// This console printed one invented sentence instead -
//
//   Bridge priority 32768 (this bridge is the root), root bridge sw1 priority 32768
//
// - naming the root by a label no box prints and carrying no address, no cost, no timers and no ageing. The
// block below is pinned line for line, at its columns, with the values read from the election: the priority is
// the extended one (base + VLAN 1 sys-id-ext) with the base repeated in brackets, the addresses are bridge MACs
// in dotted form, a non-root prints the cost Dijkstra charged and the port it pays over, and the timers and the
// ageing come from the modules that already own those numbers.
const path = require('path');
const { CliSession } = require('../engine/cli');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const { loadCatalog } = require('../devices/registry');
const netLib = require('../engine/net');
const devLib = require('../engine/device');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const pick = function (re) { return catalog.filter(function (s) { return re.test(s.model); })[0]; };
const SWITCH = pick(/CX 6000 24G CL4/);
const ROUTER = pick(/^ISR 4331$/);

// Two switches, one cable, and every port given an explicit MAC so the election has one fixed answer: s1's
// 02:...:01 is lower than s2's 02:...:02, so s1 is the root and s2 is the neighbour paying a cost.
const MAC = { s1: '02:00:00:00:00:01', s2: '02:00:00:00:00:02' };
function pair() {
  const t = new Topology();
  t.addDevice(SWITCH, 's1'); t.addDevice(SWITCH, 's2');
  t.connect('s1', '1/1/1', 's2', '1/1/1', { mediaId: '1000base-t', speedMbps: 1000 });
  for (const id of Object.keys(MAC)) {
    for (const iface of t.getDevice(id).interfaces.values()) iface.mac = MAC[id];
  }
  const sim = new Simulator(t);
  sim.setRunTime(60000);
  sim.recomputeStp();
  return { t: t, sim: sim };
}
function view(env, id) {
  const cli = new CliSession(env.t.getDevice(id), env.t, env.sim);
  cli.run('enable');
  return cli.run('show spanning-tree').output || [];
}
const dotted = function (mac) { return netLib.formatMac(mac); };

console.log('');
console.log('The heading and the protocol line, in the columns a Catalyst uses:');
{
  const env = pair();
  const out = view(env, 's1');
  ok(out[0] === '', 'the answer opens with the blank line the capture has', JSON.stringify(out[0]));
  ok(out[1] === 'VLAN0001', 'the block is headed by the VLAN whose tree it is', JSON.stringify(out[1]));
  ok(out[2] === '  Spanning tree enabled protocol ieee', 'and the protocol line is two spaces under it',
    JSON.stringify(out[2]));
}

console.log('');
console.log('The Root ID block names the root by its extended bridge ID and its bridge MAC:');
{
  const env = pair();
  const out = view(env, 's1');
  ok(out[3] === '  Root ID    Priority    32769', 'Priority is the extended bridge ID: 32768 + sys-id-ext 1',
    JSON.stringify(out[3]));
  ok(out[4] === '             Address     ' + dotted(MAC.s1), 'Address is the root bridge MAC, in dotted form',
    JSON.stringify(out[4]));
  ok(out[5] === '             This bridge is the root', 'and the root says so instead of naming a cost',
    JSON.stringify(out[5]));
  ok(out[6] === '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec',
    'the 802.1D timers close the block, at the capture spacing', JSON.stringify(out[6]));
  ok(out[7] === '', 'a blank line separates it from the Bridge ID block', JSON.stringify(out[7]));
}

console.log('');
console.log('The Bridge ID block is this box, with the base priority repeated in brackets:');
{
  const env = pair();
  const out = view(env, 's1');
  ok(out[8] === '  Bridge ID  Priority    32769  (priority 32768 sys-id-ext 1)',
    'the extended ID, then the base and the VLAN extension a box explains it with', JSON.stringify(out[8]));
  ok(out[9] === '             Address     ' + dotted(MAC.s1), 'and its own bridge MAC, not the root object',
    JSON.stringify(out[9]));
  ok(out[10] === '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec',
    'the same timers, printed again in this block', JSON.stringify(out[10]));
  ok(out[11] === '             Aging Time  ' + Math.round(devLib.MAC_AGE_MS / 1000) + ' sec',
    'and the forwarding-database ageing, with the unit the capture carries', JSON.stringify(out[11]));
  ok(out[12] === '', 'then a blank line, and the table follows', JSON.stringify(out[12]));
}

console.log('');
console.log('A non-root pays a cost over a port, and names the root by the address the root prints:');
{
  const env = pair();
  const out = view(env, 's2');
  const rootAddress = env.t.getDevice('s1').stp.bridgeMac;
  ok(out[3] === '  Root ID    Priority    32769', 'the root ID is the winner, not this box', JSON.stringify(out[3]));
  ok(out[4] === '             Address     ' + dotted(rootAddress),
    'by the very MAC the root prints in its own Bridge ID', JSON.stringify(out[4]));
  const cost = env.t.getDevice('s2').stp.rootCost;
  ok(cost === 4, 'the election charged this bridge the short-method cost of a 1 Gb port', String(cost));
  ok(out[5] === '             Cost        ' + cost, 'and the block prints that number, not a re-derivation',
    JSON.stringify(out[5]));
  ok(out[6] === '             Port        1 (1/1/1)',
    'over the root port, numbered by its place in the port table, as a box prints it', JSON.stringify(out[6]));
  ok(out[7] === '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec',
    'the timers close this block too', JSON.stringify(out[7]));
  ok(out[9] === '  Bridge ID  Priority    32769  (priority 32768 sys-id-ext 1)',
    'while its own Bridge ID keeps the same extended priority', JSON.stringify(out[9]));
  ok(out[10] === '             Address     ' + dotted(MAC.s2), 'and its own address, different from the root',
    JSON.stringify(out[10]));
}

console.log('');
console.log('The table below it is unchanged, and still follows the blank line:');
{
  const env = pair();
  const out = view(env, 's1');
  ok(out[13] === 'Interface           Role Sts Cost      Prio.Nbr Type',
    'the captured header, where it has always been', JSON.stringify(out[13]));
  ok(out[15] === '1/1/1               Desg FWD 4         128.1    P2p',
    'with the port rows under it, in the table cells they have always had', out[15]);
}

console.log('');
console.log('A base priority of 0 is printed the way a box prints it, extended to 1:');
{
  const env = pair();
  env.t.getDevice('s1').config.stpPriority = 0;
  env.sim.recomputeStp();
  const out = view(env, 's1');
  ok(out[3] === '  Root ID    Priority    1', 'the Root ID carries 0 + sys-id-ext 1', JSON.stringify(out[3]));
  ok(out[8] === '  Bridge ID  Priority    1  (priority 0 sys-id-ext 1)',
    'and the Bridge ID explains it as a base of 0 plus the extension', JSON.stringify(out[8]));
}

console.log('');
console.log('Nothing else in the view moved:');
{
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  const sim = new Simulator(t);
  sim.setRunTime(0);
  const cli = new CliSession(t.getDevice('r1'), t, sim);
  cli.run('enable');
  const out = cli.run('show spanning-tree').output || [];
  ok(out.length === 1 && out[0] === 'No spanning tree instance exists.',
    'a router still answers with the box sentence and nothing else', JSON.stringify(out));

  // No simulator: the block would have to invent a root, so the honest sentence stays.
  const t2 = new Topology();
  t2.addDevice(SWITCH, 's9');
  const bare = new CliSession(t2.getDevice('s9'), t2, null);
  bare.run('enable');
  const unmeasured = bare.run('show spanning-tree').output || [];
  ok(unmeasured.indexOf('VLAN0001') !== -1, 'a switch with nothing measured still prints the heading', unmeasured[1]);
  ok(unmeasured.some(function (l) { return /root bridge not measured/.test(l); }),
    'and says the root is not measured rather than naming one', unmeasured.join(' / '));
  ok(!unmeasured.some(function (l) { return /undefined|NaN/.test(l); }), 'with no hole rendered anywhere',
    unmeasured.join(' / '));
}

console.log('');
console.log('The cost the block prints is the one the election computed, and a bridge with no path has none:');
{
  const res = require('../engine/stp').runStp({
    bridges: [
      { key: 'a', priority: 32768, mac: '02:00:00:00:00:01', ports: [{ name: 'p1', cost: 4, to: { bridge: 'b', port: 'p1' } }] },
      { key: 'b', priority: 32768, mac: '02:00:00:00:00:02', ports: [{ name: 'p1', cost: 4, to: { bridge: 'a', port: 'p1' } }] },
      { key: 'c', priority: 32768, mac: '02:00:00:00:00:03', ports: [] }
    ]
  });
  ok(res.costs && res.costs.a === 0, 'the root costs nothing to reach', JSON.stringify(res.costs));
  ok(res.costs && res.costs.b === 4, 'its neighbour costs the port it pays through', String(res.costs && res.costs.b));
  ok(res.costs && res.costs.c === null, 'and a bridge with no cable has null, not 0', String(res.costs && res.costs.c));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
