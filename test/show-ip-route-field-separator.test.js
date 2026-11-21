'use strict';
// `show ip route`: how many spaces sit between the prefix and the rest of the row?
//
// The console printed TWO:
//
//   C   10.0.12.0/24  is directly connected, GigabitEthernet0
//   S   192.168.1.0/24  [1/0] via 10.44.192.2
//
// and no IOS or IOS-XE capture writes that. Every byte-preserving capture in hand puts exactly ONE space
// after the prefix, whatever the code field in front of it is padded to:
//
//   C        10.1.2.0/24 is directly connected, GigabitEthernet0/0     (IOS, ntc-templates raw)
//   C        192.168.1.0/24 is directly connected, vasileft1           (IOS 15, ntc-templates raw)
//   S*    0.0.0.0/0 [1/0] via 10.50.15.1                               (IOS-XE, Genie golden output)
//   S        10.16.2.2 [1/0] via 10.186.2.2, GigabitEthernet0/1        (IOS-XE, Genie golden output)
//
// The only two-space run in a real table is the LEADING indent of a continuation row that carries no
// prefix of its own - a multi-next-hop row or a subnetted row, where the bracket starts the line:
//
//   S        10.16.2.2 [1/0] via 10.186.2.2, GigabitEthernet0/1
//                    [1/0] via 10.1.2.2, GigabitEthernet0/0
//
// so the rule is about the separator AFTER a prefix, not about the line as a whole. The two spaces this
// console keeps before its own `(down: ...)` / `(not installed: ...)` annotations are its own sentence,
// which no box prints, and they stay.
//
// Sources (research/show-ip-route-field-separator.md carries the extracts and how they were measured):
//   ntc-templates, cisco_ios_show_ip_route.raw
//     https://github.com/networktocode/ntc-templates/blob/master/tests/cisco_ios/show_ip_route/cisco_ios_show_ip_route.raw
//   ntc-templates, cisco_ios_show_ip_route1.raw
//     https://github.com/networktocode/ntc-templates/blob/master/tests/cisco_ios/show_ip_route/cisco_ios_show_ip_route1.raw
//   Genie parser, IOS-XE ShowIpRoute golden output 1 and 3
//     https://github.com/CiscoTestAutomation/genieparser/blob/master/src/genie/libs/parser/iosxe/tests/ShowIpRoute/cli/equal/golden_output1_output.txt
//     https://github.com/CiscoTestAutomation/genieparser/blob/master/src/genie/libs/parser/iosxe/tests/ShowIpRoute/cli/equal/golden_output3_output.txt
//   Cisco, "Configure a Gateway of Last Resort that Uses IP Commands" (doc 16448, IOS 15M)
//     https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/16448-default.html
const path = require('path');
const { Device } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];

