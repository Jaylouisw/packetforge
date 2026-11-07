'use strict';
// Proves IPv6 is wired into the forwarding path: real neighbour discovery
// (solicited-node multicast, NS/NA) and ICMPv6 echo, on-link and routed.
const path = require('path');
const { Topology, Simulator, runCommands, ipv6 } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  \u2713 ' + msg); } else { failed++; console.error('  \u2717 ' + msg); } }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(vendor, model) {
  const s = catalog.find(function (x) { return x.vendor === vendor && x.model === model; });
  if (!s) throw new Error('missing spec ' + vendor + '/' + model);
  return s;
}

// ---------------------------------------------------------------------------
// Part 1: on-link IPv6 across a switch, resolved by neighbour discovery only
// ---------------------------------------------------------------------------
const t = new Topology();
function cli(dev, cmds, exec) {
  const pre = exec ? ['enable'] : ['enable', 'configure terminal'];
  return runCommands(dev, t, null, pre.concat(cmds)).lines;
}

const sw = t.addDevice(spec('generic', 'generic-switch'));
const pc1 = t.addDevice(spec('generic', 'generic-pc'));
const pc2 = t.addDevice(spec('generic', 'generic-pc'));
sw.name = 'SW1'; pc1.name = 'PC1'; pc2.name = 'PC2';

t.connect(pc1.id, 'eth0', sw.id, 'Fa0/1');
t.connect(pc2.id, 'eth0', sw.id, 'Fa0/2');

console.log('IPv6 addressing through the CLI:');
const o1 = cli(pc1, ['interface eth0', 'ipv6 address 2001:DB8:1:0:0:0:0:10/64']);
ok(/IPv6 address 2001:db8:1::10\/64 on eth0/.test(o1.join(' ')), 'CLI accepts an IPv6 address and canonicalises it');
ok(pc1.config.ip6.eth0.addr === '2001:db8:1::10', 'address stored compressed');
ok(pc1.config.ip6.eth0.prefix === 64, 'prefix length stored');
const o2 = cli(pc1, ['interface eth0', 'ipv6 address 2001:db8:1::zz/64']);
ok(/% Invalid IPv6 address/.test(o2.join(' ')), 'a malformed address is rejected');
cli(pc2, ['interface eth0', 'ipv6 address 2001:db8:1::20/64']);

console.log('\nLink-local addresses are derived from the MAC (EUI-64):');
const ll = pc1.linkLocal6(pc1.interfaces.get('eth0'));
ok(/^fe80::/.test(ll), 'PC1 eth0 has a link-local address (' + ll + ')');
ok(ipv6.isLinkLocal(ll), 'and it is in fe80::/10');
ok(ll === ipv6.linkLocalFromMac(pc1.interfaces.get('eth0').mac), 'it matches the EUI-64 derivation');
ok(pc1.linkLocal6(pc1.interfaces.get('eth0')) !== pc2.linkLocal6(pc2.interfaces.get('eth0')), 'different MACs give different link-locals');

console.log('\nNeighbour discovery puts the solicited-node MAC on the wire:');
let sim = new Simulator(t);
const snm = sim._snmMac('2001:db8:1::20');
ok(snm === '33:33:ff:' + '00:00:20', 'solicited-node MAC is 33:33:ff + low 24 bits (' + snm + ')');

let res = sim.ping6(pc1.id, '2001:db8:1::20', { count: 1 });
ok(res.replies[0].success === true, 'ping6 PC1 -> PC2 succeeds on-link');
const nsEv = res.events.filter(function (e) { return e.type === 'nd-request'; })[0];
ok(!!nsEv, 'a neighbour solicitation was sent');
ok(nsEv && nsEv.mac === snm, 'the NS went to the solicited-node multicast MAC');
const naEv = res.events.filter(function (e) { return e.type === 'nd-advert'; })[0];
ok(!!naEv, 'PC2 answered with a neighbour advertisement');
ok(naEv && naEv.dev === pc2.id, 'the advert came from PC2');
const cacheEv = res.events.filter(function (e) { return e.type === 'nd-cache'; })[0];
ok(!!cacheEv, 'PC1 learned the mapping');
ok(sim._ndTable(pc1).get('2001:db8:1::20') === pc2.interfaces.get('eth0').mac, 'ND cache holds PC2 MAC');
const echoEv = res.events.filter(function (e) { return e.type === 'icmp6-echo'; })[0];
ok(!!echoEv, 'PC2 saw an ICMPv6 echo request');
ok(echoEv && echoEv.from === '2001:db8:1::10', 'the request carried PC1 global source, not link-local');

