'use strict';
// `show ip route`: a static route whose next hop is only an interface prints as a DIRECTLY CONNECTED
// network, not with a next hop and not with a bracket.
//
// The console printed the bracket form with a placeholder next hop:
//
//   S   192.168.2.0/24  [1/0] via -  Gi0/0/0
//   S*  0.0.0.0/0  [1/0] via -  Gi0/0/0
//
// No IOS prints that. `ip route <prefix> <mask> <interface>` is the vendor's "directly connected static
// route", and the table says so in the same words a connected route uses:
//
//   S 192.168.2.0/24 is directly connected, GigabitEthernet0/1
//   S* 0.0.0.0/0 is directly connected, FastEthernet0
//
// The vendor's `ip route` reference explains why the row is not a lie: "When the next hop of a static
// route points to an interface, the router considers each of the hosts within the range of the route to
// be directly connected through that interface, and therefore it will send Address Resolution Protocol
// (ARP) requests to any destination addresses that route through the static route."
//
// The administrative distance does not appear on such a row - not even when one was typed - and that is
// the part that surprises operators, so it is pinned below: `ip route ... <iface> 40` still reads
// directly connected, while the distance keeps pricing the route. The fully-specified form
// (interface AND next hop) is a different row and keeps its `via`.
//
// Sources (research/show-ip-route-static-via-interface.md has the extracts):
//   Cisco IOS IP Routing: Protocol-Independent Command Reference, `ip route` and `show ip route`
//     https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/iri-cr-book/iri-cr-a1.html
//     ("S 10.10.10.0 is directly connected, Tunnel0")
//   Cisco TAC command reference, `show ip route` (a static-heavy table, every row bracketless)
//     https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/show_ip_route.htm
//   Cisco Catalyst SD-WAN Routing Configuration Guide 26.x, "Static route support for BFD sessions"
//     (next-hop forms with `[1/0] via ...` beside `S* 0.0.0.0/0 is directly connected, Cellular0/0/0`)
//     https://cisco.com/c/en/us/td/docs/routers/sdwan/26x-later/routing/routing-configuration-guide/bfd/c-static-route-support-for-bfd-sessions-in-transport-vpn.html
//   Cisco 900 Series ISR Software Configuration Guide, Basic Router Configuration
//     http://www.cisco.com/c/en/us/td/docs/routers/access/900/software/configuration/guide/900SCG/routconf.pdf
//     ("S* 0.0.0.0/0 is directly connected, gigabitethernet0")
//   Cisco Press, "Routing Concepts 1.3" (S* ... Serial0/0/0)
//     https://www.ciscopress.com/articles/article.asp?p=2756479&seqNum=6
//   Cisco Community, "Administrative distance for static routes" (typed 254, row still bracketless)
//     https://community.cisco.com/t5/routing/administrative-distance-for-static-routes/td-p/1714940
//   r/ccna, "AD of a static 'directly connected' route" (typed 40, "still shows as directly connected")
//     https://www.reddit.com/r/ccna/comments/fih7fu/ad_of_a_static_directly_connected_route/
//   Pearson, CCNA Routing and Switching ch.2 sample (routing-table entry says directly connected, AD is 1)
//     https://ptgmedia.pearsoncmg.com/images/9781587133213/samplepages/03_9781587133213_ch02.pdf
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

