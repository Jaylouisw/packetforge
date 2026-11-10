'use strict';
// route-installed.test.js — which row in `show ip route` actually forwards.
//
// The table listed *candidates*: a static route and an OSPF route for the same prefix were two
// identical-looking rows, so a reader could not tell whether they had a second path, a backup, or
// one live route and one shadow. IOS answers this by printing only the installed route; this table
// prints the candidates deliberately (the shadowed one is useful) but now marks the winner and
// gives the reason in an `AD` column.
//
// The mark is not allowed to be its own opinion: it is computed with the same administrative
// distances `routeTo()` uses, and this file cross-checks every starred row against `routeTo()` on
// an address inside that prefix. A star that disagreed with the data path would be worse than no
// star at all - the table would be confidently wrong.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { Device } = require('../engine/device');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) +
    ', want ' + JSON.stringify(expected) + ')'));
}
function match(re, text, msg) {
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text) + ')'));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const model = (n) => catalog.find((x) => x.model === n);

// R1 -- R2. R2 owns 10.0.99.0/24 and advertises it over OSPF; R1 also has a static route for the
// same prefix, so the static shadows the OSPF route. R2 owns 10.0.77.0/24 too, which R1 learns
// only by OSPF.
function build(withStatic) {
  const t = new Topology();
  const r1 = t.addDevice(model('generic-router'));
  const r2 = t.addDevice(model('generic-router'));
  const host = t.addDevice(model('generic-pc'));
  r1.name = 'R1'; r2.name = 'R2'; host.name = 'PC1';
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  t.connect(host.id, 'eth0', r2.id, 'Gi0/1');
  const sim = new Simulator(t);
  const r1cfg = ['enable', 'configure terminal', 'ospf router-id 1.1.1.1', 'ospf area 0',
    'interface Gi0/0', 'ip address 10.0.12.1 255.255.255.0', 'ip ospf area 0', 'exit'];
  if (withStatic) r1cfg.push('ip route 10.0.99.0 255.255.255.0 10.0.12.2');
  r1cfg.push('exit');
  runCommands(r1, t, sim, r1cfg);
  runCommands(r2, t, sim, ['enable', 'configure terminal', 'ospf router-id 2.2.2.2', 'ospf area 0',
    'interface Gi0/0', 'ip address 10.0.12.2 255.255.255.0', 'ip ospf area 0', 'exit',
    'interface Gi0/1', 'ip address 10.0.99.1 255.255.255.0', 'ip ospf area 0', 'exit',
    'interface Gi0/2', 'ip address 10.0.77.1 255.255.255.0', 'ip ospf area 0', 'exit', 'exit']);
  // A host, not a router interface: a router answers an echo only for an address owned by
  // the interface it arrived on, so a ping to R2's far-side address would time out for a
  // reason that has nothing to do with the route under test.
  runCommands(host, t, sim, ['enable', 'configure terminal', 'interface eth0',
    'ip address 10.0.99.50 255.255.255.0', 'exit', 'ip default-gateway 10.0.99.1', 'exit']);
  const cli = (dev, cmds) => runCommands(dev, t, sim, ['enable'].concat(cmds)).lines.join('\n');
  return { t, r1, r2, host, sim, cli };
}

// The table's own rows, parsed back out of the rendered text.
function rowsOf(text) {
  const out = [];
  for (const line of text.split('\n')) {
    // The marker column is as wide as its widest cell, so the gap after it is not a fixed run of
    // spaces - an unstarred row is padded, a starred one is not.
    const m = /^ {2}( *\*?) +([CSOB]) (\S+\/\d+) +(\d+|-) +(\S+) +(\S+)$/.exec(line);
    if (m) out.push({ star: m[1].indexOf('*') !== -1, code: m[2], prefix: m[3], ad: m[4], gw: m[5], iface: m[6] });
  }
  return out;
}
function addrIn(prefix) {
  const [ip, len] = prefix.split('/');
  const octets = ip.split('.').map(Number);
  if (len === '0') return '192.0.2.10';
  octets[3] += 5;
  return octets.join('.');
}

const lab = build(true);
const table = lab.cli(lab.r1, ['show ip route at converged']);

