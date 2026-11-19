'use strict';
// A router advertises the /64 it holds as an address - no `ipv6 nd prefix` needed.
//
// Cisco's `ipv6 nd prefix` reference states the default in its Usage Guidelines:
//
//   "By default, prefixes configured as addresses on an interface using the
//    ipv6 address command are advertised in router advertisements."
//
// and gives the lifetimes this model already defaults to: 2,592,000 s valid,
// 604,800 s preferred, with the on-link and autoconfiguration flags set. The
// simulator built its advertisement from `config.ra.prefixes` alone, so a router
// with `ipv6 address 2001:db8:1::1/64` and nothing else advertised a default
// router and no prefix: a host on the wire learned a gateway and could not form
// an address, which is the opposite of what IPv6 does out of the box.
//
// research/ipv6-ra-advertises-interface-prefix.md has the sources, the vendor
// sentence that argues for replacing every automatic prefix with the configured
// ones, and why the additive reading was adopted.
const path = require('path');
const { Topology, Simulator, runCommands, ipv6 } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')');
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(vendor, model) {
  const s = catalog.find(function (x) { return x.vendor === vendor && x.model === model; });
  if (!s) throw new Error('missing spec ' + vendor + '/' + model);
  return s;
}

function cli(t, dev, cmds, exec) {
  const pre = exec ? ['enable'] : ['enable', 'configure terminal'];
  return runCommands(dev, t, null, pre.concat(cmds)).lines;
}

function raFrames(sim, devId) {
  return sim.events.filter(function (e) {
    return e.type === 'frame' && e.from === devId && e.frame && e.frame.nd && e.frame.nd.type === 'ra';
  }).map(function (e) { return e.frame.nd.ra; });
}

// ---------------------------------------------------------------------------
// 1. The default: an interface address is a prefix announcement
// ---------------------------------------------------------------------------
console.log('A router with an address and no `ipv6 nd prefix` still announces the prefix:');
const t = new Topology();
const r1 = t.addDevice(spec('generic', 'generic-router'), 'r1');
const h1 = t.addDevice(spec('generic', 'generic-pc'), 'h1');
t.connect('r1', 'Gi0/0', 'h1', 'eth0');
cli(t, r1, ['interface Gi0/0', 'ipv6 address 2001:db8:1::1/64']);
cli(t, h1, ['interface eth0', 'ipv6 address autoconfig']);

ok(!/ipv6 nd prefix/.test(cli(t, r1, [], true).join('\n')),
  'the router has no `ipv6 nd prefix` line anywhere in its configuration');
eq(r1.config.ra, null, 'and stores no router-advertisement configuration at all');

const sim = new Simulator(t);
sim.announceRa();

const sent = sim.events.filter(function (e) { return e.type === 'ra-send' && e.dev === r1.id; });
eq(sent.length, 2, 'R1 sent an unsolicited advertisement and answered the solicitation');
ok(sent.every(function (e) { return e.prefixes.join(',') === '2001:db8:1::/64'; }),
  'every advertisement carried the interface address\'s own /64',
  JSON.stringify(sent.map(function (e) { return e.prefixes; })));

const ra = raFrames(sim, r1.id)[0];
ok(!!ra, 'the advertisement was really encoded and decoded on the wire');
eq(ra && ra.prefixes.length, 1, 'one prefix information option');
eq(ra && ra.prefixes[0].prefix, '2001:db8:1::', 'the option carries the network, not the host address');
eq(ra && ra.prefixes[0].prefixLen, 64, 'with the /64');
eq(ra && ra.prefixes[0].onLink, true, 'L is set');
eq(ra && ra.prefixes[0].autonomous, true, 'A is set');
eq(ra && ra.prefixes[0].validLifetime, 2592000, 'valid lifetime is the vendor default (30 days)');
eq(ra && ra.prefixes[0].preferredLifetime, 604800, 'preferred lifetime is the vendor default (7 days)');

const h1Mac = h1.interfaces.get('eth0').mac;
const want = ipv6.formatIpv6(ipv6.parseIpv6('2001:db8:1::').groups.slice(0, 4).concat(
  ipv6.eui64FromMac(h1Mac).split(':').map(function (x) { return parseInt(x, 16); })));
eq(h1.config.ip6.eth0 && h1.config.ip6.eth0.addr, want, 'H1 formed ' + want + ' with nothing typed on it');
eq(h1.config.ip6.eth0 && h1.config.ip6.eth0.validLifetime, 2592000, 'and took the advertised valid lifetime');
eq(h1.config.ip6.eth0 && h1.config.ip6.eth0.preferredLifetime, 604800, 'and the preferred one');

console.log('\nThe console report names the same prefix and where it came from:');
const report = cli(t, r1, ['show ipv6 nd'], true).join('\n');
ok(/Prefixes\s+: 1\s+\(1 from an interface address\)/.test(report),
  'one prefix, marked as coming from an interface address', report);
