'use strict';
// A point-to-point OSPF link does not compare masks.
//
// RFC 2328 10.5 states the Hello check and then carves out the one exception:
//
//   "Next, the values of the Network Mask, HelloInterval, and RouterDeadInterval fields in the received
//    Hello packet must be checked against the values configured for the receiving interface. Any mismatch
//    causes processing to stop and the packet to be dropped. ... However, there is one exception to the
//    above rule: on point-to-point networks and on virtual links, the Network Mask in the received Hello
//    Packet should be ignored."
//   https://www.rfc-editor.org/rfc/rfc2328.html#section-10.5
//
// A Cisco box follows it: two IOS routers with /24 on one end of a serial link and /30 on the other form a
// FULL adjacency, documented with the capture in
//   https://blog.ipspace.net/2008/10/ospf-ignores-subnet-mask-mismatch-on.html
// and stated for the asymmetric case by
//   https://community.cisco.com/t5/routing/ospf-point-to-point-links/m-p/1913398
// ("On point-to-point links, OSPF will ignore the subnet mask mismatch. However, the neighbors still have
// to be on a common subnet, i.e. from the viewpoint of one router, the second router's IP address must
// fall within the interface network of the first router.").
//
// This model compared the two masks on every link, so a serial pair with a mask typo formed no adjacency
// and, worse, said so in the wrong words: with no record of the refusal, `show ip ospf neighbor` blamed the
// far end for not running OSPF. A broadcast segment keeps the check - there the Hello's mask is the field
// that decides - and now records the reason too (research/ospf-p2p-mask-ignore.md).
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = require('path').join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /^ISR 4331$/.test(s.model); });
const SERIAL = specs.find(function (s) { return /^2811$/.test(s.model); });

function sess(t, id, sim) { return new CliSession(t.getDevice(id), t, sim || null); }
function configure(t, id, cmds) {
  const s = sess(t, id);
  ['enable', 'configure terminal'].concat(cmds).forEach(function (c) { s.run(c); });
}
function show(t, sim, id, cmd) { return ((sess(t, id, sim).run(cmd) || {}).output || []).join('\n'); }
function recompute(t) { const sim = new Simulator(t); sim.computeOspf(); return sim; }
function row(text, who) {
  return text.split('\n').filter(function (l) { return l.trim().indexOf(who + ' ') === 0; })[0] || '';
}

// Two 2811s on one V.35 cable, masks given by the caller.
function serialLab(maskA, maskB) {
  const t = new Topology();
  t.addDevice(SERIAL, 'a1');
  t.addDevice(SERIAL, 'a2');
  configure(t, 'a1', ['interface Se0/0/0', 'ip address 10.9.0.1 ' + maskA, 'clock rate 64000',
    'ospf router-id 1.1.1.1', 'end']);
  configure(t, 'a2', ['interface Se0/0/0', 'ip address 10.9.0.2 ' + maskB,
    'ospf router-id 2.2.2.2', 'end']);
  t.connect('a1', 'Se0/0/0', 'a2', 'Se0/0/0', { mediaId: 'serial-v35' });
  return { t: t, sim: recompute(t) };
}

console.log('A /24 against a /30 on a serial link is an adjacency, because the Hello mask is ignored there');
{
  const env = serialLab('255.255.255.0', '255.255.255.252');
  const t = env.t, sim = env.sim;
  const a1 = show(t, sim, 'a1', 'show ip ospf neighbor');
  const a2 = show(t, sim, 'a2', 'show ip ospf neighbor');
  ok(t.getDevice('a1').ospfNeighbors.length === 1, 'a1 has one neighbour', String(t.getDevice('a1').ospfNeighbors.length));
  ok(t.getDevice('a2').ospfNeighbors.length === 1, 'a2 has one neighbour');
  ok(/\sFULL\s*\/\s*-/.test(row(a1, '2.2.2.2')), 'a1 reports FULL/ - (point-to-point elects no DR)', row(a1, '2.2.2.2'));
  ok(/\sFULL\s*\/\s*-/.test(row(a2, '1.1.1.1')), 'a2 reports FULL/ - as well', row(a2, '1.1.1.1'));
  ok(/\s10\.9\.0\.2\s+Serial0\/0\/0/.test(row(a1, '2.2.2.2')),
    'the Address column is the far address and the Interface column the whole port name', row(a1, '2.2.2.2'));
  ok((t.getDevice('a1').ospfRejected || []).length === 0, 'nothing was refused on a1');
  ok((t.getDevice('a2').ospfRejected || []).length === 0, 'nothing was refused on a2');
  const r1 = show(t, sim, 'a1', 'show ip route');
  const r2 = show(t, sim, 'a2', 'show ip route');
  ok(/^O\s+10\.9\.0\.0\/30\s+\[110\/\d+\] via 10\.9\.0\.2, Serial0\/0\/0$/m.test(r1),
    'a1 installs the far end network with the far address as next hop', r1.split('\n').pop());
  ok(/^O\s+10\.9\.0\.0\/24\s+\[110\/\d+\] via 10\.9\.0\.1, Serial0\/0\/0$/m.test(r2),
    'a2 installs the near end network with the near address as next hop', r2.split('\n').pop());
  const ping = show(t, sim, 'a1', 'ping 10.9.0.2');
  ok(/Success rate is 100 percent \(5\/5\)/.test(ping), 'and traffic crosses the mismatched link', ping.split('\n').join(' | '));
}

