'use strict';
// `show ip route` prints the destination as ONE field: `10.1.2.0/24`, not an address padded out to a
// column with the mask hanging off it at column 20.
//
// The console printed `C   10.1.2.0       /24  is directly connected, Gi0/0/0` - the address padded to 15
// characters, then a slash, then the length. No IOS prints that shape. Every sample joins the pair:
//
//   C 10.44.192.0/24 is directly connected, GigabitEthernet0/0
//   S* 0.0.0.0/0 [1/0] via 10.108.99.2
//
// Sources:
//   Cisco, "Configure a Gateway of Last Resort that Uses IP Commands" (doc 16448, updated 2025, IOS 15M
//   on a 3900), both tables and the `ip default-network` walkthrough
//     https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/16448-default.html
//   Cisco IOS IP Routing: Protocol-Independent Command Reference, `show ip route`
//     https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/Cisco_IOS_IP_Routing_Protocol-Independent_Command_Reference/IP_Routing_Protocol-Independent_Commands_S_through_T.html
//     ("C 10.2.1.0/24 is directly connected, Loopback1", "L 10.2.1.1/32 ...", "S 10.10.10.0 is directly
//     connected, Tunnel0")
//   Cisco IOS IP Routing: BGP Command Reference, `show ip route` sample
//     https://www.cisco.com/c/en/us/td/docs/ios/iproute_bgp/command/reference/irg_book/irg_bgp5.html
//     ("C 10.10.10.0/24 is directly connected, Vlan1")
//   Cisco Community, "Static IP Route"
//     https://community.cisco.com/t5/routing/static-ip-route/td-p/3299523
//     ("S* 0.0.0.0/0 [1/0] via 192.168.10.6")
//
// Two things follow from the shape, and both are pinned below. The mask is not a column: it is part of
// the destination, so a /24 row and a /0 row cannot lay out differently. And because the field is the
// prefix, the first cell after the code is `net/len` - the same string the inspector's Routes panel
// prints for that row (web/app.js, `r.dest + '/' + maskBits(r.mask)`), which is where the two surfaces
// had begun to disagree about one fact.
//
// Deliberately NOT changed: the code field stays three characters wide (`C  `, `S* `, `O  `, `B  `), and
// the two-space gap before `is directly connected` / `[distance/metric]` is this console's separator for
// the annotations it appends to a row. IOS pads the code to a wider field and separates with one space;
// that is a different question from whether the mask belongs to the address.
const path = require('path');
const { Device } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const net = require('../engine/net');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];

