'use strict';
// ipv6-ra-default.test.js -- advertising is what a router does, not something you switch on.
//
// The console used to keep a router silent until somebody typed `ipv6 nd ra enable`, and
// printed "Advertise : disabled  (ipv6 nd ra enable to start)" on a device that had never
// touched IPv6 router advertisement at all. No Cisco box behaves that way: the command
// reference for `ipv6 nd ra suppress` gives its Command Default as "IPv6 router
// advertisements are automatically sent on Ethernet and FDDI interfaces if IPv6 unicast
// routing is enabled on the interfaces", and the `show ipv6 interface` sample on a freshly
// addressed port already prints "ND router advertisements are sent every 200 seconds".
// Suppression is the verb; enabling is the state you are in before you touch anything.
//
// research/ipv6-ra-default.md holds the citations. These tests pin the four faces of the
// rule: a fresh router advertises, the report says it is the default, the off switch is
// the only line a config owns, and a port that carries no IPv6 address says nothing.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
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

// One router, one host, one cable. Nothing in this lab says `ipv6 nd ra enable`.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(spec('generic', 'generic-router'));
  const h1 = t.addDevice(spec('generic', 'generic-pc'));
  r1.name = 'R1'; h1.name = 'H1';
  t.connect(r1.id, 'Gi0/0', h1.id, 'eth0');
  cli(t, r1, ['interface Gi0/0', 'ipv6 address 2001:db8:aa::1/64',
    'ipv6 nd prefix 2001:db8:aa::/64']);
  cli(t, h1, ['interface eth0', 'ipv6 address autoconfig']);
  return { t: t, r1: r1, h1: h1 };
}

console.log('A router with an addressed port advertises without being asked:');
{
  const env = lab();
  eq(env.r1.config.ra.enabled, true, 'the stored policy is "on" although nobody typed an enable');
  const sim = new Simulator(env.t);
  sim.announceRa();
  const sent = sim.events.filter(function (e) {
    return e.type === 'ra-send' && e.dev === env.r1.id && !e.solicited;
  });
  eq(sent.length, 1, 'exactly one unsolicited advertisement left R1');
  eq(sent[0].prefixes.join(','), '2001:db8:aa::/64', 'carrying the prefix configured on the port');
  const learned = sim.events.filter(function (e) {
    return e.type === 'slaac-address' && e.dev === env.h1.id && e.addr;
  });
  ok(learned.length >= 1 && learned[0].prefixSource === '2001:db8:aa::/64',
    'and H1 formed an address from it (' + (learned[0] && learned[0].addr) + ')');
  ok(!!(env.h1.config.ip6.eth0 && env.h1.config.ip6.eth0.autoconfig),
    'with no human-configured IPv6 address anywhere in the lab');
}

console.log('\nThe report says which policy it is running, and why:');
{
  const env = lab();
  const out = cli(env.t, env.r1, ['show ipv6 nd'], true).join('\n');
  ok(/Advertise\s+: enabled\s+\(the default/.test(out),
    'show ipv6 nd prints "enabled (the default", not a bare "enabled"');
  ok(!/ra enable to start/.test(out), 'and does not send the reader looking for an enable step');
  const cfg = cli(env.t, env.r1, ['show running-config'], true).join('\n');
  ok(!/ipv6 nd ra enable/.test(cfg), 'the default is not a line the running-config owns');
  ok(/ipv6 nd prefix 2001:db8:aa::\/64/.test(cfg), 'the prefix the operator typed is still printed');
}

console.log('\nThe off switch is the only RA line a config owns:');
{
  const env = lab();
  let out = cli(env.t, env.r1, ['ipv6 nd ra disable']).join(' ');
  ok(/router advertisements disabled/.test(out), '"ipv6 nd ra disable" is accepted');
  const cfg = cli(env.t, env.r1, ['show running-config'], true).join('\n');
  ok(/^ipv6 nd ra disable$/m.test(cfg), 'and is printed as the line that reproduces this box');

  const sim = new Simulator(env.t);
  sim.announceRa();
  eq(sim.events.filter(function (e) { return e.type === 'ra-send' && e.dev === env.r1.id; }).length, 0,
    'a disabled router puts no advertisement on the wire');
  eq(sim.events.filter(function (e) { return e.type === 'slaac-address' && e.dev === env.h1.id; }).length, 0,
    'so the host stays unaddressed');

  out = cli(env.t, env.r1, ['show ipv6 nd'], true).join('\n');
  ok(/Advertise\s+: disabled/.test(out), 'show ipv6 nd reports it as disabled');

  cli(env.t, env.r1, ['no ipv6 nd ra disable']);
  eq(env.r1.config.ra.enabled, true, '"no ipv6 nd ra disable" turns advertising back on');
  const cfg2 = cli(env.t, env.r1, ['show running-config'], true).join('\n');
  ok(!/ipv6 nd ra disable/.test(cfg2), 'and the line leaves the config again');
}

console.log('\nA port that carries no IPv6 address advertises nothing:');
{
  const t = new Topology();
  const r1 = t.addDevice(spec('generic', 'generic-router'));
  const h1 = t.addDevice(spec('generic', 'generic-pc'));
  r1.name = 'R1'; h1.name = 'H1';
  t.connect(r1.id, 'Gi0/0', h1.id, 'eth0');
  const sim = new Simulator(t);
  sim.announceRa();
  eq(sim.events.filter(function (e) { return e.type === 'ra-send' && e.dev === r1.id; }).length, 0,
    'an IPv4-only router sends no advertisement, even with advertising at its default');
}

console.log('\nSuppression still answers the host that asks:');
{
  const env = lab();
  cli(env.t, env.r1, ['ipv6 nd suppress-ra']);
  const sim = new Simulator(env.t);
  sim.announceRa();
  eq(sim.events.filter(function (e) { return e.type === 'ra-send' && e.dev === env.r1.id && !e.solicited; }).length, 0,
    'no periodic advertisement is sent while suppressed');
  ok(sim.events.some(function (e) { return e.type === 'ra-send' && e.dev === env.r1.id && e.solicited; }),
    'but the solicitation from H1 is answered');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