console.log('\nAnd the cache is used afterwards (no second NS):');
res = sim.ping6(pc1.id, '2001:db8:1::20', { count: 1 });
ok(res.replies[0].success === true, 'second ping6 succeeds');
ok(res.events.filter(function (e) { return e.type === 'nd-request'; }).length === 0, 'no new NS was needed');

console.log('\nA different prefix has no route:');
res = sim.ping6(pc1.id, '2001:db8:99::1', { count: 1 });
ok(res.replies[0].success === false, 'ping6 to an unrouted prefix fails');
ok(res.events.some(function (e) { return e.type === 'drop' && /no IPv6 route/.test(e.reason || ''); }), 'and reports "no IPv6 route"');

console.log('\nLink-local destination works:');
res = sim.ping6(pc1.id, pc2.linkLocal6(pc2.interfaces.get('eth0')), { count: 1 });
ok(res.replies[0].success === true, 'ping6 to a link-local address succeeds');

// ---------------------------------------------------------------------------
// Part 2: routed IPv6 across a router with two /64s
// ---------------------------------------------------------------------------
const t2 = new Topology();
function cli2(dev, cmds, exec) {
  const pre = exec ? ['enable'] : ['enable', 'configure terminal'];
  return runCommands(dev, t2, null, pre.concat(cmds)).lines;
}
const r1 = t2.addDevice(spec('generic', 'generic-router'));
const h1 = t2.addDevice(spec('generic', 'generic-pc'));
const h2 = t2.addDevice(spec('generic', 'generic-pc'));
r1.name = 'R1'; h1.name = 'H1'; h2.name = 'H2';
t2.connect(h1.id, 'eth0', r1.id, 'Gi0/0');
t2.connect(h2.id, 'eth0', r1.id, 'Gi0/1');

cli2(h1, ['interface eth0', 'ipv6 address 2001:db8:aa::1/64', 'exit', 'ipv6 gateway 2001:db8:aa::ff']);
cli2(h2, ['interface eth0', 'ipv6 address 2001:db8:bb::1/64', 'exit', 'ipv6 gateway 2001:db8:bb::ff']);
cli2(r1, ['interface Gi0/0', 'ipv6 address 2001:db8:aa::ff/64', 'exit',
  'interface Gi0/1', 'ipv6 address 2001:db8:bb::ff/64']);

console.log('\nRouted IPv6 (two /64s, no static routes needed on the router):');
ok(r1.route6To('2001:db8:bb::1').type === 'connected', 'R1 sees 2001:db8:bb::/64 as connected');
ok(h1.route6To('2001:db8:bb::1').type === 'default6', 'H1 falls back to its IPv6 default gateway');

const sim2 = new Simulator(t2);
res = sim2.ping6(h1.id, '2001:db8:bb::1', { count: 2 });
ok(res.replies.every(function (r) { return r.success; }), 'ping6 H1 -> H2 succeeds across the router');
const rtEv = res.events.filter(function (e) { return e.type === 'route6'; })[0];
ok(!!rtEv, 'R1 logged an IPv6 route event');
ok(rtEv && rtEv.hopLimit === 63, 'hop limit was decremented to 63 (got ' + (rtEv && rtEv.hopLimit) + ')');

console.log('\nStatic IPv6 routes and validation:');
const o3 = cli2(r1, ['ipv6 route 2001:db8:cc::/64 2001:db8:aa::1']);
ok(/IPv6 route 2001:db8:cc::\/64 via 2001:db8:aa::1/.test(o3.join(' ')), 'CLI accepts "ipv6 route"');
ok(r1.config.routes6.length === 1, 'route stored');
const o4 = cli2(r1, ['ipv6 route 2001:db8:cc::/129 2001:db8:aa::1']);
ok(/% Invalid IPv6 prefix/.test(o4.join(' ')), 'a /129 prefix is rejected');
const o5 = cli2(r1, ['ipv6 route 2001:db8:cc::/64 not-an-address']);
ok(/% Invalid IPv6 next hop/.test(o5.join(' ')), 'a bad next hop is rejected');
ok(r1.route6To('2001:db8:cc::9').type === 'static6', 'the static route is used');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
