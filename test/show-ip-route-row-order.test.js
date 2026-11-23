'use strict';
// `show ip route`: what order the rows come out in.
//
// The console grouped the table by CODE: every connected/local pair first, then every static in the order
// it was typed, then OSPF, then BGP. So a lab with two interfaces, a static to a network that sorts
// between them, and a default route printed:
//
//   C   10.0.0.0/24 is directly connected, GigabitEthernet0/0/0
//   L   10.0.0.1/32 is directly connected, GigabitEthernet0/0/0
//   C   10.5.0.0/16 is directly connected, GigabitEthernet0/0/1
//   L   10.5.0.1/32 is directly connected, GigabitEthernet0/0/1
//   S   10.9.0.0/16 [1/0] via 10.0.0.254
//   S*  0.0.0.0/0 [1/0] via 10.0.0.1
//   S   10.2.0.0/16 [1/0] via 10.0.0.2
//
// A box prints its routing table in the order the table holds its network entries, and the code is a
// letter in front of a row rather than a section of the view. The evidence is in
// research/show-ip-route-row-order.md:
//   * Cisco Community, "Is the default route looked at first or last?" (accepted solution) - the 12.4T
//     hash order, then "In IOS 15.x ... the routing table is automatically displayed in the increasing
//     order of all network entries", with a capture showing 1.0.0.0/24 ... 1.0.7.0/24, 172.19.x,
//     172.20.x, 192.168.0.0/25, 192.168.0.128/25
//     https://community.cisco.com/t5/routing/is-the-default-route-looked-at-first-or-last/td-p/2661554
//   * US CyberPatriot, "Complex Networks using static routes" - a classful-era table where
//     `S 172.16.1.0 [1/0] via 172.16.2.2` is printed above the connected rows for 172.16.2.0/172.16.3.0,
//     i.e. sorted by address with the code ignored
//     https://www.uscyberpatriot.org/Documents/Training%20Documents/Complex%20Routing_ACL_DMZ.pdf
//   * Cisco, "Configure a Gateway of Last Resort that Uses IP Commands" (doc 16448, IOS 15M) - `S*
//     0.0.0.0/0` as the first row under the gateway sentence, which is 0.0.0.0 sorting first
//     https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/16448-default.html
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

