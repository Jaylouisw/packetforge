'use strict';
// `ipv6 address fe80::1/64` is not a global address, and IOS refuses it.
//
// The `ipv6 address <addr>/<prefix>` form configures a **global** prefix. A link-local address is a
// different command, `ipv6 address <addr> link-local`, and the box says so when the two are mixed up:
//
//   R01(config-if)#ipv6 address FE80::1/64
//   % Link local requires link-local keyword
//   ...
//   R01(config-if)#ipv6 address 2001::2 link-local
//   % Invalid link-local address
//     (https://fastreroute.com/configure-verify-and-troubleshoot-ipv6-addressing/ - a live capture whose
//      running-config keeps `ipv6 address FE80::1 link-local`, no prefix length)
//
//   R887VAM(config-if)#ipv6 address link-local FE80::/10 eui-64
//   % Link local requires link-local keyword
//     (https://community.cisco.com/t5/ipv6/link-local-requires-link-local-keyword/td-p/3038567, IOS 15.5(3)M5)
//
// Cisco's command reference states the same split - "IPv6 link-local addresses must be configured and IPv6
// processing must be enabled on an interface by using the ipv6 address link-local command" - and RFC 4291
// section 2.5.6 puts the block at fe80::/10. research/ipv6-address-link-local-refusal.md has the table.
//
// This console used to store `fe80::1/64` as the interface's global address and then announce `fe80::/64`
// in its router advertisements with A=1: a promise that every host on the wire should form a link-local
// address from it. The tests below fix the door, the config, the report and the advertisement.
const path = require('path');
const { Topology, Simulator, runCommands, ipv6, ra } = require('../engine');
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
  return runCommands(dev, t, null, pre.concat(cmds));
}
function fresh() {
  const t = new Topology();
  const r1 = t.addDevice(spec('generic', 'generic-router'), 'r1');
  return { t: t, r1: r1 };
}
const REFUSAL = '% Link local requires link-local keyword';

// ---------------------------------------------------------------------------
// 1. The refusal, and what it leaves behind
// ---------------------------------------------------------------------------
console.log('`ipv6 address fe80::1/64` draws the box\'s own sentence:');
{
  const { t, r1 } = fresh();
  const res = cli(t, r1, ['interface Gi0/0', 'ipv6 address fe80::1/64']);
  eq(res.lines[res.lines.length - 2], REFUSAL, 'the vendor sentence is the answer');
  ok(/no manual form/.test(res.lines[res.lines.length - 1]),
    'and the console says why the keyword it names would not help', res.lines[res.lines.length - 1]);
  ok(!/^IPv6 address fe80::1\/64 on/.test(res.output), 'the command did not report success');

  eq(r1.config.ip6.Gi0, undefined, 'no global address was stored');
  const cfg = cli(t, r1, ['end', 'show running-config'], true).output;
  ok(cfg.indexOf('ipv6 address') === -1, 'and the config has no line to paste back', cfg);
  const show = cli(t, r1, ['end', 'show interfaces Gi0/0'], true).output;
  ok(!/^\s+ipv6:/.test(show.replace(/\r/g, '')),
    'so `show interfaces` prints no global IPv6 line', show);
  const nd = cli(t, r1, ['end', 'show ipv6 nd'], true).output;
  ok(nd.indexOf('fe80::/64') === -1, 'and no router advertisement carries a link-local prefix', nd);
  ok(/none - hosts would learn a default router only/.test(nd),
    'the advertisement promises no prefix at all', nd);
}

console.log('The same address without a prefix length is refused the same way:');
{
  const { t, r1 } = fresh();
  const res = cli(t, r1, ['interface Gi0/0', 'ipv6 address fe80::1']);
  eq(res.lines[res.lines.length - 2], REFUSAL, 'the sentence does not depend on the `/len`');
  eq(r1.config.ip6.Gi0, undefined, 'nothing was stored');
}

console.log('Every address of fe80::/10 is a link-local one:');
{
  for (const addr of ['fe90::1/64', 'fea0::1/64', 'febf::1/64', 'FE80::1/64']) {
    const { t, r1 } = fresh();
    const res = cli(t, r1, ['interface Gi0/0', 'ipv6 address ' + addr]);
    eq(res.lines[res.lines.length - 2], REFUSAL, addr + ' is refused as a global address');
    eq(r1.config.ip6.Gi0, undefined, addr + ' was not stored');
  }
  // The block ends at fec0::, so one address below it is an ordinary global one.
  const { t, r1 } = fresh();
  const res = cli(t, r1, ['interface Gi0/0', 'ipv6 address fe7f::1/64']);
  eq(res.lines[res.lines.length - 1], 'IPv6 address fe7f::1/64 on Gi0/0',
    'fe7f::1/64 is outside the block and is accepted');
  eq(r1.config.ip6['Gi0/0'] && r1.config.ip6['Gi0/0'].addr, 'fe7f::1', 'and stored as the global address');
}

