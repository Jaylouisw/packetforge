'use strict';
// A command word may be shortened inside `(config-if)#` too: `ip add`, `sw mo acc`, `no shut`.
//
// The vendor states the rule for "commands and keywords" without limiting it to one mode - "You can abbreviate
// commands and keywords to the number of characters that allow a unique abbreviation" (Cisco IOS XE 16
// Fundamentals Configuration Guide, Using the Cisco IOS Command-Line Interface):
//   https://cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/configuration/xe-16/fundamentals-xe-16-book/cf-cli-basics.html
// and operators use it there more than anywhere else, because an interface block is where a session is spent:
//
//   SW2950(config)#int vlan1
//   SW2950(config-if)#ip add 192.168.1.2 255.255.255.0
//   SW2950(config-if)no shut
//   https://community.cisco.com/t5/switching/cisco-2950-switch/td-p/1007218
//
//   Rack1R1(config-if)#ip add 0.0.0.1 255.255.255.0
//   https://community.cisco.com/t5/switching/what-is-the-lowest-prefix-possible-and-the-lowest-ip/td-p/1214384
//
//   R1(config-subif)#no ip add        (and `ip na` -> `ip nat`, `ip nat ou` -> `ip nat outside`)
//   https://community.cisco.com/t5/switching/cisco-887va/td-p/4749176
//   https://community.cisco.com/t5/networking-blogs/leak-map-eigrp-some-leaks-are-useful/ba-p/3102498
//
//   PX-North-L2(config-if)#sw mo acc / sw ac vlan 2     PX-South-L2(config-if)#sw acc vlan 4
//   https://www.scribd.com/document/814808735/Ccsi-Notepad
//
// This console resolved the first word of an EXEC line, the view word after `show` and the first word of a config
// line, and refused every shortening in the mode operators actually type in: `ip add`, `desc uplink`, `sw mo acc`
// and `no shut` all came back "% Unrecognized interface command". The rule now applies at the positions where
// `_ifaceMode()` has a complete table - the first word, the word after `no`, the word after `ip`, `ipv6`,
// `switchport`, `encapsulation` and `clock`, and the value of `switchport mode` - and nowhere else: a VLAN id, an
// address, a description or a rate is a value, not a word from a table, and is never touched.
//
// The boundary is asserted below so it stays a decision: `sp` here is `speed` because `spanning-tree` is not a word
// this dispatcher compares against (the mode hands it to the config handler, as it does `vlan 20`), where a box
// would call `sp` ambiguous. That divergence is stated in research/command-word-abbreviation.md, not hidden.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

// A fresh session opened to one port, so an answer's mode and the device state it left are the ones asserted.
function session() {
  const t = new Topology();
  t.addDevice(SWITCH, 'sw1');
  const s = new CliSession(t.getDevice('sw1'), t, new Simulator(t));
  const eth = [...t.getDevice('sw1').interfaces.values()].filter(function (i) { return i.type === 'ethernet'; })[0].name;
  s.run('enable');
  s.run('configure terminal');
  s.run('interface ' + eth);
  return { s: s, dev: t.getDevice('sw1'), eth: eth };
}
function inIface(cmd) {
  const x = session();
  const res = x.s.run(cmd);
  return { mode: x.s.mode, out: res.output, said: res.output.join('\n'), dev: x.dev, eth: x.eth };
}
function answer(cmd) { return inIface(cmd).said; }
const REFUSAL = /^%( Unrecognized interface| Ambiguous interface| Incomplete)/;

