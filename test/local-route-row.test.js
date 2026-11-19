'use strict';
// A router's own interface address is a route in its table, and the box prints it (#fidelity: show ip route).
//
// Configuring `ip address 10.1.1.1 255.255.255.252` on Ethernet0/0 installs TWO rows on IOS - the connected
// subnet and the address itself as a /32 local host route, one line apart:
//
//   C        10.1.1.0/30 is directly connected, Ethernet0/0
//   L        10.1.1.1/32 is directly connected, Ethernet0/0
//
// Cisco's note on local host routes states the rule, prints that pair, and gives the one exception:
//
//   "For each IPv4 and IPv6 address, Cisco IOS installs host routes in the respective routing tables."
//   "The local routes have the administrative distance of 0. This is the same adminstrative distance as
//    connected routes. However, when you configure redistributed connected ... the connected routes are
//    redistributed, but the local routes are not."
//   "If an IPv4 address is configured with a mask of /32 on an interface of the router, which is typical for
//    loopback interfaces, the host route appears in the routing table only as connected (it has the C flag)."
//   https://www.cisco.com/c/en/us/support/docs/ip/ip-routing/116264-technote-ios-00.html  (IOS 15.0(1)S)
//
// A second vendor page prints the same pair in a different lab, on a different platform
// (https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/16448-default.html -
// `C 100.100.100.0/24 is directly connected, Serial1/0` over `L 100.100.100.2/32 is directly connected,
// Serial1/0`). research/local-route-in-show-ip-route.md records what is open (the IOS 12.x table, which has
// no local routes at all, and the classful heading lines this console still does not print).
//
// This console printed only the connected row, so the address a technician had just typed was missing from
// the table they were told to check it in.
const path = require('path');
const { Topology, Device } = require('../engine');
const { CliSession } = require('../engine/cli');
const net = require('../engine/net');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /2811/.test(s.model); })[0];
const SWITCH = catalog.filter(function (s) { return /Catalyst2960$/.test(s.model); })[0];

