'use strict';
// A hardware address is printed the way the device prints it: 0200.0000.000a, never 02:00:00:00:00:0a.
//
// The engine stores, compares and hashes MACs colon-separated (`net.intToMac`), and every table it printed
// echoed that storage form straight back at the reader: `show ip arp`, `show mac address-table`, the `MAC`
// on a `show interfaces <port>` block, and the VRRP virtual MAC. An IOS-family console writes a hardware
// address as three dotted quartets instead. The Catalyst 2960 command reference spells the argument "the
// valid format is H.H.H." and prints `0002.4b28.c482`; Cisco's ARP chapter prints `001b.53e1.7201` with the
// documented note that a hyphen in Age means the address is local; `show vrrp detail` prints
// `Virtual MAC address is 0000.5e00.010a`.
//
// Both forms are the same 48 bits, so this is a display rule and nothing else. The tests below pin both
// halves of that: what a reader sees, and what the engine still holds (colon, everywhere internally), plus
// a cell that is not a hardware address at all - which must not be printed as 0000.0000.0000.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const net = require('../engine/net');
const vrrp = require('../engine/vrrp');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function eq(got, want, msg) { ok(got === want, msg, JSON.stringify(got) + ' !== ' + JSON.stringify(want)); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];
const DOTTED = /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/;

function dottedOf(mac) { return net.intToMacDotted(net.macToInt(mac)); }

// One router, one switch, one host: a ping makes the router learn the host's MAC for `show arp` and makes
// the switch learn it for `show mac address-table`.
function lab() {
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r1');
  const sw = t.addDevice(SWITCH, 'sw');
  const pc = t.addDevice(PC, 'pc');
  const rPort = [...r.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; })[0].name;
  t.connect('r1', rPort, 'sw', 'Fa0/1');
  t.connect('pc', 'eth0', 'sw', 'Fa0/2');
  const sim = new Simulator(t);
  runCommands(r, t, sim, ['configure terminal', 'interface ' + rPort,
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end']);
  runCommands(pc, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'end']);
  sim.ping('pc', '10.0.0.1', { count: 1 });
  sim.ping('r1', '10.0.0.9', { count: 1 });
  return { t: t, sim: sim, r: r, sw: sw, pc: pc, rPort: rPort };
}

function lines(env, dev, cmd) {
  return ((new CliSession(dev, env.t, env.sim).run(cmd).output) || []).map(String);
}
function fields(line) { return String(line).trim().split(/\s+/); }

console.log('');
console.log('The form itself: three dotted quartets, lower case, from any spelling of the same 48 bits');
{
  eq(net.formatMac('02:00:00:00:00:0a'), '0200.0000.000a', 'a stored colon MAC prints dotted');
  eq(net.formatMac('0200.0000.000A'), '0200.0000.000a', 'an upper-case dotted MAC prints lower case');
  eq(net.formatMac('02000000000a'), '0200.0000.000a', 'a bare 12-digit hex MAC prints dotted');
  eq(net.intToMacDotted(net.macToInt('00:00:5e:00:01:0a')), '0000.5e00.010a',
    'the VRRP virtual MAC is 0000.5e00.010a, the documented rendering');
  eq(net.macToInt('0200.0000.000a'), net.macToInt('02:00:00:00:00:0a'),
    'the dotted and colon forms are the same 48 bits');
  eq(net.intToMac(net.macToInt('0200.0000.000a')), '02:00:00:00:00:0a',
    'and the canonical storage form is still colon-separated');
  eq(net.formatMac('-'), '-', 'a cell that is not a hardware address is passed through, not zeroed');
  eq(net.formatMac(''), '', 'including an empty one');
  ok(DOTTED.test(net.formatMac('aa:bb:cc:dd:ee:05')), 'letters still fit the dotted shape');
}

console.log('');
console.log('`show arp` prints the Hardware Addr column dotted');
{
  const env = lab();
  const rows = lines(env, env.r, 'show arp');
  const row = rows.filter(function (l) { return fields(l)[1] === '10.0.0.9'; })[0] || '';
  const f = fields(row);
  ok(row !== '', 'the host the router pinged is in the cache', rows.join(' | '));
  ok(DOTTED.test(f[3] || ''), 'and its hardware address is dotted', f.join(' '));
  eq(f[3], dottedOf(env.pc.interfaces.get('eth0').mac), 'it is that host address, not a placeholder');
  ok(f[3].indexOf(':') === -1, 'no colon survives in the printed address', f[3]);
}

console.log('');
console.log('`show mac address-table` prints the Mac Address column the same way');
{
  const env = lab();
  const rows = lines(env, env.sw, 'show mac address-table');
  const row = rows.filter(function (l) { return fields(l)[4] === 'Fa0/2'; })[0] || '';
  const f = fields(row);
  ok(row !== '', 'the host is learned on the port it is plugged into', rows.join(' | '));
  ok(DOTTED.test(f[1] || ''), 'the address column is dotted', f.join(' '));
  eq(f[1], dottedOf(env.pc.interfaces.get('eth0').mac), 'and it is the host address');
}

console.log('');
console.log('The engine still holds and compares the colon form - this is a display rule only');
{
  const env = lab();
  const held = env.r.arp.get('10.0.0.9');
  ok(/:/.test(held), 'the ARP table is keyed and stored colon-separated', String(held));
  eq(held, net.normalizeMac(env.pc.interfaces.get('eth0').mac),
    'and the stored value is the normalised MAC, unchanged by the printing rule');
  const keys = [...env.sw.macTable.keys()];
  ok(keys.some(function (k) { return /:/.test(k); }), 'the switch MAC table is keyed colon-separated too', String(keys));
  eq(env.sw.macLookup(1, held, env.sim.runAtMs), 'Fa0/2', 'and the port lookup by that key is unchanged');
}

console.log('');
console.log('`show interfaces <port>` prints its MAC in the same form');
{
  const env = lab();
  const rows = lines(env, env.r, 'show interfaces ' + env.rPort);
  const head = rows.filter(function (l) { return /, MAC /.test(l); })[0] || '';
  const mac = (/MAC (\S+)/.exec(head) || [])[1] || '';
  eq(mac, dottedOf(env.r.interfaces.get(env.rPort).mac), 'the port block names its own address, dotted');
  ok(DOTTED.test(mac), 'and it is a hardware address, not a bare number', mac);
}

console.log('');
console.log('The VRRP table prints the virtual MAC dotted, as `show vrrp detail` does');
{
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r1');
  const port = [...r.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; })[0].name;
  const sim = new Simulator(t);
  runCommands(r, t, sim, ['configure terminal', 'interface ' + port,
    'ip address 10.0.0.1 255.255.255.0', 'vrrp 10 ip 10.0.0.254', 'no shutdown', 'end']);
  sim.computeVrrp();
  const rows = ((new CliSession(r, t, sim).run('show vrrp').output) || []).map(String);
  const f = fields(rows.filter(function (l) { return fields(l)[1] === '10'; })[0] || '');
  eq(f[6], '0000.5e00.010a', 'VRID 10 prints 0000.5e00.010a, the vendor sample rendering');
  eq(f[6], net.formatMac(vrrp.virtualMac(10)), 'and it is the MAC the election decided, printed');
}

console.log('');
console.log((failed ? '\u2717 ' : '\u2713 ') + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
