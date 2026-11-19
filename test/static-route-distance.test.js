'use strict';
// The number after a static route's next hop is its administrative distance.
//
// Cisco's syntax is
//   ip route prefix mask { ip-address | interface-type interface-number [ip-address] } [dhcp] [global]
//             [distance] [multicast] [name next-hop-name] [permanent | track number] [tag tag]
// with "distance (Optional) Administrative distance. The range is 1 to 255. The default administrative
// distance for a static route is 1" (Cisco IOS IP Routing: Protocol-Independent Command Reference, `ip route`,
// https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/iri-cr-book/iri-cr-a1.html). That
// number is the whole of a floating static: `ip route 0.0.0.0 0.0.0.0 198.51.100.1 200` is installed only
// while nothing more trusted reaches the same prefix.
//
// This console read the slot as an interface name, so
//   r1(config)# ip route 0.0.0.0 0.0.0.0 10.0.0.2 200
//   % 0.0.0.0/0: no interface called "200"
// and the one form every IOS course teaches for a backup route could not be typed. The distance was already
// printed - every row carries `[distance/metric]` - but only the per-source constant, never the value an
// operator had configured, so the feature the number is for did not exist.
//
// Evidence and what is still not modelled (name, tag, permanent, track, VRF):
// research/static-route-distance.md.

const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = function (m) { return catalog.find(function (x) { return x.model === m; }); };

function cli(t, dev, cmds) {
  return runCommands(dev, t, null, ['enable', 'configure terminal'].concat(cmds)).lines || [];
}
function show(t, dev, cmd) {
  const s = new Simulator(t);
  s.setRunTime(60000);
  return runCommands(dev, t, s, ['enable', cmd]).lines.join('\n');
}
function routeRow(table, cidr) {
  return table.split('\n').filter(function (l) { return l.trim().split(/\s+/)[1] === cidr; });
}