// ---------------------------------------------------------------------------
// 2. The `link-local` keyword, which this model has no state for
// ---------------------------------------------------------------------------
console.log('A manual link-local is a real form this console does not keep:');
{
  const { t, r1 } = fresh();
  const gi0 = r1.interfaces.get('Gi0/0');
  const derived = ipv6.linkLocalFromMac(gi0.mac);
  const res = cli(t, r1, ['interface Gi0/0', 'ipv6 address fe80::1 link-local']);
  const line = res.lines[res.lines.length - 1];
  ok(/no manually configured link-local address/.test(line),
    'the console says the manual form is not modelled', line);
  ok(line.indexOf('Gi0/0') !== -1, 'it names the port', line);
  ok(line.indexOf(derived) !== -1, 'and the link-local the port really has (' + derived + ')', line);
  eq(r1.config.ip6.Gi0, undefined, 'the typed address was not stored as a global one');
  const cfg = cli(t, r1, ['end', 'show running-config'], true).output;
  ok(cfg.indexOf('ipv6 address') === -1, 'nothing was written to the config', cfg);
}

console.log('A global address with the keyword is not an address a box takes:');
{
  const { t, r1 } = fresh();
  const res = cli(t, r1, ['interface Gi0/0', 'ipv6 address 2001:db8::1/64 link-local']);
  eq(res.lines[res.lines.length - 1], '% Invalid link-local address', 'the vendor sentence is the answer');
  eq(r1.config.ip6.Gi0, undefined, 'and nothing was stored as a global address');
  const res2 = cli(t, r1, ['interface Gi0/0', 'ipv6 address 2001::2 link-local']);
  eq(res2.lines[res2.lines.length - 1], '% Invalid link-local address', 'the capture\'s own example agrees');
}

// ---------------------------------------------------------------------------
// 3. The global form still works, and is still advertised
// ---------------------------------------------------------------------------
console.log('A global address is unchanged, from the command to the wire:');
{
  const { t, r1 } = fresh();
  const res = cli(t, r1, ['interface Gi0/0', 'ipv6 address 2001:db8:1::1/64']);
  eq(res.lines[res.lines.length - 1], 'IPv6 address 2001:db8:1::1/64 on Gi0/0',
    'the command reports the address');
  eq(r1.config.ip6['Gi0/0'].addr, '2001:db8:1::1', 'it is stored on the interface');
  eq(r1.config.ip6['Gi0/0'].prefix, 64, 'with its prefix length');
  const cfg = cli(t, r1, ['end', 'show running-config'], true).output;
  ok(cfg.indexOf(' ipv6 address 2001:db8:1::1/64') !== -1, 'the config keeps the line', cfg);
  const nd = cli(t, r1, ['end', 'show ipv6 nd'], true).output;
  ok(nd.indexOf('2001:db8:1::/64') !== -1, 'and the advertisement carries the prefix', nd);
  ok(/2001:db8:1::\/64\s+1\s+1\s+/.test(nd), 'with L and A set', nd);
}

// ---------------------------------------------------------------------------
// 4. The advertisement builder never emits a link-local prefix, even for an old board
// ---------------------------------------------------------------------------
console.log('The prefix list refuses a link-local address it is handed (a board saved before the door):');
{
  const none = ra.addressPrefixes([{ addr: 'fe80::1', prefix: 64 }]);
  eq(none.length, 0, 'a fe80::/64 address contributes no prefix option');
  const mixed = ra.addressPrefixes([{ addr: 'fe80::1', prefix: 64 }, { addr: '2001:db8:1::1', prefix: 64 }]);
  eq(mixed.length, 1, 'the global address beside it still does');
  eq(mixed[0].prefix, '2001:db8:1::', 'and it is that prefix');
  eq(mixed[0].autonomous, true, 'with the autonomous flag');
}

// ---------------------------------------------------------------------------
// 5. A host cannot form an address from the refused prefix
// ---------------------------------------------------------------------------
console.log('A host on the wire learns nothing from the refused command:');
{
  const t = new Topology();
  const r1 = t.addDevice(spec('generic', 'generic-router'), 'r1');
  const h1 = t.addDevice(spec('generic', 'generic-pc'), 'h1');
  t.connect('r1', 'Gi0/0', 'h1', 'eth0');
  cli(t, r1, ['interface Gi0/0', 'ipv6 address fe80::1/64', 'ipv6 nd ra enable']);
  cli(t, h1, ['interface eth0', 'ipv6 address autoconfig']);
  const sim = new Simulator(t);
  sim.announceRa();
  const ras = sim.events.filter(function (e) {
    return e.type === 'frame' && e.from === 'r1' && e.frame && e.frame.nd && e.frame.nd.type === 'ra';
  });
  const sent = sim.events.filter(function (e) { return e.type === 'ra-send' && e.dev === r1.id; });
  eq(sent.length, 0, 'the port carries no IPv6 address, so it advertises nothing at all');
  eq(ras.length, 0, 'no prefix option reaches the wire');
  eq(Object.keys(h1.config.ip6).length, 0, 'and the host forms no address');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