function build() {
  const dev = new Device('r1', ROUTER);
  const ports = [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  const cli = new CliSession(dev, null, null);
  const cfg = function (lines) { return lines.map(function (l) { return cli.run(l).output.join('\n'); }); };
  cfg(['configure terminal']);
  cfg(['interface ' + ports[0].name, 'ip address 10.1.2.3 255.255.255.0', 'no shutdown', 'exit']);
  // A static with a next hop, a static whose next hop is only an interface, a candidate default, and a
  // static that loses to the connected route (so its row carries this console's annotation).
  dev.config.routes.push({ dest: '10.8.0.0', mask: '255.255.0.0', gw: '10.1.2.9', iface: ports[1].name });
  dev.config.routes.push({ dest: '192.168.2.0', mask: '255.255.255.0', gw: '', iface: ports[1].name });
  dev.config.routes.push({ dest: '0.0.0.0', mask: '0.0.0.0', gw: '10.1.2.9' });
  dev.config.routes.push({ dest: '10.1.2.0', mask: '255.255.255.0', gw: '10.1.2.9', iface: ports[1].name });
  // One protocol row of each kind this table can print.
  dev.ospfRoutes = [{ dest: '10.77.0.0', mask: '255.255.0.0', cost: 2, nextHop: '10.1.2.9', iface: ports[0].name }];
  dev.bgpRoutes = [{ dest: '203.0.113.0', mask: '255.255.255.0', nextHop: '10.1.2.9', iface: ports[0].name, ad: 20, asPath: [65001] }];
  return { dev: dev, ports: ports, lines: cli.run('show ip route').output };
}

// A row of the table, as opposed to the legend and the gateway sentence.
function rows(lines) {
  return lines.filter(function (l) { return /^[A-Z][A-Z0-9]?\*?\s+\S+\/\d+ /.test(l); });
}

const lab = build();
const table = rows(lab.lines);
const long = require('../engine/iface-name').displayName;

console.log('');
console.log('Every row puts exactly one space after the prefix');
{
  ok(table.length >= 7, 'the table printed every kind of row', table.join(' | '));
  const wrongGap = table.filter(function (l) { return /\/\d+  (is directly connected|\[)/.test(l); });
  ok(wrongGap.length === 0, 'no row has two spaces between the prefix and what follows it', wrongGap.join(' | '));
  const shapes = table.map(function (l) { return /^([A-Z][A-Z0-9]?\*?\s+\S+\/\d+) (is directly connected,|\[\d+\/\d+\] via)/.exec(l); });
  ok(shapes.every(Boolean), 'each row is `code, prefix, one space, sentence`, on every code', table.join(' | '));
}

console.log('');
console.log('Each shape reads the way the captures read');
{
  const c = table.filter(function (l) { return /^C\s/.test(l) && /10\.1\.2\.0\/24/.test(l); })[0] || '';
  ok(c === 'C   10.1.2.0/24 is directly connected, ' + long(lab.ports[0].name),
    'the connected row: one space, sentence, comma-separated interface', c);
  const l = table.filter(function (l) { return /^L\s/.test(l) && /10\.1\.2\.3\/32/.test(l); })[0] || '';
  ok(l === 'L   10.1.2.3/32 is directly connected, ' + long(lab.ports[0].name),
    'the local row, said the same way', l);
  const s = table.filter(function (l) { return /^S\s/.test(l) && /10\.8\.0\.0\/16/.test(l); })[0] || '';
  ok(s === 'S   10.8.0.0/16 [1/0] via 10.1.2.9, ' + long(lab.ports[1].name),
    'the static row: one space before the bracket, as `S 192.168.1.0/24 [1/0] via` on the hardware', s);
  const def = table.filter(function (l) { return /^S\*/.test(l); })[0] || '';
  ok(def === 'S*  0.0.0.0/0 [1/0] via 10.1.2.9',
    'the candidate default keeps its two-character code and gains the one-space separator', def);
  const direct = table.filter(function (l) { return /^S\s/.test(l) && /192\.168\.2\.0\/24/.test(l); })[0] || '';
  ok(direct.replace(/  \(.*$/, '') === 'S   192.168.2.0/24 is directly connected, ' + long(lab.ports[1].name),
    'a static whose next hop is only an interface takes the sentence, with the same one space', direct);
  const o = table.filter(function (l) { return /^O\s/.test(l); })[0] || '';
  ok(/^O\s+10\.77\.0\.0\/16 \[110\/2\] via 10\.1\.2\.9, \S+$/.test(o),
    'the OSPF row: prefix, one space, distance/metric, next hop, interface', o);
  const b = table.filter(function (l) { return /^B\s/.test(l); })[0] || '';
  ok(/^B\s+203\.0\.113\.0\/24 \[20\/0\] via 10\.1\.2\.9, \S+$/.test(b),
    'the BGP row, the same shape', b);
}

console.log('');
console.log('The console\'s own annotation is still set off by two spaces');
{
  const losing = table.filter(function (l) { return /10\.1\.2\.0\/24/.test(l) && /^S\s/.test(l); })[0] || '';
  ok(/ \[1\/0\] via 10\.1\.2\.9, \S+  \(not installed: /.test(losing),
    'a losing row keeps ONE space before its bracket and TWO before this console\'s note', losing);
  ok(!/\S  \(not installed/.test(table.filter(function (l) { return !/\(not installed:/.test(l); }).join('')),
    'no other row carries that gap');
}

console.log('');
console.log('Nothing else about the row moved');
{
  const r = lab.dev.routesTable(null).filter(function (x) { return x.dest === '10.8.0.0'; })[0];
  ok(r && r.ifaceDisplay === long(lab.ports[1].name), 'the inspector still reads the row from the same fields',
    JSON.stringify(r));
  ok(table.every(function (l) { return !/\t/.test(l); }), 'no row uses a tab to align anything');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