function ethernet(dev) {
  return [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
}

function show(dev) {
  const cli = new CliSession(dev, null, null);
  return cli.run('show ip route').output.map(String);
}

function rowsOf(dev) {
  return dev.routesTable().map(function (r) {
    return { code: r.displayCode, type: r.type, prefix: r.dest + '/' + net.prefixOf(r.mask), iface: r.iface,
      distance: r.distance, installed: r.installed };
  });
}

console.log('');
console.log('An addressed port contributes two rows, the subnet and the address:');
{
  const dev = new Device('r1', ROUTER);
  const port = ethernet(dev)[0];
  port.ip = '10.1.1.1'; port.mask = '255.255.255.252'; port.enabled = true;
  const rows = rowsOf(dev);
  ok(rows.length === 2, 'two rows for one addressed port', JSON.stringify(rows));
  ok(rows[0].prefix === '10.1.1.0/30' && rows[0].code === 'C' && rows[0].type === 'connected',
    'the first is the connected subnet, code C', JSON.stringify(rows[0]));
  ok(rows[1].prefix === '10.1.1.1/32' && rows[1].code === 'L' && rows[1].type === 'local',
    'the second is the address itself as a /32, code L', JSON.stringify(rows[1]));
  ok(rows[1].iface === port.name, 'and it names the port the address is on', rows[1].iface);
  ok(rows[0].distance === 0 && rows[1].distance === 0,
    'both are distance 0, as the vendor note says of the local route', rows.map(function (r) { return r.code + '=' + r.distance; }).join(' '));
  ok(rows[0].installed && rows[1].installed, 'both are installed: they are different prefixes',
    JSON.stringify(rows.map(function (r) { return r.prefix + ':' + r.installed; })));
  ok(!/\*/.test(rows[1].code), 'the local row is not a candidate default and carries no asterisk', rows[1].code);
}

console.log('');
console.log('The console prints the pair in the box\'s order and shape:');
{
  const dev = new Device('r1', ROUTER);
  const port = ethernet(dev)[0];
  port.ip = '10.1.1.1'; port.mask = '255.255.255.252'; port.enabled = true;
  const out = show(dev);
  ok(/^Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP$/.test(out[0]),
    'the legend leads with L - local, in the box\'s order (L, C, S, R, M, B)', out[0]);
  // The legend is the image's nine lines (research/show-ip-route-codes-legend.md), so the router sentence sits
  // under the block rather than on the line directly below its first line.
  ok(out[9] === 'Gateway of last resort is not set', 'the router sentence is under the block, unchanged', out[9]);
  const cLine = out.filter(function (l) { return /^C\s/.test(l); })[0] || '';
  const lLine = out.filter(function (l) { return /^L\s/.test(l); })[0] || '';
  // The port is named in the box's spelling for a sentence, not the panel's abbreviated cell: `show ip route`
  // prints `GigabitEthernet0`, and the row here used to say the same thing as a `show vlan` cell (`Gi0`)
  // (research/show-ip-route-interface-spelling.md).
  const longPort = require('../engine/iface-name').displayName(port.name);
  ok(cLine.indexOf('10.1.1.0/30') !== -1 && cLine.indexOf('is directly connected, ' + longPort) !== -1,
    'the connected row is the subnet, directly connected on the port', cLine);
  ok(/^L\s+10\.1\.1\.1\/32\s{2}is directly connected, \S+/.test(lLine),
    'the local row is the address, said the same way - no bracket, no next hop', lLine);
  ok(out.indexOf(cLine) === out.indexOf(lLine) - 1,
    'and it sits on the line directly under its subnet, as the box prints it', out.join(' | '));
}

console.log('');
console.log('The /32 case is one row, not two:');
{
  const dev = new Device('r1', ROUTER);
  const port = ethernet(dev)[0];
  // A loopback-style address: the vendor note says this appears "only as connected (it has the C flag)". The
  // console refuses to type a /32 onto an Ethernet port, so the address is set the way a device spec carries it.
  port.ip = '10.100.1.1'; port.mask = '255.255.255.255'; port.enabled = true;
  const rows = rowsOf(dev);
  ok(rows.length === 1, 'one row for a /32 address', JSON.stringify(rows));
  ok(rows[0].prefix === '10.100.1.1/32' && rows[0].code === 'C',
    'and it is the connected row, with no second L row for the same prefix', JSON.stringify(rows[0]));
  const out = show(dev);
  ok(!out.some(function (l) { return /^L\s/.test(l); }), 'the console prints no L row for it', out.join(' | '));
}

console.log('');
console.log('No address, no rows; a shut port, no rows:');
{
  const dev = new Device('r1', ROUTER);
  ok(rowsOf(dev).length === 0, 'an unaddressed router has no connected or local rows', JSON.stringify(rowsOf(dev)));
  const port = ethernet(dev)[0];
  port.ip = '10.1.1.1'; port.mask = '255.255.255.0'; port.enabled = false;
  ok(rowsOf(dev).length === 0, 'and a shut port withdraws both, as a box does when the line protocol drops',
    JSON.stringify(rowsOf(dev)));
}

console.log('');
console.log('The local row follows its port\'s fate, and the lookup is not confused by it:');
{
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const r2 = t.addDevice(ROUTER, 'r2');
  const p1 = ethernet(r1)[0], p2 = ethernet(r2)[0];
  p1.ip = '10.1.2.3'; p1.mask = '255.255.255.0'; p1.enabled = true;
  p2.ip = '10.1.2.1'; p2.mask = '255.255.255.0'; p2.enabled = true;
  t.connect(r1.id, p1.name, r2.id, p2.name);
  const rows = r1.routesTable(t);
  const local = rows.filter(function (r) { return r.type === 'local'; })[0];
  ok(!!local, 'the local row is in the table', JSON.stringify(rows.map(function (r) { return r.displayCode + ' ' + r.dest; })));
  ok(local && local.note === '' && local.unusable === false,
    'a cabled port leaves it healthy, with no fault note', JSON.stringify(local));
  // `routeTo()` is the forwarding lookup: a packet for the box itself never leaves, so the local row is a
  // receive entry and is not what routeTo() reports. The data plane answers a self-address ping elsewhere.
  const look = r1.routeTo('10.1.2.3');
  ok(look && look.type === 'connected',
    'routeTo() still describes the egress for the subnet; the local row is a receive entry, not a forwarding one',
    JSON.stringify(look));
  [...t.links.values()][0].state = 'down';
  const dead = r1.routesTable(t).filter(function (r) { return r.type === 'local'; })[0];
  ok(dead && dead.unusable === true && /down/.test(dead.note),
    'and a pulled cable marks it unusable, in the same words as the connected row', JSON.stringify(dead));
}

console.log('');
console.log('A box that does not route is untouched by any of this:');
{
  const dev = new Device('sw1', SWITCH);
  const out = show(dev);
  ok(out[0] === 'Default gateway is not set', 'the switch still answers with its gateway sentence', out[0]);
  ok(!out.some(function (l) { return /^(Codes:|L\s)/.test(l); }),
    'no legend and no local row: a non-routing box has no table for either', out.join(' | '));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