function ethPorts(dev) {
  return [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
}

// Two connected networks, three statics typed out of order, one OSPF route and one BGP route - so the
// table has every code this console can print, and none of them is in address order when configured.
function build() {
  const dev = new Device('r1', ROUTER);
  const ports = ethPorts(dev);
  const cli = new CliSession(dev, null, null);
  const run = function (lines) { return lines.map(function (l) { return cli.run(l).output.join('\n'); }); };
  run(['configure terminal']);
  run(['interface ' + ports[0].name, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit']);
  run(['interface ' + ports[1].name, 'ip address 10.5.0.1 255.255.0.0', 'no shutdown', 'exit']);
  dev.config.routes.push({ dest: '10.9.0.0', mask: '255.255.0.0', gw: '10.0.0.254' });
  dev.config.routes.push({ dest: '0.0.0.0', mask: '0.0.0.0', gw: '10.0.0.1' });
  dev.config.routes.push({ dest: '10.2.0.0', mask: '255.255.0.0', gw: '10.0.0.2' });
  dev.ospfRoutes = [{ dest: '10.7.0.0', mask: '255.255.0.0', cost: 2, nextHop: '10.0.0.3', iface: ports[0].name }];
  dev.bgpRoutes = [{ dest: '10.3.0.0', mask: '255.255.0.0', nextHop: '10.0.0.4', iface: ports[0].name, ad: 20, asPath: [65001] }];
  return { dev: dev, ports: ports, lines: cli.run('show ip route').output };
}

function rows(lines) {
  return lines.filter(function (l) { return /^[A-Z][A-Z0-9]?\*?\s+\d+\.\d+\.\d+\.\d+\/\d+ /.test(l); });
}
function prefixes(lines) {
  return rows(lines).map(function (l) { return /\s(\d+\.\d+\.\d+\.\d+\/\d+) /.exec(l)[1]; });
}
function codeOf(line) {
  return /^([A-Z][A-Z0-9]?\*?)\s/.exec(line)[1];
}
function key(prefix) {
  const parts = String(prefix).split('/');
  return { addr: net.ipToInt(parts[0]), len: Number(parts[1]) };
}

console.log('');
console.log('The table is printed in increasing order of its network entries');
{
  const lab = build();
  const order = prefixes(lab.lines);
  const want = ['0.0.0.0/0', '10.0.0.0/24', '10.0.0.1/32', '10.2.0.0/16',
    '10.3.0.0/16', '10.5.0.0/16', '10.5.0.1/32', '10.7.0.0/16', '10.9.0.0/16'];
  ok(order.join(' ') === want.join(' '), 'every row, in address order, whatever its code', order.join(' '));
  const sorted = order.slice().sort(function (a, b) {
    const ka = key(a), kb = key(b);
    if (ka.addr !== kb.addr) return ka.addr - kb.addr;
    return ka.len - kb.len;
  });
  ok(order.join(' ') === sorted.join(' '), 'and that is the same list an address sort produces');
  ok(codeOf(rows(lab.lines)[0]) === 'S*',
    'the candidate default is the first row - 0.0.0.0 is the lowest entry', rows(lab.lines)[0]);
}

console.log('');
console.log('The code is a letter in front of a row, not a section of the view');
{
  const lab = build();
  const codes = rows(lab.lines).map(codeOf);
  ok(codes.join(' ') === 'S* C L S B C L O S',
    'the nine codes interleave rather than group', codes.join(' '));
  ok(codes.indexOf('S') < codes.lastIndexOf('C'),
    'a static route to a lower network prints above a connected route to a higher one');
  const order = prefixes(lab.lines);
  ok(order.indexOf('10.3.0.0/16') !== -1 && order.indexOf('10.3.0.0/16') < order.indexOf('10.5.0.0/16'),
    'the BGP row sits between the static and connected rows it sorts between', order.join(' '));
}

console.log('');
console.log('Two rows for one network address put the less specific first');
{
  // A static to 10.0.0.0/8 beside the connected 10.0.0.0/24: one address, two masks. The trie a box walks
  // prints the parent before the child, so the /8 comes first (inferred - see the research note).
  const dev = new Device('r2', ROUTER);
  const ports = ethPorts(dev);
  const cli = new CliSession(dev, null, null);
  cli.run('configure terminal');
  cli.run('interface ' + ports[0].name);
  cli.run('ip address 10.0.0.1 255.255.255.0');
  cli.run('no shutdown');
  cli.run('exit');
  dev.config.routes.push({ dest: '10.0.0.0', mask: '255.0.0.0', gw: '10.0.0.9' });
  const order = prefixes(cli.run('show ip route').output);
  ok(order[0] === '10.0.0.0/8' && order[1] === '10.0.0.0/24' && order[2] === '10.0.0.1/32',
    'the /8, then the /24, then the local /32', order.join(' '));
}

console.log('');
console.log('Rows for the same prefix keep the order the tie-break decided');
{
  // A static duplicating the connected prefix loses to it. Sorting must not reorder the pair, because the
  // winning row is the one routeTo() tries first and the losing row names it.
  const dev = new Device('r3', ROUTER);
  const ports = ethPorts(dev);
  const cli = new CliSession(dev, null, null);
  cli.run('configure terminal');
  cli.run('interface ' + ports[0].name);
  cli.run('ip address 10.1.2.3 255.255.255.0');
  cli.run('no shutdown');
  cli.run('exit');
  dev.config.routes.push({ dest: '10.1.2.0', mask: '255.255.255.0', gw: '10.1.2.9', iface: ports[0].name });
  const table = rows(cli.run('show ip route').output).filter(function (l) { return /10\.1\.2\.0\/24/.test(l); });
  ok(table.length === 2, 'both rows for the one prefix are printed', table.join(' | '));
  ok(/^C\s/.test(table[0]), 'the connected row first', table[0]);
  ok(/^S\s/.test(table[1]) && /\(not installed: /.test(table[1]),
    'then the static, still marked as losing', table[1]);
}

console.log('');
console.log('The inspector reads the table in the same order as the console');
{
  const lab = build();
  const fromTable = lab.dev.routesTable(null).map(function (r) {
    return r.dest + '/' + net.prefixOf(r.mask);
  });
  ok(fromTable.join(' ') === prefixes(lab.lines).join(' '),
    'one order, two surfaces', fromTable.join(' ') + ' vs ' + prefixes(lab.lines).join(' '));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