console.log('');
console.log('A shortened interface word reaches the door it names, and prints what the whole spelling prints:');
[['ip add 10.0.0.1 255.255.255.0', 'ip address 10.0.0.1 255.255.255.0'],
  ['ip ad 10.0.0.2 255.255.255.0', 'ip address 10.0.0.2 255.255.255.0'],
  ['desc uplink', 'description uplink'],
  ['de uplink to core', 'description uplink to core'],
  ['shut', 'shutdown'],
  ['no shut', 'no shutdown'],
  ['encap dot1q 10', 'encapsulation dot1q 10'],
  ['enc dot1q 10', 'encapsulation dot1q 10'],
  ['sp 100', 'speed 100'],
  ['du full', 'duplex full'],
  ['ch 1 mode active', 'channel-group 1 mode active'],
  ['cl rate 64000', 'clock rate 64000'],
  ['ip o cost 10', 'ip ospf cost 10'],
  ['ip ac 101 in', 'ip access-group 101 in'],
  ['no ip ac 101 in', 'no ip access-group 101 in'],
  ['sw mo acc', 'switchport mode access'],
  ['sw ac vlan 20', 'switchport access vlan 20'],
  ['sw mo t', 'switchport mode trunk'],
  ['no sw', 'no switchport']].forEach(function (pair) {
  const short = answer(pair[0]), long = answer(pair[1]);
  ok(short === long, pair[0] + ' answers exactly as ' + pair[1],
    short.split('\n')[0] + ' | ' + long.split('\n')[0]);
  ok(!REFUSAL.test(short), pair[0] + ' is not a refusal', short.split('\n')[0]);
});

// The abbreviation has to *do* the thing, not merely answer like the whole spelling: the same bytes would pass the
// test above on a console that resolved both spellings to the same refusal.
console.log('');
console.log('The abbreviated line changes the device, exactly as the whole spelling does:');
(function () {
  const r = inIface('ip add 10.0.0.1 255.255.255.0');
  ok(r.dev.interfaces.get(r.eth).ip === '10.0.0.1', '`ip add` sets the address',
    String(r.dev.interfaces.get(r.eth).ip));
  ok(/^IP address set on /.test(r.said), 'and says so', r.said);
})();
(function () {
  const r = inIface('sw mo acc');
  ok(r.dev.interfaces.get(r.eth).vlan.mode === 'access', '`sw mo acc` sets the mode',
    String(r.dev.interfaces.get(r.eth).vlan.mode));
})();
(function () {
  const r = inIface('shut');
  ok(r.dev.interfaces.get(r.eth).enabled === false, '`shut` closes the port',
    String(r.dev.interfaces.get(r.eth).enabled));
  ok(/administratively down/.test(r.said), 'and says so', r.said);
})();
(function () {
  const x = session();
  x.s.run('shutdown');
  const res = x.s.run('no shut');
  ok(x.dev.interfaces.get(x.eth).enabled === true, '`no shut` opens the port',
    String(x.dev.interfaces.get(x.eth).enabled));
  ok(/ up$/.test(res.output.join('\n')), 'and says so', res.output.join('\n'));
})();
(function () {
  // `no ip add` removes what the port holds - the other half of the 2950 transcript line.
  const x = session();
  x.s.run('ip address 10.0.0.1 255.255.255.0');
  const res = x.s.run('no ip add');
  ok(x.dev.interfaces.get(x.eth).ip === null, '`no ip add` removes the address',
    String(x.dev.interfaces.get(x.eth).ip));
  ok(/removed from/.test(res.output.join('\n')), 'and says so', res.output.join('\n'));
})();