// One router, one addressed port, no cable beyond it: the table and `routeTo()` do not need a link to answer
// "which route is installed", and leaving the cable out keeps the rows free of the fault notes that belong to
// another question.
function router() {
  const t = new Topology();
  const r1 = t.addDevice(spec('ISR 4331'), 'r1');
  const port = Array.from(r1.interfaces.keys())[0];
  cli(t, r1, ['interface ' + port, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown']);
  return { t: t, r1: r1, port: port };
}

console.log('A distance is typed, stored, printed and replayed:');
{
  const lab = router();
  const out = cli(lab.t, lab.r1, ['ip route 0.0.0.0 0.0.0.0 10.0.0.254 200']).join('\n');
  ok(/Route added: 0\.0\.0\.0\/0 via 10\.0\.0\.254 \(distance 200\)/.test(out),
    'the acknowledgement names the distance that was set', out);

  const stored = lab.r1.config.routes.filter(function (r) { return r.dest === '0.0.0.0'; });
  ok(stored.length === 1 && Number(stored[0].distance) === 200,
    'the number is stored on the route, not absorbed as an interface name', JSON.stringify(stored));

  const table = show(lab.t, lab.r1, 'show ip route');
  ok(routeRow(table, '0.0.0.0/0').some(function (l) { return /\[200\/0\]/.test(l); }),
    'the row prints it in the bracket the table reserves for it', table);

  const cfg = show(lab.t, lab.r1, 'show running-config');
  ok(cfg.split('\n').indexOf('ip route 0.0.0.0 0.0.0.0 10.0.0.254 200') !== -1,
    'the saved file carries the distance, so the line replays', cfg.split('\n').filter(function (l) {
      return l.indexOf('ip route') === 0;
    }).join(' | '));

  // A route typed without a distance keeps the vendor's default of 1, and the file does not grow a ` 1`.
  const lab2 = router();
  cli(lab2.t, lab2.r1, ['ip route 0.0.0.0 0.0.0.0 10.0.0.254']);
  const cfg2 = show(lab2.t, lab2.r1, 'show running-config');
  ok(cfg2.split('\n').indexOf('ip route 0.0.0.0 0.0.0.0 10.0.0.254') !== -1,
    'an unset distance is still the default and is not printed as an argument', cfg2.split('\n').filter(function (l) {
      return l.indexOf('ip route') === 0;
    }).join(' | '));
}

console.log('\nA floating static loses while the primary exists, and wins when it goes:');
{
  const lab = router();
  cli(lab.t, lab.r1, [
    'ip route 10.9.0.0 255.255.0.0 10.0.0.254',
    'ip route 10.9.0.0 255.255.0.0 10.0.0.253 200'
  ]);
  const table = show(lab.t, lab.r1, 'show ip route');
  const rows = routeRow(table, '10.9.0.0/16');
  ok(rows.length === 2, 'both candidates are still listed, so the backup has not vanished', table);
  const primary = rows.filter(function (l) { return /\[1\/0\]/.test(l); });
  const backup = rows.filter(function (l) { return /\[200\/0\]/.test(l); });
  ok(primary.length === 1 && !/not installed/.test(primary[0]),
    'the distance-1 route is the installed one', primary.join('\n'));
  ok(backup.length === 1 && /\(not installed: the S route for this prefix has distance 1\)/.test(backup[0]),
    'the distance-200 route is marked, and the row that beat it is named', backup.join('\n'));

  ok(lab.r1.routeTo('10.9.9.9').via === '10.0.0.254' && lab.r1.routeTo('10.9.9.9').ad === 1,
    'forwarding follows the primary', JSON.stringify(lab.r1.routeTo('10.9.9.9')));

  cli(lab.t, lab.r1, ['no ip route 10.9.0.0 255.255.0.0 10.0.0.254']);
  const after = lab.r1.routeTo('10.9.9.9');
  ok(after && after.via === '10.0.0.253' && after.ad === 200,
    'with the primary gone the same traffic uses the floating static', JSON.stringify(after));
  const table2 = show(lab.t, lab.r1, 'show ip route');
  ok(routeRow(table2, '10.9.0.0/16').every(function (l) { return !/not installed/.test(l); }),
    'and the remaining row prints as installed', table2);
}

console.log('\nA distance outside the vendor range is refused by name:');
{
  const lab = router();
  for (const bad of ['0', '300', '65536']) {
    const out = cli(lab.t, lab.r1, ['ip route 192.0.2.0 255.255.255.0 10.0.0.254 ' + bad]).join('\n');
    ok(new RegExp('administrative distance ' + bad + ' must be 1-255').test(out),
      'distance ' + bad + ' is refused with the range and the default', out);
  }
  ok(lab.r1.config.routes.length === 0, 'and no route was installed by a refused command',
    JSON.stringify(lab.r1.config.routes));
}

console.log('\nA distance of 255 is "never installed", which is the vendor rule for that number:');
{
  const lab = router();
  cli(lab.t, lab.r1, ['ip route 198.51.100.0 255.255.255.0 10.0.0.254 255']);
  const table = show(lab.t, lab.r1, 'show ip route');
  const row = routeRow(table, '198.51.100.0/24');
  ok(row.length === 1 && /\[255\/0\]/.test(row[0]),
    'the route is kept and printed, because it is configured', row.join('\n'));
  ok(/\(not installed: a route with administrative distance 255 is never installed\)/.test(row[0]),
    'the row says why it can never carry a packet', row.join('\n'));
  ok(lab.r1.routeTo('198.51.100.7') === null,
    'and a packet for it has no route at all rather than leaving by a route the box would not install',
    JSON.stringify(lab.r1.routeTo('198.51.100.7')));
}

console.log('\nThe no-form names the route it removes, distance included:');
{
  const lab = router();
  cli(lab.t, lab.r1, [
    'ip route 10.9.0.0 255.255.0.0 10.0.0.254 200',
    'ip route 10.9.0.0 255.255.0.0 10.0.0.253'
  ]);
  const out = cli(lab.t, lab.r1, ['no ip route 10.9.0.0 255.255.0.0 10.0.0.254 200']).join('\n');
  ok(/Route removed/.test(out), 'the command removes a route', out);
  const left = lab.r1.config.routes.filter(function (r) { return r.dest === '10.9.0.0'; });
  ok(left.length === 1 && left[0].gw === '10.0.0.253' && left[0].distance === undefined,
    'the distance-1 route to the same prefix is untouched', JSON.stringify(left));
}

console.log('\nThe distance survives a saved lab:');
{
  const lab = router();
  cli(lab.t, lab.r1, ['ip route 10.9.0.0 255.255.0.0 10.0.0.254 200']);
  const doc = JSON.parse(JSON.stringify(lab.t.serialize()));
  const reopened = Topology.fromJSON(doc);
  const dev = reopened.getDevice('r1');
  const route = (dev.config.routes || []).filter(function (r) { return r.dest === '10.9.0.0'; })[0];
  ok(route && Number(route.distance) === 200,
    'the reopened board still prices the route at 200', JSON.stringify(dev.config.routes));
  ok(dev.routeTo('10.9.9.9').ad === 200, 'and forwards by it at that distance',
    JSON.stringify(dev.routeTo('10.9.9.9')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
