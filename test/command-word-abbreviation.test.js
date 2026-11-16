'use strict';
// A command word may be shortened to what is still unique: `sh ver` is `show version` (#fidelity).
//
// IOS states the rule in its own CLI chapter: "You can abbreviate commands and keywords to the number of
// characters that allow a unique abbreviation", with `configure terminal` -> `config t` as the vendor's example
// (Cisco IOS XE 16 Fundamentals Configuration Guide, Using the Cisco IOS Command-Line Interface):
//   https://cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/configuration/xe-16/fundamentals-xe-16-book/cf-cli-basics.html
//   https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/configuration/guide/12_2sr/cf_12_2sr_book/cf-cli-basics.html
// Operators write `sh ver`, and Cisco community transcripts print it accepted over the version banner:
//   https://community.cisco.com/t5/routing/sh-version/td-p/1506039
//   https://community.cisco.com/t5/switching/schedule-9200-software-upgrade/td-p/4176330
//
// This console applied the rule to one word - `config t` opened config mode (#1661) - and to nothing else:
//
//   sw1#sh ver        -> % Unrecognized command: sh ver
//   sw1#sh int        -> % Unrecognized command: sh int
//   sw1#sh vl         -> % Unrecognized command: sh vl
//
// A word is now resolved by prefix against the table this console keeps for that position - the first word of an
// EXEC line, and the view word after `show` - and a prefix two words share is refused as ambiguous rather than
// guessed, which is the answer IOS gives too. Nothing else is resolved: the words after `show ip`, and values such
// as a port name or `brief`, have no complete table here, so a short word there cannot be told from an ambiguous
// one and is left exactly as it was (the boundary is asserted below, deliberately, so it stays a decision).
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

// One line at a time, on a fresh session, so the mode an answer left behind is the one asserted.
function typed(cmd) {
  const t = new Topology();
  t.addDevice(SWITCH, 'sw1');
  const s = new CliSession(t.getDevice('sw1'), t, new Simulator(t));
  const res = s.run(cmd);
  return { mode: s.mode, out: res.output, said: res.output.join('\n') };
}

// The whole answer, so "same door" means the same bytes rather than the same first line.
function answer(cmd) { return typed(cmd).out.join('\n'); }
const REFUSAL = /^%( Invalid show| Unrecognized| Ambiguous| Unknown)/;

console.log('');
console.log('A shortened view word reaches the door it names, and prints what the whole spelling prints:');
[['sh ver', 'show version'],
  ['sh int', 'show interfaces'],
  ['sh vl', 'show vlan'],
  ['sh run', 'show running-config'],
  ['sh s', 'show spanning-tree'],
  ['sh ll', 'show lldp'],
  ['sh acc', 'show access-lists'],
  ['sh ru', 'show running-config']].forEach(function (pair) {
  const short = answer(pair[0]), long = answer(pair[1]);
  ok(short === long, '"' + pair[0] + '" answers exactly as "' + pair[1] + '"',
    short.split('\n')[0] + ' | ' + long.split('\n')[0]);
  ok(!REFUSAL.test(short), '"' + pair[0] + '" is not a refusal', short.split('\n')[0]);
});

// The three spellings of one word - the whole word, the console's old shorthand, and a prefix - are one answer.
['show version', 'show ver', 'sh ver', 'sh vers', 'sh version'].forEach(function (cmd) {
  const out = answer(cmd);
  ok(out === answer('show version'), '"' + cmd + '" prints the version banner', out.split('\n')[0]);
});