ok(/2001:db8:1::\/64\s+1\s+1\s+2592000\s+604800\s+interface address/.test(report),
  'the row carries L=1 A=1, both lifetimes and the provenance', report);
ok(/Interfaces\s+: Gi0\/0 \(2001:db8:1::\/64\)/.test(report),
  'and says which port it would leave by', report);

// ---------------------------------------------------------------------------
// 2. An explicit entry replaces its own prefix and only its own prefix
// ---------------------------------------------------------------------------
console.log('\n`ipv6 nd prefix` for the same prefix overrides the parameters, not the prefix:');
cli(t, r1, ['ipv6 nd prefix 2001:db8:1::/64 valid 100 preferred 50']);
const sim2 = new Simulator(t);
sim2.announceRa();
const ra2 = raFrames(sim2, r1.id)[0];
eq(ra2 && ra2.prefixes.length, 1, 'still one prefix option, not a duplicate');
eq(ra2 && ra2.prefixes[0].validLifetime, 100, 'the configured valid lifetime wins');
eq(ra2 && ra2.prefixes[0].preferredLifetime, 50, 'and the configured preferred lifetime');
const report2 = cli(t, r1, ['show ipv6 nd'], true).join('\n');
ok(/2001:db8:1::\/64\s+1\s+1\s+100\s+50\s+configured/.test(report2),
  'the report marks the row as configured', report2);

console.log('\nAn explicit prefix for another link does not withdraw the interface\'s own:');
cli(t, r1, ['ipv6 nd prefix 2001:db8:99::/64']);
const sim3 = new Simulator(t);
sim3.announceRa();
const ra3 = raFrames(sim3, r1.id)[0];
ok(ra3 && ra3.prefixes.some(function (p) { return p.prefix === '2001:db8:1::'; }),
  'the automatic /64 is still advertised',
  JSON.stringify(ra3 && ra3.prefixes.map(function (p) { return p.prefix; })));
ok(ra3 && !ra3.prefixes.some(function (p) { return p.prefix === '2001:db8:99::'; }),
  'and the unrelated prefix is not put on a link that does not hold it');

console.log('\nWithdrawing the explicit line hands the prefix back to the address:');
cli(t, r1, ['no ipv6 nd prefix 2001:db8:1::/64', 'no ipv6 nd prefix 2001:db8:99::/64']);
const sim4 = new Simulator(t);
sim4.announceRa();
const ra4 = raFrames(sim4, r1.id)[0];
eq(ra4 && ra4.prefixes.length, 1, 'one prefix again');
eq(ra4 && ra4.prefixes[0].validLifetime, 2592000, 'with the default lifetimes restored');

// ---------------------------------------------------------------------------
// 3. What is NOT derived
// ---------------------------------------------------------------------------
console.log('\nA router with no IPv6 address advertises no prefix:');
const t2 = new Topology();
const r2 = t2.addDevice(spec('generic', 'generic-router'), 'r2');
const h2 = t2.addDevice(spec('generic', 'generic-pc'), 'h2');
t2.connect('r2', 'Gi0/0', 'h2', 'eth0');
cli(t2, h2, ['interface eth0', 'ipv6 address autoconfig']);
const sim5 = new Simulator(t2);
sim5.announceRa();
eq(sim5.events.filter(function (e) { return e.type === 'ra-send' && e.dev === r2.id; }).length, 0,
  'no advertisement leaves a port with no IPv6 address at all');

console.log('\nA /48 address is not turned into a /64 announcement:');
const t3 = new Topology();
const r3 = t3.addDevice(spec('generic', 'generic-router'), 'r3');
const h3 = t3.addDevice(spec('generic', 'generic-pc'), 'h3');
t3.connect('r3', 'Gi0/0', 'h3', 'eth0');
cli(t3, r3, ['interface Gi0/0', 'ipv6 address 2001:db8:48::1/48']);
cli(t3, h3, ['interface eth0', 'ipv6 address autoconfig']);
const sim6 = new Simulator(t3);
sim6.announceRa();
const sent6 = sim6.events.filter(function (e) { return e.type === 'ra-send' && e.dev === r3.id; });
ok(sent6.length > 0, 'the router still announces itself as a default router');
ok(sent6.every(function (e) { return e.prefixes.length === 0; }),
  'but carries no prefix option - a host cannot SLAAC from a /48',
  JSON.stringify(sent6.map(function (e) { return e.prefixes; })));
eq(h3.config.ip6.eth0, undefined, 'so H3 forms no address');

console.log('\nA host\'s own report is unchanged: it advertises nothing:');
const hostReport = cli(t, h1, ['show ipv6 nd'], true).join('\n');
ok(/Prefixes\s+: none - hosts would learn a default router only/.test(hostReport),
  'a non-l3-forward device still lists no prefixes', hostReport);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
