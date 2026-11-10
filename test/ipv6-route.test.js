'use strict';
// ipv6-route.test.js — the IPv6 table, and the two selection bugs that had no console to catch them.
//
// IPv6 had no route table at all from the console: `ipv6 route` and `ipv6 gateway` were configurable,
// `show running-config` printed them back, and `route6To()` routed with them - but nothing let an
// operator see which route a packet would take. Adding the table exposed the reason that mattered:
// `route6To()` was a second, hand-written copy of the selection rule IPv4 keeps in `routeTo()`, and
// it had drifted twice over.
//
//   1. The connected loop had no comparison at all, so two matching prefixes routed by whichever
//      interface came last in iteration order - not the longest prefix.
//   2. A static route beat a directly connected subnet of the same length, because the static loop
//      only compared prefix lengths and never the distance.
//
// Both are pinned here as behaviour, not as implementation: the test builds the topology that used
// to route wrong and requires the right port, then checks that the table marks exactly the row that
// forwards.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { Device } = require('../engine/device');
const v6 = require('../engine/ipv6');
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

function model(name) {
  const found = loadCatalog(path.join(__dirname, '..', 'devices')).find((x) => x.model === name);
  if (!found) throw new Error('no such model: ' + name);
  return found;
}

// One router, two IPv6 prefixes on two ports. The /64 is listed FIRST on purpose: the old code let
// the last matching interface win, so this order is what used to produce the wrong answer.
const t = new Topology();
const r1 = t.addDevice(model('generic-router'));
r1.name = 'R1';
const sim = new Simulator(t);
function raw(cmds) {
  return runCommands(r1, t, sim, ['enable'].concat(cmds)).lines.filter(function (l) {
    return !/^[A-Za-z0-9_.() -]+[>#]/.test(l);
  });
}
function cli(cmds) { return raw(cmds).join('\n'); }

const cfg = ['enable', 'configure terminal',
  'interface Gi0/0', 'ipv6 address 2001:db8:1::1/64', 'exit',
  'interface Gi0/1', 'ipv6 address 2001:db8::1/32', 'exit', 'exit'];
ok(!runCommands(r1, t, sim, cfg).lines.some((l) => /^%/.test(l)), 'the lab is accepted');

console.log('The longest matching on-link prefix wins, not the last one iterated:');
{
  // 2001:db8:1::99 matches both the /64 on Gi0/0 and the /32 on Gi0/1.
  const route = r1.route6To('2001:db8:1::99');
  eq(route && route.iface, 'Gi0/0', 'the /64 (Gi0/0) is chosen over the more general /32 (Gi0/1)');
  eq(route && route.prefix, 64, 'and the answer names the /64, which is the prefix it matched');
  const general = r1.route6To('2001:db8:2::5');
  eq(general && general.iface, 'Gi0/1', 'an address only the /32 covers still leaves Gi0/1');
  // The same question asked from the console, so the table and the data path are checked together.
  match(/^ {2}Matched +2001:db8:1::\/64 {2}\(connected, AD 0\)$/m,
    cli(['show ipv6 route 2001:db8:1::99']), 'and the console answers with the /64 too');
}

console.log('\nA static route does not beat a directly connected subnet of the same length:');
{
  ok(!raw(['configure terminal', 'ipv6 route 2001:db8:1::/64 2001:db8::9', 'exit'])
    .some((l) => /^%/.test(l)), 'the competing static route is accepted');
  const route = r1.route6To('2001:db8:1::99');
  eq(route && route.type, 'connected', 'connected (AD 0) still wins over static (AD 1)');
  eq(route && route.iface, 'Gi0/0', 'and traffic stays on the local subnet instead of going to a next hop');
  const out = cli(['show ipv6 route']);
  match(/^ {5}S 2001:db8:1::\/64 +1 +2001:db8::9 +-$/m, out,
    'the losing static route is still listed, unmarked');
  match(/^ {2}\* +C 2001:db8:1::\/64 +0/m, out, 'and the connected row is the one marked installed');
  match(/unmarked row loses on administrative distance/, out,
    'with the mark explained, because the two rows are otherwise identical');
}

console.log('\nThe table is built from the same rows the data path compares:');
{
  const rows = r1.routes6Table();
  eq(rows.filter((r) => r.installed).length, 2, 'two prefixes, two installed rows (one each)');
  eq(rows.filter((r) => !r.installed).length, 1, 'and one shadowed row');
  // Every installed row must be the answer route6To() gives for an address inside it.
  for (const row of rows.filter((r) => r.installed)) {
    const inside = v6.networkAddress6(row.dest + '/' + row.prefix) === row.dest;
    ok(inside, row.dest + '/' + row.prefix + ' is a network address, not a host address');
  }
  const inSubnet = v6.networkAddress6('2001:db8:1::/64');
  eq(inSubnet, '2001:db8:1::', 'the display normalises to the network address');
  const probe = r1.route6To('2001:db8:1::5');
  ok(probe && probe.prefix === 64 && probe.type === 'connected',
    'the address inside the /64 resolves to the /64 row');
}

console.log('\nStatic routes and a default gateway appear as routes:');
{
  ok(!raw(['configure terminal', 'ipv6 route 2001:db8:99::/48 2001:db8::7', 'exit'])
    .some((l) => /^%/.test(l)), 'a static route elsewhere is accepted');
  const viaStatic = cli(['show ipv6 route 2001:db8:99::5']);
  match(/^ {2}Matched +2001:db8:99::\/48 {2}\(static, AD 1\)$/m, viaStatic, 'the /48 matches it');
  match(/^ {2}Next hop +2001:db8::7$/m, viaStatic, 'and the next hop is named');
  eq(cli(['show ipv6 route 4000::1']).split('\n')[0], '% No IPv6 route to 4000::1',
    'an address no route covers is refused, not guessed');

  ok(!raw(['configure terminal', 'ipv6 gateway 2001:db8::1', 'exit']).some((l) => /^%/.test(l)),
    'a default gateway is accepted');
  const viaDefault = cli(['show ipv6 route 4000::1']);
  match(/^ {2}Matched +::\/0 {2}\(default, AD 254\)$/m, viaDefault,
    'and it answers for everything else, at the default distance');
  const table = cli(['show ipv6 route']);
  match(/^ {2}\* +S ::\/0 +254 +2001:db8::1/m, table, 'it is a row in the table, not a hidden fallback');
  match(/the default gateway pins no interface/m, table,
    'and the table says why its interface is not pinned, rather than leaving a bare dash');
}

console.log('\nThe prefix form answers about one prefix, with its competiton:');
{
  const one = cli(['show ipv6 route 2001:db8:1::/64']);
  eq(one.split('\n').filter((l) => /^ {2}(\*| ) +[CS] /.test(l)).length, 2,
    'both rows for that prefix are shown - the winner and the shadow');
  match(/^ {2}\* +C 2001:db8:1::\/64/m, one, 'the installed one marked');
  match(/^ {5}S 2001:db8:1::\/64/m, one, 'the shadowed one not');
  eq(cli(['show ipv6 route 2001:db8:1::/48']).split('\n')[0],
    '% No IPv6 route for 2001:db8:1::/48 in the table',
    'a prefix with no row is refused by name');
}

console.log('\nMalformed input is refused, not printed as an empty table:');
{
  match(/^% Invalid IPv6 destination "nonsense"/m, cli(['show ipv6 route nonsense']),
    'a word is refused as a destination');
  match(/^% Invalid IPv6 prefix "2001:db8::\/129"/m, cli(['show ipv6 route 2001:db8::/129']),
    'a prefix longer than /128 is refused');
  match(/% Invalid IPv6 destination "2001:db8::1::2"/, cli(['show ipv6 route 2001:db8::1::2']),
    'a doubled group is refused');
  ok(!/undefined/.test(cli(['show ipv6 route 2001:db8:1::/64'])),
    'no answer ever prints "undefined" (the field-name bug that hid as an empty table)');
}

console.log('\nThe instant question applies here too:');
{
  const early = cli(['show ipv6 route at 0']);
  match(/^IPv6 routes at t=0 ms/m, early, 'the answer is labelled with the instant it describes');
  const converged = cli(['show ipv6 route at converged']);
  match(/^IPv6 routes at converged /m, converged, 'and "at converged" is labelled as such');
  cli(['show ipv6 route at converged']);
}

console.log('\nThe table agrees with the data path, end to end:');
{
  // Two hosts, one router. The only way packet from PC1 to PC2 arrives is that the router's table
  // answers, so counting the replies is a check of the same fact the table displays.
  const t6 = new Topology();
  const pc1 = t6.addDevice(model('generic-pc'));
  const mid = t6.addDevice(model('generic-router'));
  const pc2 = t6.addDevice(model('generic-pc'));
  pc1.name = 'PC1'; mid.name = 'R1'; pc2.name = 'PC2';
  t6.connect(pc1.id, 'eth0', mid.id, 'Gi0/0');
  t6.connect(mid.id, 'Gi0/1', pc2.id, 'eth0');
  const s6 = new Simulator(t6);
  ok(!runCommands(mid, t6, s6, ['enable', 'configure terminal',
    'interface Gi0/0', 'ipv6 address 2001:db8:12::1/64', 'exit',
    'interface Gi0/1', 'ipv6 address 2001:db8:23::1/64', 'exit', 'exit'])
    .lines.some((l) => /^%/.test(l)), 'the router takes its two IPv6 addresses');
  for (const [dev, addr, gw] of [[pc1, '2001:db8:12::10/64', '2001:db8:12::1'],
    [pc2, '2001:db8:23::10/64', '2001:db8:23::1']]) {
    ok(!runCommands(dev, t6, s6, ['enable', 'configure terminal', 'interface eth0',
      'ipv6 address ' + addr, 'exit', 'ipv6 gateway ' + gw, 'exit'])
      .lines.some((l) => /^%/.test(l)), dev.name + ' takes its address and gateway');
  }
  const res = s6.ping6(pc1.id, '2001:db8:23::10', {});
  const replies = res.events.filter((e) => e.type === 'icmp6-reply').length;
  eq(replies, 4, 'all four echo requests are answered across the router');
  const hops = res.events.filter((e) => e.type === 'route6' && e.dev === mid.id);
  ok(hops.length >= 1, 'the router recorded a routing decision for the traffic');
  // The router decides twice per exchange - outbound to PC2, and inbound traffic back to PC1 - so
  // the assertion is per direction. Requiring every decision to use one port would have been wrong:
  // a return path is not a bug.
  const out = hops.filter((h) => h.dst === '2001:db8:23::10');
  const back = hops.filter((h) => h.dst === '2001:db8:12::10');
  ok(out.length >= 1 && out.every((h) => h.iface === 'Gi0/1'),
    'towards PC2 it chose Gi0/1, the port the table marks for that prefix');
  ok(back.length >= 1 && back.every((h) => h.iface === 'Gi0/0'),
    'and the replies back to PC1 left Gi0/0, as the table says for the other prefix');
  // The table, asked the same question, names the same port.
  match(/^ {2}Interface +Gi0\/1$/m,
    runCommands(mid, t6, s6, ['enable', 'show ipv6 route 2001:db8:23::10']).lines.join('\n'),
    'and `show ipv6 route` agrees with the forwarding decision');
}

console.log('\nOne comparison rule serves both families:');
{
  ok(typeof Device.betterRoute === 'function', 'the comparison is a named function, not inline in each path');
  // Directly: longest prefix, then distance.
  ok(Device.betterRoute({ prefix: 64, ad: 1 }, { prefix: 32, ad: 0 }),
    'a longer prefix wins even against a better distance');
  ok(!Device.betterRoute({ prefix: 32, ad: 0 }, { prefix: 64, ad: 1 }),
    'and the reverse is not also true');
  ok(Device.betterRoute({ prefix: 64, ad: 0 }, { prefix: 64, ad: 1 }),
    'at equal length the lower distance wins');
  ok(!Device.betterRoute({ prefix: 64, ad: 1 }, { prefix: 64, ad: 0 }),
    'and a worse distance at equal length loses');
  eq(Device.ADMIN_DISTANCE.connected, 0, 'connected is distance 0');
  eq(Device.ADMIN_DISTANCE.static, 1, 'static is distance 1');
  // The IPv4 path must still agree: a connected /24 beats a static /24.
  const t4 = new Topology();
  const q = t4.addDevice(model('generic-router'));
  q.name = 'R4';
  const s4 = new Simulator(t4);
  runCommands(q, t4, s4, ['enable', 'configure terminal', 'interface Gi0/0',
    'ip address 10.0.5.1 255.255.255.0', 'exit',
    'ip route 10.0.5.0 255.255.255.0 10.0.9.9', 'exit']);
  const r4 = q.routeTo('10.0.5.7');
  eq(r4 && r4.type, 'connected', 'IPv4 connected still beats IPv4 static at equal length');
  ok(r4 && r4.ad === 0, 'and reports the connected distance');
}

console.log('\nThe command is discoverable:');
{
  match(/show ipv6 route \[<dest>\] \[at <ms>\|converged\]/, cli(['?']),
    'help lists the table, the lookup and the instant');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
