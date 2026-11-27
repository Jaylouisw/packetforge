'use strict';
// `show ip route <protocol>`: the argument is a protocol word, and the table it prints is the same table narrowed.
//
// The command's own field list says so - "The name of a routing protocol or the keyword connected, mobile,
// static, or summary. If you specify a routing protocol, use one of the following keywords: bgp, eigrp, hello,
// isis, odr, ospf, nhrp, or rip." (Cisco IOS IP Routing: Protocol-Independent Command Reference, `show ip route`,
// https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/iri-cr-book/iri-cr-s1.html) - and the
// captures print the whole nine-line codes legend, the gateway-of-last-resort line, and only the rows of that
// source:
//
//   R1# show ip route static
//   Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP
//   ...
//   Gateway of last resort is 10.1.12.2 to network 0.0.0.0
//   S* 0.0.0.0/0 [1/0] via 10.1.12.2
//   10.0.0.0/8 is variably subnetted, 5 subnets, 3 masks
//   S 10.2.2.0/24 [1/0] via 10.1.12.2
//     https://learnccna.org/domain/3/3-3/
//
// This console answered every protocol word with "does not take": the whole table is printed, read the row for
// the prefix. That is the right answer for a *prefix* (#1403) and the wrong one for a protocol word, which a box
// can always answer - even when the answer is "none of those rows exist".
//
// The one non-obvious rule: `connected` keeps the L rows as well as the C ones. A local host route is a subtype
// of the connected route (Cisco doc 116264, "Local Host Routes Installed in the Routing Table on Cisco IOS and
// Cisco IOS-XR" - "The local route is a subtype of the connected route"), and the capture in Cisco's EIGRP
// path-selection note prints them together under `show ip route connected`:
//
//   show ip route connected
//   C 10.10.10.0/24 is directly connected, Loopback10
//   L 10.10.10.10/32 is directly connected, Loopback10
//     https://www.cisco.com/c/en/us/support/docs/ip/enhanced-interior-gateway-routing-protocol-eigrp/221548-configure-eigrp-to-influence-path-selection.pdf
//
// A `show ip route connected` that kept only C would answer "this box is on no address of its own", which is the
// one thing the view exists to disprove.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

// r1 -- r2 on 10.0.12.0/24, a LAN on each, one static and one static default on r1.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const r2 = t.addDevice(ROUTER, 'r2');
  t.connect('r1', 'Gi0/0/0', 'r2', 'Gi0/0/0');
  const sim = new Simulator(t);
  const cfg = function (dev, lines) {
    runCommands(dev, t, sim, ['configure terminal'].concat(lines));
  };
  cfg(r1, ['ospf router-id 1.1.1.1',
    'interface Gi0/0/0', 'ip address 10.0.12.1 255.255.255.0', 'exit',
    'interface Gi0/0/1', 'ip address 192.168.1.1 255.255.255.0', 'exit',
    'ip route 172.16.0.0 255.255.0.0 10.0.12.2',
    'ip route 0.0.0.0 0.0.0.0 10.0.12.2']);
  cfg(r2, ['ospf router-id 2.2.2.2',
    'interface Gi0/0/0', 'ip address 10.0.12.2 255.255.255.0', 'exit',
    'interface Gi0/0/1', 'ip address 192.168.3.1 255.255.255.0', 'exit']);
  sim.computeOspf();
  return { t: t, sim: sim, r1: r1, r2: r2 };
}

const L = lab();
const session = new CliSession(L.r1, L.t, L.sim);
const show = function (cmd) { return session.run(cmd).output; };

// The rows of a routing-table view: everything after the gateway-of-last-resort line that is not indented and
// does not open with `%`.
function rowsOf(out) {
  const at = out.findIndex(function (l) { return (/^Gateway of last resort is/).test(l); });
  if (at === -1) return [];
  return out.slice(at + 1).filter(function (l) {
    return l.trim() && !(/^\s/).test(l) && l.charAt(0) !== '%';
  });
}
const codesOf = function (rows) {
  return rows.map(function (l) { return l.split(/\s+/)[0].replace(/\*$/, ''); });
};
const legendOf = function (out) {
  return out.filter(function (l) { return (/^(Codes:|\s+[A-Za-z+%] )/).test(l); });
};
const gatewayOf = function (out) {
  return out.filter(function (l) { return (/^Gateway of last resort is/).test(l); })[0];
};

const full = show('show ip route');
const fullRows = rowsOf(full);

// ---- the whole table is unchanged, and it holds every kind of row ----
ok(fullRows.length >= 7, 'the bare view still prints every row', String(fullRows.length));
ok(codesOf(fullRows).indexOf('S') !== -1, 'a static row is in the whole table');
ok(codesOf(fullRows).indexOf('O') !== -1, 'an OSPF row is in the whole table');
ok(codesOf(fullRows).indexOf('C') !== -1 && codesOf(fullRows).indexOf('L') !== -1,
  'and the connected and local rows are in it');

// ---- static ----
const stat = show('show ip route static');
const statRows = rowsOf(stat);
ok(statRows.length === 2, '`show ip route static` prints the two static rows and nothing else',
  JSON.stringify(statRows));
ok(codesOf(statRows).every(function (c) { return c === 'S'; }), 'every row it prints carries S',
  JSON.stringify(codesOf(statRows)));
ok(statRows.some(function (l) { return (/^S\*\s+0\.0\.0\.0\/0 /).test(l); }),
  'the candidate default keeps its S* code in the narrowed table', JSON.stringify(statRows));