// A box holding one prefix of every kind the table can print: two connected subnets, a static default, a
// configured gateway that loses to it, an OSPF route and two BGP routes at different distances.
function build() {
  const dev = new Device('r1', ROUTER);
  const ports = [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  ports[0].ip = '10.1.2.3'; ports[0].mask = '255.255.255.0';
  ports[1].ip = '10.9.0.1'; ports[1].mask = '255.255.255.0';
  dev.config.routes = [{ dest: '0.0.0.0', mask: '0.0.0.0', gw: '10.1.2.1', iface: null }];
  dev.config.defaultGateway = '10.1.2.254';
  dev.ospfRoutes = [{ dest: '10.77.0.0', mask: '255.255.0.0', nextHop: '10.1.2.9', iface: ports[0].name }];
  dev.bgpRoutes = [
    { dest: '203.0.113.0', mask: '255.255.255.0', nextHop: '10.1.2.2', iface: ports[0].name, ad: 20 },
    { dest: '198.18.0.0', mask: '255.255.0.0', nextHop: '10.9.0.2', iface: ports[1].name, ad: 200 }
  ];
  const cli = new CliSession(dev, null, null);
  return { dev: dev, cli: cli, ports: ports };
}

function show(s) {
  const r = s.cli.run('show ip route');
  return ((r && r.output) || []).map(String);
}

// The table's own rows: the legend, the gateway sentence and any header line are not rows.
function tableRows(lines) {
  return lines.filter(function (l) { return /^[A-Z]\*?\s/.test(l) && !/^Codes:/.test(l); });
}

const lab = build();
const lines = show(lab);
const rows = tableRows(lines);
const text = lines.join('\n');

console.log('');
console.log('The destination is one field: address, slash, length - no padding between them');
{
  ok(rows.length >= 6, 'the table parsed into rows (' + rows.length + ')', JSON.stringify(lines));
  const joined = rows.filter(function (l) { return /\d+\.\d+\.\d+\.\d+\/\d+/.test(l); });
  ok(joined.length === rows.length, 'every row prints net/len as one token', rows.join(' | '));
  // The defect itself, stated as a negative: no row may hold an address, whitespace, then the slash.
  const split = rows.filter(function (l) { return /\d+\.\d+\.\d+\.\d+\s+\/\d+/.test(l); });
  ok(split.length === 0, 'and no row separates the address from its mask with whitespace',
    split.join(' | '));
  // A padded address followed by a slash is the shape this file exists to keep out.
  ok(!/[0-9]\s{2,}\/\d/.test(text), 'no address in the table is padded out to a column', text);
}

console.log('');
console.log('Each kind of row, in the reading order the device uses');
{
  const connected = rows.filter(function (l) { return /^C\s/.test(l) && / is directly connected,/.test(l); });
  ok(connected.length === 2, 'two connected rows', connected.join(' | '));
  ok(connected.every(function (l) { return /^C\s+\d+\.\d+\.\d+\.\d+\/\d+\s{2}is directly connected, \S+/.test(l); }),
    'C, then the prefix as one field, then is directly connected, and the port', connected.join(' | '));
  ok(connected.some(function (l) { return l.indexOf('10.1.2.0/24') !== -1; }),
    'the first subnet reads 10.1.2.0/24, not 10.1.2.0 with its mask adrift', connected.join(' | '));

  // The second shape of directly-connected row: the box's own address, one line under its subnet
  // (research/local-route-in-show-ip-route.md). Same field rule - `10.1.2.3/32`, not `10.1.2.3` then a /32
  // adrift - because it goes through the same printer.
  const local = rows.filter(function (l) { return /^L\s/.test(l); });
  ok(local.length === 2, 'two local host rows, one per address', local.join(' | '));
  ok(local.every(function (l) { return /^L\s+\d+\.\d+\.\d+\.\d+\/32\s{2}is directly connected, \S+$/.test(l); }),
    'L, then the address as one /32 field, then the port - no bracket, no next hop', local.join(' | '));
  ok(local.some(function (l) { return l.indexOf('10.1.2.3/32') !== -1; }),
    'the local row is the address, not the subnet', local.join(' | '));
  ok(rows.indexOf(local[0]) === rows.indexOf(connected[0]) + 1,
    'and it sits directly under the connected row it belongs to', rows.join(' | '));

  const def = rows.filter(function (l) { return l.indexOf('0.0.0.0/0') !== -1; });
  ok(def.length === 2, 'both candidate defaults print 0.0.0.0/0 as one field', def.join(' | '));
  ok(def.every(function (l) { return /^S\*\s+0\.0\.0\.0\/0\s{2}\[\d+\/0\] via \S+/.test(l); }),
    'and each is S*, /0, then [distance/metric] via a next hop', def.join(' | '));
  ok(def.some(function (l) { return /\[1\/0\] via 10\.1\.2\.1/.test(l); }),
    'the typed static default is the one at distance 1', def.join(' | '));

  const ospf = rows.filter(function (l) { return l.indexOf('O  ') === 0; })[0] || '';
  ok(/^O\s+10\.77\.0\.0\/16\s{2}\[110\/\d+\] via 10\.1\.2\.9/.test(ospf),
    'the OSPF row keeps its /16 beside the network and its cost in the bracket', ospf);

  const bgp = rows.filter(function (l) { return l.indexOf('B  ') === 0; })[0] || '';
  ok(/^B\s+203\.0\.113\.0\/24\s{2}\[20\/0\] via 10\.1\.2\.2/.test(bgp),
    'the eBGP row reads the same way', bgp);
}

console.log('');
console.log('The mask is part of the destination, so it cannot shift the rest of the row');
{
  // Every row begins with the same three-character code field whatever its code is, and the field after
  // it is the prefix - never a bare address with the mask pushed to a later column.
  ok(rows.every(function (l) { return /^[A-Z]\*?\s{2}/.test(l) || /^S\*\s/.test(l); }),
    'the code field is fixed for every code the table prints', rows.join(' | '));
  const fields = rows.map(function (l) { return l.trim().split(/\s+/)[1]; });
  ok(fields.every(function (f) { return /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(f); }),
    'the second field of every row is the whole prefix', JSON.stringify(fields));
  // Order: prefix, then either the connected clause or the bracket. A bracket before the prefix would be
  // a row that names a distance before it names the network it belongs to.
  ok(rows.every(function (l) {
    const p = l.search(/\d+\.\d+\.\d+\.\d+\/\d+/);
    const b = l.search(/\[/);
    return b === -1 || p < b;
  }), 'the prefix always precedes the bracket', rows.join(' | '));
}

console.log('');
console.log('The console and the inspector print the same prefix for the same row');
{
  // The panel builds its network cell as dest + / + maskBits(mask) and the console now prints the same
  // string. One table, one spelling - the shape this file exists to keep.
  const served = lab.dev.routesTable(null);
  const missing = [];
  for (const r of served) {
    const want = r.dest + '/' + net.prefixOf(r.mask);
    const hit = rows.filter(function (l) { return l.trim().split(/\s+/)[1] === want; })[0];
    if (!hit) missing.push(want);
  }
  ok(missing.length === 0, 'every route row in the panel appears under that exact prefix in the console',
    JSON.stringify(missing));
  ok(served.length === rows.length, 'and the two surfaces hold the same number of rows (' +
    served.length + ' vs ' + rows.length + ')');
}

console.log('');
console.log('A box that does not route prints no route rows at all');
{
  const SWITCH = catalog.filter(function (s) { return /Catalyst2960/.test(s.model); })[0];
  const sw = new Device('sw1', SWITCH);
  const swLines = ((new CliSession(sw, null, null).run('show ip route').output) || []).map(String);
  ok(!swLines.some(function (l) { return /\d+\.\d+\.\d+\.\d+\/\d+/.test(l); }),
    'the default-gateway shape carries no prefix at all', JSON.stringify(swLines));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