console.log('');
console.log('A prefix two doors share is refused, in the console\'s own words, naming the spellings:');
[['sh i', ['interfaces', 'ip', 'ipv6']],
  ['sh v', ['version', 'vlan', 'vrrp']],
  ['sh p', ['port-channel', 'power']],
  ['sh a', ['access-lists', 'arp']]].forEach(function (pair) {
  const r = typed(pair[0]);
  ok(/^% Ambiguous command "show /.test(r.said), '"' + pair[0] + '" is refused as ambiguous', r.said);
  pair[1].forEach(function (word) {
    ok(r.said.indexOf(word) !== -1, '"' + pair[0] + '" names ' + word, r.said);
  });
  ok(r.out.length === 1, '"' + pair[0] + '" prints no table alongside the refusal', JSON.stringify(r.out));
  ok(r.mode === 'exec', '"' + pair[0] + '" leaves the mode alone', 'mode=' + r.mode);
});

// A port-channel is not spelled `etherchannel` by the operator, so the refusal must not answer about a word they
// never typed - the same rule `show port-channel 1` already followed (#1449).
(function () {
  const r = typed('sh port-c 1');
  ok(/^% show port-c does not take "1"/.test(r.said), 'a shortened port-channel keeps its own spelling in the refusal', r.said);
})();

console.log('');
console.log('The EXEC word itself shortens the same way, and a shared prefix is still ambiguous:');
[['en', 'enable'], ['ena', 'enable'], ['ex', 'exec'], ['conf t', 'config'], ['config term', 'config'],
  ['configu termi', 'config'], ['h', 'exec']].forEach(function (pair) {
  const r = typed(pair[0]);
  ok(r.mode === pair[1], '"' + pair[0] + '" leaves the session in ' + pair[1] + ' mode', 'mode=' + r.mode);
});
ok(typed('en').mode === 'enable', '`en` is `enable`', 'mode=' + typed('en').mode);
ok(typed('h').said.indexOf('Available commands:') !== -1, '`h` prints the help index', typed('h').said.split('\n')[0]);
[['e', ['enable', 'exit']], ['c', ['configure', 'converge']], ['l', ['link', 'links', 'logout']]].forEach(function (pair) {
  const r = typed(pair[0]);
  ok(/^% Ambiguous command "/.test(r.said), '"' + pair[0] + '" is refused as ambiguous', r.said);
  pair[1].forEach(function (word) {
    ok(r.said.indexOf(word) !== -1, '"' + pair[0] + '" names ' + word, r.said);
  });
  ok(r.mode === 'exec', '"' + pair[0] + '" opens nothing', 'mode=' + r.mode);
});
ok(/Tracing the route to/.test(answer('trac 10.0.0.1')), '`trac` is `traceroute`, not an ambiguity with `tracert`',
  answer('trac 10.0.0.1').split('\n')[0]);
ok(answer('tracert 10.0.0.1') === answer('traceroute 10.0.0.1'), 'the alias still answers as itself',
  answer('tracert 10.0.0.1').split('\n')[0]);

console.log('');
console.log('A word that is no command here is refused exactly as before, and never swallowed:');
[['sh flurbish', /^% Invalid show command: flurbish$/],
  ['sh spantree', /^% Invalid show command: spantree$/],
  ['flurbish', /^% Unrecognized command: flurbish$/]].forEach(function (pair) {
  const r = typed(pair[0]);
  ok(pair[1].test(r.said), '"' + pair[0] + '" keeps its refusal', r.said);
});
(function () {
  const r = typed('sh ver flurbish');
  ok(/^% show version does not take "flurbish"/.test(r.said), 'a shortened command answers about the word after it', r.said);
})();

// The boundary, asserted so it stays a decision: the words *after* a resolved one have no table here, so `int` and
// `br` there are left alone. A console that guessed them would accept lines a box refuses for other reasons.
(function () {
  const r = typed('show ip int br');
  ok(/^% Invalid show command: ip int br$/.test(r.said), 'the words after `show ip` are not resolved', r.said);
  const p = typed('sh int Fa');
  ok(/No interface Fa/.test(p.said), 'a port name is not resolved by prefix either', p.said);
})();

// ---- the same rule at `(config)#` ----
//
// A real box accepts a shortened config word: the transcript on connecteddots.online prints
// `Router(config)#int gi0/1` opening the port and `do sh run` running the view, and Cisco's CLI chapter states the
// rule for "commands and keywords" without limiting it to one mode
// (https://www.connecteddots.online/resources/cisco/invalid-input-detected-at-marker). This console accepted
// exactly one of them - `int`, as a hard-coded alternative - and refused `host r1`, `vla 20`, `sp priority 4096`
// and `do sh ver`. The rule now applies to the first word of a config line, resolved against the dispatcher's own
// vocabulary, and to the EXEC word after `do`.
console.log('');
console.log('A shortened config word reaches the door it names, and prints what the whole spelling prints:');

function inConfig(cmd) {
  const top = new Topology();
  top.addDevice(SWITCH, 'sw1');
  const s = new CliSession(top.getDevice('sw1'), top, new Simulator(top));
  s.run('enable');
  s.run('configure terminal');
  const res = s.run(cmd);
  return { mode: s.mode, out: res.output, said: res.output.join('\n'), dev: top.getDevice('sw1') };
}
const ETH = (function () {
  const top = new Topology();
  top.addDevice(SWITCH, 'sw1');
  const d = top.getDevice('sw1');
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; })[0].name;
})();
const CONFIG_REFUSAL = /^%( Unrecognized config| Ambiguous config| Incomplete)/;