console.log('The table says which row forwards, and why:');
{
  match(/^\* = installed \(this row is what forwards\); an unmarked row loses on administrative distance$/m,
    table, 'the marker is explained, and the reason is named');
  match(/^ {2}\* {2}Prefix +AD +Gateway +Interface$/m, table, 'the columns are marker, prefix, distance, gateway, interface');

  const rows = rowsOf(table);
  ok(rows.length >= 3, 'the table has rows to talk about (' + rows.length + ')');
  const byKey = {};
  for (const r of rows) (byKey[r.prefix] = byKey[r.prefix] || []).push(r);

  // Exactly one winner per prefix.
  for (const prefix of Object.keys(byKey)) {
    const starred = byKey[prefix].filter(function (r) { return r.star; });
    eq(starred.length, 1, 'exactly one installed row for ' + prefix);
  }

  // Administrative distances are the engine's, not the display's.
  const connected = rows.filter(function (r) { return r.code === 'C'; })[0];
  const statics = rows.filter(function (r) { return r.code === 'S'; })[0];
  const ospf = rows.filter(function (r) { return r.code === 'O'; })[0];
  eq(connected.ad, String(Device.ADMIN_DISTANCE.connected), 'a connected route reports distance 0');
  eq(statics.ad, String(Device.ADMIN_DISTANCE.static), 'a static route reports distance 1');
  eq(ospf.ad, String(Device.ADMIN_DISTANCE.ospf), 'an OSPF route reports distance 110');
}

console.log('\nA shadowed route is shown, marked, and not claimed to forward:');
{
  const rows = rowsOf(table).filter(function (r) { return r.prefix === '10.0.99.0/24'; });
  eq(rows.length, 2, 'both candidates for 10.0.99.0/24 are listed');
  const won = rows.filter(function (r) { return r.star; });
  const lost = rows.filter(function (r) { return !r.star; });
  eq(won.length, 1, 'one of them is installed');
  eq(won[0].code, 'S', 'and it is the static route, the lower distance');
  eq(lost.length, 1, 'the other is listed as a candidate');
  eq(lost[0].code, 'O', 'and it is the OSPF route');
}

console.log('\nThe star agrees with the data path:');
{
  // For every prefix, ask the device's own router where it would send traffic inside that prefix.
  for (const prefix of ['10.0.12.0/24', '10.0.99.0/24', '10.0.77.0/24']) {
    const route = lab.r1.routeTo(addrIn(prefix));
    ok(!!route, 'routeTo() answers for ' + prefix);
    const starred = rowsOf(table).filter(function (r) { return r.prefix === prefix && r.star; })[0];
    ok(!!starred, 'and the table marks a row for ' + prefix);
    if (!route || !starred) continue;
    if (route.type === 'connected') {
      // On-link: there is no gateway, and routeTo() reports the destination itself as the next hop.
      eq(starred.gw, '-', prefix + ': a connected route shows no gateway, because there is none');
    } else {
      eq(starred.gw, route.via || '-', prefix + ': the starred gateway is the next hop routeTo() uses');
    }
    eq(starred.iface, route.iface || '-', prefix + ': and the same egress interface');
  }
  // The shadowed OSPF row is the one thing routeTo must NOT pick.
  const ospfRoute = lab.r1.routeTo('10.0.99.5');
  eq(ospfRoute.type, 'static', 'for 10.0.99.5 the data path takes the static route, not the OSPF one');
}

console.log('\nRemove the competing route and the mark moves:');
{
  const fresh = build(false);
  fresh.cli(fresh.r1, ['configure terminal', 'no ip route 10.0.99.0 255.255.255.0', 'exit']);
  const t2 = fresh.cli(fresh.r1, ['show ip route at converged']);
  const rows = rowsOf(t2).filter(function (r) { return r.prefix === '10.0.99.0/24'; });
  eq(rows.length, 1, 'with no static, only the OSPF route remains for that prefix');
  eq(rows[0].code, 'O', 'which is the OSPF row');
  eq(rows[0].star, true, 'and it is installed');
  ok(!/unmarked row loses/.test(t2), 'with nothing shadowed the note is gone');
}

