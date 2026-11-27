'use strict';
// A static route whose next hop is one of the router's own addresses.
//
// A next hop has to be the far end of a wire. An address this box already holds is not one, and IOS
// refuses the line at config time rather than installing a route that points back at the router that
// typed it. Four console logs show the sentence, and all four print it with no space after the `%`,
// no address echoed, and no trailing full stop:
//
//   Router(config)#ip route 192.168.100.0 255.255.255.0 40.0.0.1
//   %Invalid next hop address (it's this router)
//     https://learningnetwork.cisco.com/s/question/0D53i00000KszOlCAJ/inconsistent-address-mask
//
//   (config)#ip route 1.1.1.1 255.255.255.255 93.93.13.1
//   %Invalid next hop address (it's this router)
//     https://community.cisco.com/t5/routers-small-business/ip-address-of-gateway-appears-in-arp-table/td-p/3093233
//
//   R1(config)#ip route 0.0.0.0 0.0.0.0 192.168.1.121
//   %Invalid next hop address (it's this router)
//     https://www.reddit.com/r/ccna/comments/uk9kk6/trying_to_remove_static_route_but_im_getting_no/
//
// One teaching page prints the same words with a space (`% Invalid next hop address (it's this
// router)`), which is the only dissent in hand:
//   https://www.connecteddots.online/resources/cisco/invalid-next-hop-address-its-this-router
//
// What remains unresolved - whether a later `ip address` on a port re-checks an already-installed
// route that pointed at it, and what a box says for a multicast or broadcast next hop - is in
// research/static-route-own-next-hop.md.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(model) { return catalog.find(function (x) { return x.model === model; }); }

function cli(t, dev, cmds) {
  return runCommands(dev, t, null, ['enable', 'configure terminal'].concat(cmds)).lines || [];
}
function show(t, dev, cmd) {
  const s = new Simulator(t);
  s.setRunTime(60000);
  return runCommands(dev, t, s, ['enable', cmd]).lines.join('\n');
}
// The console echoes the prompt and the typed line alongside the answer; this is the answer.
function refusal(out) {
  return (out || []).filter(function (l) { return l.charAt(0) === '%'; });
}
function routeLines(t, dev) {
  const s = new Simulator(t);
  s.setRunTime(60000);
  return runCommands(dev, t, s, ['enable', 'show running-config']).lines
    .filter(function (l) { return l.indexOf('ip route ') === 0; });
}

// One router, one addressed port at 10.0.0.1/24, up.
function router() {
  const t = new Topology();
  const r1 = t.addDevice(spec('ISR 4331'), 'r1');
  const port = Array.from(r1.interfaces.keys())[0];
  cli(t, r1, ['interface ' + port, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit']);
  return { t: t, r1: r1, port: port };
}

console.log('\nA next hop on this router is refused, in the vendor\'s words:');
{
  const lab = router();
  const out = cli(lab.t, lab.r1, ['ip route 0.0.0.0 0.0.0.0 10.0.0.1']);
  ok(refusal(out).length === 1 && refusal(out)[0] === "%Invalid next hop address (it's this router)",
    'the sentence is the box\'s own: no space after `%`, no address echoed, no full stop', JSON.stringify(out));
  ok((lab.r1.config.routes || []).length === 0,
    'nothing is stored', JSON.stringify(lab.r1.config.routes));
  const table = show(lab.t, lab.r1, 'show ip route');
  ok(table.indexOf('Gateway of last resort is not set') !== -1 &&
    !/^S\*?\s+0\.0\.0\.0\/0/m.test(table),
    'the table has no default route and no gateway of last resort', table);
  ok(routeLines(lab.t, lab.r1).length === 0,
    'the saved file never carries the refused line', JSON.stringify(routeLines(lab.t, lab.r1)));
}

console.log('\nThe distance and the fully specified order are refused the same way:');
{
  const lab = router();
  const dist = cli(lab.t, lab.r1, ['ip route 10.9.0.0 255.255.0.0 10.0.0.1 200']);
  ok(refusal(dist).length === 1 && refusal(dist)[0] === "%Invalid next hop address (it's this router)",
    'a line that also sets a distance is refused', JSON.stringify(dist));

  const full = cli(lab.t, lab.r1, ['ip route 10.9.0.0 255.255.0.0 ' + lab.port + ' 10.0.0.1']);
  ok(refusal(full).length === 1 && refusal(full)[0] === "%Invalid next hop address (it's this router)",
    'the vendor\'s interface-then-next-hop order is refused', JSON.stringify(full));

  ok((lab.r1.config.routes || []).length === 0,
    'neither form installed a route', JSON.stringify(lab.r1.config.routes));
}

console.log('\nA neighbour on the same wire is still a next hop:');
{
  const lab = router();
  const out = cli(lab.t, lab.r1, ['ip route 0.0.0.0 0.0.0.0 10.0.0.254']);
  ok(out.join('\n').indexOf('Route added: 0.0.0.0/0 via 10.0.0.254') !== -1,
    'the far end of the segment is accepted', out.join(' | '));
  ok((lab.r1.config.routes || []).length === 1,
    'and stored', JSON.stringify(lab.r1.config.routes));

  // A refusal after a good route leaves the good route alone.
  const refused = cli(lab.t, lab.r1, ['ip route 10.7.0.0 255.255.0.0 10.0.0.1']);
  ok(refusal(refused)[0] === "%Invalid next hop address (it's this router)",
    'a later line naming this router is still refused', JSON.stringify(refused));
  const rows = (lab.r1.config.routes || []);
  ok(rows.length === 1 && rows[0].dest === '0.0.0.0',
    'the earlier route survives the refusal', JSON.stringify(rows));

  const gone = cli(lab.t, lab.r1, ['no ip route 0.0.0.0 0.0.0.0 10.0.0.254']);
  ok(gone.indexOf('Route removed') !== -1 && (lab.r1.config.routes || []).length === 0,
    'and the removal form still removes it', JSON.stringify(gone));
}

console.log('\nThe address belongs to the box, not to the port being up:');
{
  const lab = router();
  cli(lab.t, lab.r1, ['interface ' + lab.port, 'shutdown', 'exit']);
  const out = cli(lab.t, lab.r1, ['ip route 0.0.0.0 0.0.0.0 10.0.0.1']);
  ok(refusal(out)[0] === "%Invalid next hop address (it's this router)",
    'a shut port\'s address is still this router (inferred, and pinned)', JSON.stringify(out));
}

console.log('\nA subinterface address is this router too:');
{
  const lab = router();
  cli(lab.t, lab.r1, ['interface ' + lab.port + '.10', 'encapsulation dot1q 10',
    'ip address 10.10.10.1 255.255.255.0', 'exit']);
  const out = cli(lab.t, lab.r1, ['ip route 10.20.0.0 255.255.0.0 10.10.10.1']);
  ok(refusal(out)[0] === "%Invalid next hop address (it's this router)",
    'a next hop on the tagged subinterface is refused', JSON.stringify(out));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