console.log('');
console.log('A prefix two interface doors share is refused, naming the spellings, and the mode is left alone:');
[['ip a', ['address', 'access-group']],
  ['no s', ['shutdown', 'switchport', 'speed']],
  ['no d', ['duplex', 'description']],
  ['no i', ['ip', 'ipv6']],
  ['no c', ['clock', 'channel-group']],
  ['d', ['description', 'duplex']],
  ['i', ['interface', 'ip', 'ipv6']],
  ['s', ['switchport', 'shutdown', 'speed', 'show']]].forEach(function (pair) {
  const r = inIface(pair[0]);
  ok(/^% Ambiguous interface command "/.test(r.said), pair[0] + ' is refused as ambiguous', r.said);
  pair[1].forEach(function (word) {
    ok(r.said.indexOf(word) !== -1, pair[0] + ' names ' + word, r.said);
  });
  ok(r.out.length === 1, pair[0] + ' prints nothing alongside the refusal', JSON.stringify(r.out));
  ok(r.mode === 'iface', pair[0] + ' leaves the session in interface mode', 'mode=' + r.mode);
  // The line is quoted as the operator typed it, not as it would have resolved.
  ok(r.said.indexOf('"' + pair[0] + '"') !== -1, pair[0] + ' quotes the line as typed', r.said);
});

// `switchport mode` takes exactly two values, so the value is a closed set too - `sw mo acc` is the spelling the
// CCNP transcript uses, two positions deep.
console.log('');
console.log('The value of `switchport mode` is a closed pair, so it shortens as well:');
(function () {
  const r = inIface('sw mo acc');
  ok(!REFUSAL.test(r.said), '`sw mo acc` is not refused', r.said);
  const q = inIface('sw mo t');
  ok(/mode trunk/.test(q.said), '`sw mo t` is trunk', q.said);
  const bad = inIface('sw mo zzz');
  ok(/Usage: switchport mode access\|trunk/.test(bad.said), 'a value that is neither keeps the usage line', bad.said);
})();

console.log('');
console.log('A value is not a word from a table, and is never resolved:');
[['desc de uplink', /^Description set: de uplink$/],
  ['ip add 10.9.9.1 255.255.255.0', /^IP address set on /],
  ['sw ac vlan 20', /Access VLAN 20 on /],
  ['cl rate 64000', /^% clock rate is only configurable on a serial interface/]].forEach(function (pair) {
  const r = inIface(pair[0]);
  ok(pair[1].test(r.said), pair[0] + ' is answered as typed', r.said);
});

console.log('');
console.log('A word that is no interface command is refused exactly as before, and the boundary holds:');
[['zzz', /^% Unrecognized interface command: zzz$/],
  ['enabl', /^% Unrecognized interface command: enabl$/],
  ['show flurbish', /^% Invalid show command: flurbish$/]].forEach(function (pair) {
  const r = inIface(pair[0]);
  ok(pair[1].test(r.said), pair[0] + ' keeps its refusal', r.said);
  ok(r.mode === 'iface', pair[0] + ' leaves the mode alone', 'mode=' + r.mode);
});
(function () {
  // `sh` is ambiguous here because `show` and `shutdown` share it, and a box says the same at
  // `(config-if)#` - the ambiguity is decided before the view word can be read.
  const r = inIface('sh flurbish');
  ok(/^% Ambiguous interface command "sh": /.test(r.said), '`sh` is ambiguous before `flurbish` is read', r.said);
})();
(function () {
  // Asserted so it stays a decision: `spanning-tree` is not one of this dispatcher's words, so `sp` is `speed`
  // alone here, where a box would weigh `spanning-tree` as well.
  const r = inIface('sp 100');
  ok(/^Speed 100M on /.test(r.said), '`sp` is `speed` here (a box calls it ambiguous)', r.said);
  ok(/^Available commands:/.test(inIface('?').said), '`?` still prints the index',
    inIface('?').said.split('\n')[0]);
  ok(/^Available commands:/.test(inIface('help').said), '`help` still prints the index',
    inIface('help').said.split('\n')[0]);
})();

console.log('');
console.log('The config-mode boundary is unchanged - the words after `no` there are an open set:');
(function () {
  const t = new Topology();
  t.addDevice(SWITCH, 'sw1');
  const s = new CliSession(t.getDevice('sw1'), t, new Simulator(t));
  s.run('enable'); s.run('configure terminal');
  const res = s.run('no vla 20');
  ok(/^% Unrecognized config command: no vla 20$/.test(res.output.join('\n')),
    '`no vla 20` at (config)# is still left alone', res.output.join('\n'));
})();

console.log('\niface-word-abbreviation: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