console.log('');
console.log('The mask is what is ignored - the peer still has to be reachable through this port');
{
  const t = new Topology();
  t.addDevice(SERIAL, 'b1');
  t.addDevice(SERIAL, 'b2');
  configure(t, 'b1', ['interface Se0/0/0', 'ip address 10.9.0.1 255.255.255.252', 'clock rate 64000',
    'ospf router-id 1.1.1.1', 'end']);
  configure(t, 'b2', ['interface Se0/0/0', 'ip address 10.9.0.9 255.255.255.0',
    'ospf router-id 2.2.2.2', 'end']);
  t.connect('b1', 'Se0/0/0', 'b2', 'Se0/0/0', { mediaId: 'serial-v35' });
  const sim = recompute(t);
  ok(t.getDevice('b1').ospfNeighbors.length === 0, 'a peer outside this port network forms no neighbour');
  const rejected = t.getDevice('b1').ospfRejected || [];
  ok(rejected.length === 1 && rejected[0].reason === 'subnet', 'the refusal is recorded as a subnet mismatch',
    JSON.stringify(rejected));
  ok(rejected[0].ownIp === '10.9.0.1' && rejected[0].ownMask === '255.255.255.252',
    'the record keeps this end address and mask', JSON.stringify(rejected[0]));
  ok(rejected[0].peerIp === '10.9.0.9' && rejected[0].peerMask === '255.255.255.0',
    'and the far end, so the two can be printed side by side', JSON.stringify(rejected[0]));
  const mirror = (t.getDevice('b2').ospfRejected || [])[0] || {};
  ok(mirror.reason === 'subnet' && mirror.ownIp === '10.9.0.9' && mirror.peerIp === '10.9.0.1',
    'the far end keeps the mirrored record', JSON.stringify(mirror));
  const said = show(t, sim, 'b1', 'show ip ospf neighbor');
  ok(/no adjacencies: 1 link\(s\) were offered and refused/.test(said), 'the console counts the refused link', said);
  ok(/10\.9\.0\.9\/24 and this port as 10\.9\.0\.1\/30/.test(said),
    'and names both addresses and masks rather than blaming the far end', said);
  ok(/point-to-point link/.test(said) && /RFC 2328/.test(said), 'naming the rule that is being applied', said);
}

console.log('');
console.log('A broadcast segment keeps the check, and now says which field disagreed');
{
  const t = new Topology();
  t.addDevice(ROUTER, 'c1');
  t.addDevice(ROUTER, 'c2');
  configure(t, 'c1', ['interface Gi0/0/0', 'ip address 10.5.0.1 255.255.255.0', 'ospf router-id 1.1.1.1', 'end']);
  configure(t, 'c2', ['interface Gi0/0/0', 'ip address 10.5.0.2 255.255.255.128', 'ospf router-id 2.2.2.2', 'end']);
  t.connect('c1', 'Gi0/0/0', 'c2', 'Gi0/0/0', { mediaId: '1000base-t', speedMbps: 1000 });
  const sim = recompute(t);
  ok(t.getDevice('c1').ospfNeighbors.length === 0, 'a mask mismatch on Ethernet still stops the adjacency');
  const rejected = (t.getDevice('c1').ospfRejected || [])[0] || {};
  ok(rejected.reason === 'mask', 'recorded as a mask mismatch', JSON.stringify(rejected));
  ok(rejected.ownMask === '255.255.255.0' && rejected.peerMask === '255.255.255.128',
    'with both masks kept for the sentence', JSON.stringify(rejected));
  const said = show(t, sim, 'c1', 'show ip ospf neighbor Gi0/0/0');
  ok(/c2 runs OSPF with \/25 on its end of this link and this box with \/24/.test(said),
    'the refusal names both prefixes', said);
  ok(/RFC 2328 10\.5/.test(said), 'and the rule that drops the Hello', said);
  ok(!/nothing on the other end runs OSPF/.test(said),
    'it no longer claims the far end is not running OSPF', said);
}

console.log('');
console.log('The rule that was already right is still right');
{
  const env = serialLab('255.255.255.0', '255.255.255.0');
  const said = show(env.t, env.sim, 'a1', 'show ip ospf neighbor');
  ok(env.t.getDevice('a1').ospfNeighbors.length === 1, 'equal masks on a serial link still form a neighbour');
  ok(/\sFULL\s*\/\s*-/.test(row(said, '2.2.2.2')), 'and still report FULL/ -', row(said, '2.2.2.2'));

  const t = new Topology();
  t.addDevice(ROUTER, 'd1');
  t.addDevice(ROUTER, 'd2');
  configure(t, 'd1', ['interface Gi0/0/0', 'ip address 10.6.0.1 255.255.255.0', 'ospf router-id 1.1.1.1', 'end']);
  configure(t, 'd2', ['interface Gi0/0/0', 'ip address 10.6.0.2 255.255.255.0', 'ospf router-id 2.2.2.2', 'end']);
  t.connect('d1', 'Gi0/0/0', 'd2', 'Gi0/0/0', { mediaId: '1000base-t', speedMbps: 1000 });
  recompute(t);
  ok((t.getDevice('d1').ospfNeighbors || []).length === 1, 'equal masks on Ethernet form a neighbour');
  ok((t.getDevice('d1').ospfRejected || []).length === 0, 'with nothing recorded as refused');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