console.log('\nA default route is a route like any other:');
{
  const lab2 = build(true);
  lab2.cli(lab2.r1, ['configure terminal', 'ip route 0.0.0.0 0.0.0.0 10.0.12.2', 'exit']);
  const rows = rowsOf(lab2.cli(lab2.r1, ['show ip route at converged']));
  const def = rows.filter(function (r) { return r.prefix === '0.0.0.0/0'; })[0];
  ok(!!def, 'the default route appears as 0.0.0.0/0');
  eq(def.code, 'S', 'with a static code');
  eq(def.star, true, 'and the installed marker');
  eq(def.ad, String(Device.ADMIN_DISTANCE.static), 'static distance, even for a default');
}

console.log('\nThe distances are one table, not two opinions:');
{
  // `routeTo()` breaks ties with these numbers; the table explains them with the same ones.
  eq(Device.ADMIN_DISTANCE.connected, 0, 'connected is 0');
  eq(Device.ADMIN_DISTANCE.static, 1, 'static is 1');
  ok(Device.ADMIN_DISTANCE.ebgp < Device.ADMIN_DISTANCE.ospf,
    'eBGP (20) outranks OSPF (110), so a BGP row can shadow an OSPF one');
  ok(Device.ADMIN_DISTANCE.ospf < Device.ADMIN_DISTANCE.ibgp, 'and OSPF (110) outranks iBGP (200)');
  // The data path itself obeys the ordering: a BGP-learned route beats OSPF for the same prefix.
  // No static here on purpose: static (1) outranks eBGP (20), so with one present the static route
  // would win and the BGP ordering would go untested.
  //
  // This used to *inject* a route into `r1.bgpRoutes` and read it back out of the table, which worked
  // only because a plain `show ip route` printed the table as it stood. A plain show now derives the
  // planes it displays, so the injected route is replaced by what BGP actually computes - which is the
  // better test anyway: the session is established and the prefix is learned, end to end.
  const bgp = build(false);
  runCommands(bgp.r1, bgp.t, bgp.sim, ['enable', 'configure terminal', 'router bgp 65001',
    'bgp router-id 1.1.1.1', 'bgp neighbor 10.0.12.2 remote-as 65002', 'exit', 'exit']);
  runCommands(bgp.r2, bgp.t, bgp.sim, ['enable', 'configure terminal', 'router bgp 65002',
    'bgp router-id 2.2.2.2', 'bgp neighbor 10.0.12.1 remote-as 65001', 'exit', 'exit']);
  // The data path reads the planes, so derive them before asking it directly: a console command would
  // have done this for us, and asking routeTo() with nothing computed is asking about an empty table.
  bgp.sim.refreshControlPlanes();
  const route = bgp.r1.routeTo('10.0.99.5');
  eq(route.type, 'bgp', 'with an OSPF route for the same prefix, the eBGP route wins');
  const rows = rowsOf(bgp.cli(bgp.r1, ['show ip route']));
  const b = rows.filter(function (r) { return r.code === 'B' && /10\.0\.99\.0/.test(r.prefix); })[0];
  ok(!!b, 'the learned prefix appears as a B row');
  eq(b.ad, '20', 'and the table reports its distance as 20');
  eq(b.star, true, 'marking it installed');
  // The OSPF row for the same prefix is there and unmarked: the shadow is stated, not hidden.
  const o = rows.filter(function (r) { return r.code === 'O' && /10\.0\.99\.0/.test(r.prefix); })[0];
  ok(!!o, 'the OSPF candidate for the same prefix is listed');
  eq(o.star, false, 'and it is not the installed route');
}

console.log('\nNothing about the data path changed:');
{
  const ping = lab.cli(lab.r1, ['ping 10.0.99.50']);
  match(/Success rate is 100 percent/, ping, 'the static path still forwards traffic to a host behind R2');
  const trace = lab.cli(lab.r1, ['traceroute 10.0.99.1 at converged']);
  ok(!/\*  \*  \*/.test(trace), 'and traceroute follows it');
}

console.log('\nThe command is still discoverable:');
{
  match(/show ip route \[<dest>\|connected/, lab.cli(lab.r1, ['?']),
    'help still advertises the destination and the instant');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