// One port with an address (so the box has a connected route to sit beside the statics) and two spare
// ports to point the routes at.
function build() {
  const dev = new Device('r1', ROUTER);
  const ports = [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  const cli = new CliSession(dev, null, null);
  const cfg = function (lines) { return lines.map(function (l) { return cli.run(l).output.join('\n'); }); };
  cfg(['configure terminal']);
  cfg(['interface ' + ports[0].name, 'ip address 10.1.2.3 255.255.255.0', 'no shutdown', 'exit']);
  return { dev: dev, cli: cli, ports: ports, cfg: cfg };
}

function show(s, cmd) { return (s.cli.run(cmd).output || []).map(String); }
function rows(lines) { return lines.filter(function (l) { return /^[A-Z]\*?\s/.test(l) && !/^Codes:/.test(l); }); }

console.log('');
console.log('An interface-only static is printed as a directly connected network');
{
  const s = build();
  const p = s.ports[1].name, q = s.ports[2].name;
  const said = s.cfg([
    'ip route 192.168.2.0 255.255.255.0 ' + p,       // the plain directly connected form
    'ip route 0.0.0.0 0.0.0.0 ' + q,                 // a candidate default by exit interface
    'ip route 10.9.0.0 255.255.0.0 ' + p + ' 200'    // and one at a distance that must stay priced
  ]);
  // The fully specified form (interface AND next hop) lives in the table with both halves set. It is put
  // there as a row rather than typed, because which word order `ip route` accepts for the two together is
  // a separate question this test is not about (research/show-ip-route-static-via-interface.md records the
  // open one: the vendor's syntax is `prefix mask { ip-address | interface [ip-address] }`, interface
  // first).
  s.dev.config.routes.push({ dest: '10.8.0.0', mask: '255.255.0.0', gw: '10.9.0.9', iface: p });
  ok(said.some(function (t) { return /Route added: 192\.168\.2\.0\/24 out /.test(t); }),
    'the interface-only form is still accepted and says it went out a port', said.join(' | '));

  const table = show(s, 'show ip route');
  const lines = rows(table);
  const byPrefix = function (pfx) { return lines.filter(function (l) { return l.indexOf(pfx) !== -1; })[0] || ''; };

  const plain = byPrefix('192.168.2.0/24');
  ok(/^S\s+192\.168\.2\.0\/24\s{2}is directly connected, /.test(plain),
    'it reads S, the prefix, then "is directly connected,"', plain);
  ok(plain.indexOf('[1/0]') === -1 && !/\bvia\b/.test(plain),
    'with no bracket and no "via" - there is no next hop to name', plain);

  const def = byPrefix('0.0.0.0/0');
  ok(/^S\*\s+0\.0\.0\.0\/0\s{2}is directly connected, /.test(def),
    'a default pointed at an interface keeps its candidate-default star and says directly connected', def);

  const dist = byPrefix('10.9.0.0/16');
  ok(/^S\s+10\.9\.0\.0\/16\s{2}is directly connected, /.test(dist),
    'and so does one configured with a distance: the bracket is not printed', dist);
  // The distance is not lost, only unprinted - it still decides which route wins.
  const row200 = (s.dev.routesTable ? s.dev.routesTable() : []).filter(function (r) {
    return r.dest === '10.9.0.0';
  })[0];
  ok(row200 && row200.distance === 200, 'the distance 200 is still what prices the route',
    row200 && String(row200.distance));
  ok(row200 && row200.directlyConnected === true,
    'the row carries the shared flag the inspector also reads, so the two surfaces cannot diverge',
    row200 && String(row200.directlyConnected));

  // Nothing anywhere may still print the placeholder next hop this change removed.
  ok(!/via -/.test(table.join('\n')), 'no row prints "via -" any more', table.join(' | '));

  const full = byPrefix('10.8.0.0/16');
  ok(/^S\s+10\.8\.0\.0\/16\s{2}\[1\/0\] via 10\.9\.0\.9\s{2}/.test(full),
    'the fully specified form is not directly connected: it keeps its bracket and next hop', full);
  ok(full.indexOf(p) !== -1, 'and still names the exit interface beside the next hop', full);
  const fullRow = (s.dev.routesTable ? s.dev.routesTable() : []).filter(function (r) {
    return r.dest === '10.8.0.0';
  })[0];
  ok(fullRow && fullRow.directlyConnected === false,
    'the same flag says a fully specified static is NOT a directly connected network',
    fullRow && String(fullRow.directlyConnected));

  const cfgOut = show(s, 'show running-config').join('\n');
  ok(/^ip route 10\.9\.0\.0 255\.255\.0\.0 \S+ 200$/m.test(cfgOut),
    'the typed distance is still in the saved file', cfgOut.split('\n').filter(function (l) { return /^ip route/.test(l); }).join(' | '));
}

console.log('');
console.log('The connected row it now shares a shape with is unchanged');
{
  const s = build();
  const lines = show(s, 'show ip route');
  const c = rows(lines).filter(function (l) { return l.indexOf('10.1.2.0/24') !== -1; })[0] || '';
  ok(/^C\s+10\.1\.2\.0\/24\s{2}is directly connected, /.test(c),
    'a connected route still reads C, prefix, "is directly connected,"', c);
}

console.log('');
console.log('A static with a next hop and no interface is untouched');
{
  const s = build();
  s.cfg(['ip route 172.16.0.0 255.255.0.0 10.1.2.254']);
  const r = rows(show(s, 'show ip route')).filter(function (l) { return l.indexOf('172.16.0.0/16') !== -1; })[0] || '';
  ok(/^S\s+172\.16\.0\.0\/16\s{2}\[1\/0\] via 10\.1\.2\.254$/.test(r),
    'the recursive row keeps its bracket, its next hop and no interface', r);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