(function () {
  const short = inConfig('host r1'), long = inConfig('hostname r1');
  ok(short.dev.config.hostname === 'r1', '`host r1` sets the hostname', String(short.dev.config.hostname));
  ok(short.said === long.said, '`host r1` answers exactly as `hostname r1`', short.said);
  ok(!CONFIG_REFUSAL.test(short.said), '`host r1` is not a refusal', short.said);
})();
[['in ' + ETH, 'int ' + ETH], ['int ' + ETH, 'interface ' + ETH]].forEach(function (pair) {
  const r = inConfig(pair[0]);
  ok(r.mode === 'iface', '`' + pair[0] + '` opens the port', 'mode=' + r.mode);
  ok(r.said === inConfig(pair[1]).said, '`' + pair[0] + '` answers exactly as `' + pair[1] + '`', r.said);
});
[['vla 20 name lab', 'vlan 20 name lab'], ['sp priority 4096', 'spanning-tree priority 4096'],
  ['do sh ver', 'do show version'], ['do sh run', 'do show running-config']].forEach(function (pair) {
  const short = inConfig(pair[0]), long = inConfig(pair[1]);
  ok(short.said === long.said, '`' + pair[0] + '` answers exactly as `' + pair[1] + '`',
    short.said.split('\n')[0] + ' | ' + long.said.split('\n')[0]);
  ok(!CONFIG_REFUSAL.test(short.said), '`' + pair[0] + '` is not a refusal', short.said);
});
(function () {
  const r = inConfig('sp priority 4096');
  ok(r.dev.config.stpPriority === 4096, '`sp priority 4096` sets the bridge priority', String(r.dev.config.stpPriority));
  const v = inConfig('vla 20 name lab');
  const vlans = v.dev.config.vlans;
  ok(JSON.stringify(vlans).indexOf('20') !== -1 && /lab/.test(v.said), '`vla 20 name lab` creates VLAN 20', v.said);
})();

console.log('');
console.log('A prefix two config doors share is refused, and the mode it would have left is left alone:');
[['i', ['interface', 'ip', 'ipv6']], ['e', ['exit', 'end']], ['d', ['dns', 'do']], ['n', ['no', 'name']],
  ['s', ['show', 'spanning-tree']]].forEach(function (pair) {
  const r = inConfig(pair[0]);
  ok(/^% Ambiguous config command "/.test(r.said), '"' + pair[0] + '" is refused as ambiguous', r.said);
  pair[1].forEach(function (word) {
    ok(r.said.indexOf(word) !== -1, '"' + pair[0] + '" names ' + word, r.said);
  });
  ok(r.mode === 'config', '"' + pair[0] + '" leaves the session in config mode', 'mode=' + r.mode);
  ok(r.out.length === 1, '"' + pair[0] + '" prints nothing alongside the refusal', JSON.stringify(r.out));
});

console.log('');
console.log('A word that is no config command is refused exactly as before, and the boundary holds:');
[['flurbish', /^% Unrecognized config command: flurbish$/],
  ['x', /^% Unrecognized config command: x$/],
  ['enabl', /^% Unrecognized config command: enabl$/],
  ['sh flurbish', /^% Invalid show command: flurbish$/]].forEach(function (pair) {
  const r = inConfig(pair[0]);
  ok(pair[1].test(r.said), '"' + pair[0] + '" keeps its refusal', r.said);
  ok(r.mode === 'config', '"' + pair[0] + '" leaves the mode alone', 'mode=' + r.mode);
});
// The boundary, asserted so it stays a decision: the second word of a config line has no complete table here -
// `ip ro` is `ip route` on a box, but this console cannot enumerate the words after `ip` - so it is left alone,
// and a keyword after the door keeps its own spelling in the refusal.
(function () {
  const r = inConfig('ip ro 10.0.0.0 255.0.0.0 1.1.1.1');
  ok(/^% Unrecognized config command: ip ro 10\.0\.0\.0/.test(r.said), 'the words after `ip` are not resolved', r.said);
  const n = inConfig('no vla 20');
  ok(/^% Unrecognized config command: no vla 20$/.test(n.said), 'the word after `no` is not resolved either', n.said);
  const p = inConfig('sp portfast');
  ok(/^% spanning-tree portfast is not modelled/.test(p.said),
    'the word after the door is answered by the door, in its own spelling', p.said);
})();

console.log('\ncommand-word-abbreviation: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