ok(!statRows.some(function (l) { return (/^C\s/).test(l) || (/^L\s/).test(l) || (/^O\s/).test(l); }),
  'and no connected, local or OSPF row comes with them');

// ---- connected: both C and L ----
const conn = show('show ip route connected');
const connRows = rowsOf(conn);
const connCodes = codesOf(connRows);
ok(connCodes.length === 4, '`show ip route connected` prints four rows (two C, two L)',
  JSON.stringify(connRows));
ok(connCodes.filter(function (c) { return c === 'C'; }).length === 2, 'two of them are C');
ok(connCodes.filter(function (c) { return c === 'L'; }).length === 2,
  'and two are L - a local host route is a subtype of the connected route', JSON.stringify(connRows));
ok(connRows.some(function (l) { return (/^L\s+10\.0\.12\.1\/32 is directly connected/).test(l); }),
  'the box prints its own address as a local row under `connected`', JSON.stringify(connRows));

// ---- ospf ----
const ospf = show('show ip route ospf');
const ospfRows = rowsOf(ospf);
ok(ospfRows.length >= 1 && codesOf(ospfRows).every(function (c) { return c === 'O'; }),
  '`show ip route ospf` prints only O rows', JSON.stringify(ospfRows));
ok(ospfRows.some(function (l) { return (/^O\s+192\.168\.3\.0\/24 /).test(l); }),
  'including the far LAN it learned', JSON.stringify(ospfRows));

// ---- bgp: a protocol with no rows is still an answer ----
const bgp = show('show ip route bgp');
ok(rowsOf(bgp).length === 0, '`show ip route bgp` prints no rows on a box running no BGP');
ok(legendOf(bgp).join('\n') === legendOf(full).join('\n'),
  'and the nine-line codes legend is still there, byte for byte');
ok(bgp.some(function (l) { return (/^Gateway of last resort is/).test(l); }), 'with the gateway line under it');

// ---- the legend and the gateway line are the table's, not the filter's ----
ok(stat.slice(0, 9).join('\n') === full.slice(0, 9).join('\n'),
  'the legend of a narrowed view is the legend of the whole one');
ok(gatewayOf(stat) === gatewayOf(full),
  'the gateway line names the same default as the whole table', gatewayOf(stat) + ' / ' + gatewayOf(full));
ok(gatewayOf(ospf) === gatewayOf(full),
  'including on a view whose own source holds no default at all');

// ---- nothing is lost or duplicated: the four filters partition the table ----
const union = statRows.length + connRows.length + ospfRows.length + rowsOf(bgp).length;
ok(union === fullRows.length,
  'static + connected + ospf + bgp add up to the whole table, so no row is dropped or printed twice',
  union + ' vs ' + fullRows.length);

// ---- order is the table's own ----
const orderOf = function (rows) { return rows.map(function (l) { return fullRows.indexOf(l); }); };
const connOrder = orderOf(connRows);
const ascending = connOrder.slice().sort(function (a, b) { return a - b; });
ok(connOrder.indexOf(-1) === -1 && connOrder.join(',') === ascending.join(','),
  'the narrowed rows keep the table\'s order', JSON.stringify(connOrder));

// ---- abbreviations and case reach the same word ----
ok(show('show ip route c').join('\n') === conn.join('\n'), '`show ip route c` is `connected`');
ok(show('show ip route STATIC').join('\n') === stat.join('\n'), 'the word is case-insensitive');
const amb = show('show ip route s');
ok((/^% Ambiguous command/).test(amb[0]) && (/static/).test(amb[0]) && (/summary/).test(amb[0]),
  '`s` is ambiguous between static and summary, and both are named', amb.join(' | '));

// ---- the words that are not protocols ----
const summ = show('show ip route summary');
ok((/^% show ip route summary is a different table/).test(summ[0]),
  '`summary` is refused as a different table, not answered with a routing table', summ.join(' | '));
ok(rowsOf(summ).length === 0, 'and no route row is printed under it');
const pre = show('show ip route 172.16.0.0/16');
ok((/^% show ip route does not take "172\.16\.0\.0\/16"/).test(pre[0]),
  'the prefix form is still refused - a table printed for a prefix reads as "yes"', pre.join(' | '));
ok((/naming a protocol: connected, static, ospf, bgp, rip/).test(pre[0]),
  'and the same sentence names the argument that does narrow it', pre.join(' | '));
// One line. The prefix refusal is the sentence every other refusal in the console is - a single line
// (test/show-argument-refusal.test.js counts them) - so the protocol hint is a clause on it, not a line under it.
ok(pre.length === 1, 'said in one line, like every other refusal', String(pre.length));
const junk = show('show ip route flurbish');
ok((/^% show ip route does not take "flurbish"/).test(junk[0]), 'a word that is neither is refused',
  junk.join(' | '));
const second = show('show ip route static 1');
ok((/takes no second word here/).test(second[0]),
  'a process id is refused in its own words rather than silently ignored', second.join(' | '));

// ---- a box that does not route has no table to narrow ----
const t2 = new Topology();
const sw = t2.addDevice(SWITCH, 'sw1');
const swSession = new CliSession(sw, t2);
const swOut = swSession.run('show ip route static').output;
ok((/^% show ip route does not take "static"/).test(swOut[0]),
  'a non-routing switch refuses the protocol word instead of printing a router\'s table', swOut.join(' | '));
ok(!(/name a protocol/).test(swOut[0]),
  'and does not advise a filter on a table it does not have');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
