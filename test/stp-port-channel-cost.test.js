'use strict';
// What a bundle of ports charges the spanning tree, and which part of that is a published number.
//
// Cisco says the cost of a port-channel comes from the port-channel's bandwidth, which is the sum of the
// *active* member interfaces' bandwidths - "the bandwidth of the Port-channel interface is automatically
// updated to the sum of bandwidths of the active member interfaces" (community.cisco.com/t5/switching/
// cost-stp-for-etherchannel/td-p/2401310), and the tree only reconverges when that bandwidth changes
// (Catalyst 3750 config guide, Configuring EtherChannels). A Catalyst 9600 running the long method prints
// `Po1 Desg FWD 10000` beside `Po2 Desg FWD 20000` on the same box, so two members cost half of one
// (cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol-stp-8021d/221588-change-of-
// etherchannel-member-interface.pdf).
//
// What no source states is the short-method arithmetic, which is the method this model runs (Cisco's default:
// `spanning-tree pathcost method` "Command Default: short"). The engine divides a member's cost by the member
// count, which agrees with the one measured pair and then falls to the table's floor of 1 at three members -
// a number no vendor table could print for a 3 Gb/s bundle. That arithmetic is therefore pinned here as this
// model's *inference*, not as vendor behaviour; research/port-channel-path-cost.md records what is known, what
// is inferred, and the one capture that would settle the rest.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

// Two switches, `members` live 1 Gb cables between them, all in channel-group 1. Returns the port-channel's
// entry in the elected tree as the near switch sees it.
function bundle(members, shutLast) {
  const t = new Topology();
  t.addDevice(SWITCH, 's1');
  t.addDevice(SWITCH, 's2');
  const cmds = ['configure terminal'];
  for (let i = 2; i < 2 + members; i++) {
    t.connect('s1', 'Fa0/' + i, 's2', 'Fa0/' + i);
    cmds.push('interface Fa0/' + i, 'channel-group 1 mode active');
  }
  if (shutLast) cmds.push('interface Fa0/' + (1 + members), 'shutdown');
  cmds.push('end');
  const sim = new Simulator(t);
  for (const id of ['s1', 's2']) runCommands(t.getDevice(id), t, sim, cmds);
  sim.computeStp();
  return sim.stpResult.ports.s1;
}

console.log('');
console.log('a bundle is one port in the tree, not one port per member:');
{
  const ports = bundle(2);
  ok(Object.keys(ports).length === 1, 'two 1 Gb members appear as a single port',
    Object.keys(ports).join(','));
  ok(ports['lag-1'] !== undefined, 'and it is the logical port (lag-1)', Object.keys(ports).join(','));
  ok(ports['lag-1'].cost !== undefined, 'the tree carries a cost for the bundle',
    JSON.stringify(ports['lag-1']));
}

console.log('\nthe short table\'s own row, before any bundling:');
{
  const ports = bundle(1);
  ok(ports['lag-1'].cost === 4, 'a single 1 Gb member costs 4 - the vendor\'s short row',
    String(ports['lag-1'] && ports['lag-1'].cost));
}

console.log('\nmore active members never cost more - the direction the vendor\'s rule gives:');
{
  const ones = bundle(1)['lag-1'].cost;
  const twos = bundle(2)['lag-1'].cost;
  const threes = bundle(3)['lag-1'].cost;
  const fours = bundle(4)['lag-1'].cost;
  ok(twos <= ones, 'two members cost no more than one (' + ones + ' -> ' + twos + ')');
  ok(threes <= twos, 'three cost no more than two (' + twos + ' -> ' + threes + ')');
  ok(fours <= threes, 'four cost no more than three (' + threes + ' -> ' + fours + ')');
  // The two numbers Cisco's own material pins in the long method: a member costs 20,000 and a two-member
  // bundle 10,000, i.e. the ratio halves. In the short method that is 4 -> 2, which is where this model
  // agrees with the one measured pair.
  ok(twos * 2 === ones, 'two members cost exactly half of one (' + ones + ' -> ' + twos + ')');
  // The floor: the short table stops at 1, so the division cannot fall below it however many members there
  // are. This is the number the note calls unsupported - it is recorded, not endorsed.
  ok(threes === 1 && fours === 1, 'three and four members both land on the table floor of 1',
    threes + '/' + fours);
}

console.log('\nonly the members whose own link is up are counted:');
{
  const two = bundle(2)['lag-1'].cost;
  const twoPlusShut = bundle(3, true)['lag-1'].cost;
  ok(twoPlusShut === two, 'three members with one shut cost what two live members cost (' +
    two + ' vs ' + twoPlusShut + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
