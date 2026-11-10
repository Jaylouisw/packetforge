'use strict';
// no-forms.test.js - the removal half of the command set was invisible to `?`.
//
// Measured before this pass, in config and interface mode:
//   R1(config)#no vlan ?            -> % No completions for "no vlan"
//   R1(config)#no ip nat ?          -> % No completions for "no ip nat"
//   R1(config)#no spanning-tree ?   -> % No completions for "no spanning-tree"
//   R1(config-if)#no ip nat ?       -> % No completions for "no ip nat"
//
// Every one of those commands works. The engine had 30 `no` branches and 9 help rows, so an
// operator could set a thing and then had to already know the way back. This test does two things:
// it reads the mode dispatchers and requires a `no …` help row for every `no` branch that exists
// (so the next command added cannot repeat the omission), and it asks the console `?` at the depths
// a reader actually reaches.
//
// Two defects fell out of writing the rows, and both are fixed here:
//   * `no encapsulation dot1q` did not exist at all - the tag could be set and never taken back.
//   * `ipv6 nd suppress-ra` on a switch answered "% Unrecognized interface command" followed by the
//     real reason, so the console called a command it understood unrecognised before explaining it.
const fs = require('fs');
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) + ')'));
}
function match(re, haystack, msg) {
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 400)) + ')'));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });

function session(spec) {
  const t = new Topology();
  const d = t.addDevice(spec);
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  return s;
}

// ---------------------------------------------------------------------------
// 1. Source-driven: every `no` branch in a mode dispatcher has a `no` help row.
// ---------------------------------------------------------------------------
const SRC = fs.readFileSync(path.join(__dirname, '..', 'engine', 'cli.js'), 'utf8');
function body(name) {
  const start = SRC.indexOf('  ' + name + '(');
  if (start < 0) throw new Error('method not found: ' + name);
  const end = SRC.indexOf('\n  }', start);
  return SRC.slice(start, end);
}
// The keywords a `head === 'no'` branch tests for, e.g. ['vlan'], ['ip nat'], ['ipv6 unicast-routing'].
function noPrefixes(name) {
  const b = body(name);
  const out = [];
  for (const chunk of b.split(/\n\s*\}?\s*(?:else\s+)?if\s*\(/)) {
    const cond = chunk.slice(0, Math.max(chunk.indexOf(') {'), 0) || 240);
    // Ordinary control flow: a branch that does not test for `no` is not a removal command.
    if (!/head\s*===\s*'no'/.test(cond)) continue;
    const one = Array.from(new Set([...cond.matchAll(/tokens\[1\]\s*===\s*'([^']+)'/g)].map(function (m) { return m[1]; })))
      .filter(function (w) { return w !== 'int'; }); // `int` is the abbreviation of `interface`
    const two = Array.from(new Set([...cond.matchAll(/tokens\[2\]\s*===\s*'([^']+)'/g)].map(function (m) { return m[1]; })));
    if (!one.length) continue;
    if (two.length) {
      // `tokens[1] === 'ip' && tokens[2] === 'nat'` is one command, not the cross product of the two
      // word lists (the arrays in these conditions are alternatives, not alternatives per level).
      if (two.every(function (w) { return /[a-z]/.test(w); }) &&
          !/\|\|\s*tokens\[2\]/.test(cond)) {
        for (const t2 of two) out.push(one[0] + ' ' + t2);
      } else {
        for (const w of one) out.push(w);
      }
    } else {
      for (const w of one) out.push(w);
    }
  }
  return Array.from(new Set(out));
}
function helpKeywords(mode) {
  const s = session(ROUTER);
  if (mode === 'config') s.run('configure terminal');
  else if (mode === 'iface') { s.run('configure terminal'); s.run('interface Gi0/0'); }
  // The *unfiltered* page: this suite asks whether every `no` branch the parser has is documented
  // for some device. A row a router is not shown (`no spanning-tree vlan <id>`, `no ip nat …`) is
  // still a documented command, and reading the filtered page would report it as missing.
  const which = mode === 'iface' ? 'iface' : (mode === 'config' ? 'config' : 'exec');
  const rows = s._helpFormRowsAll(which) || s._helpFormRows(which) || [];
  return rows.filter(function (r) { return r.tokens[0] === 'no'; })
    .map(function (r) {
      return r.tokens.slice(1).filter(function (t) { return typeof t === 'string'; }).join(' ');
    });
}
function prefixedBy(prefix, rows) {
  return rows.some(function (r) { return r.indexOf(prefix) === 0 || prefix.indexOf(r) === 0; });
}

console.log('\nEvery `no` command in config mode is listed by `?`:');
{
  const rows = helpKeywords('config');
  ok(rows.length >= 15, 'config mode lists ' + rows.length + ' removal forms');
  const missing = noPrefixes('_configMode').filter(function (p) { return !prefixedBy(p, rows); });
  eq(missing.join(', '), '', 'no config-mode `no` branch is missing from the list' +
    (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''));
}
console.log('\nEvery `no` command in interface mode is listed by `?`:');
{
  const rows = helpKeywords('iface');
  ok(rows.length >= 10, 'interface mode lists ' + rows.length + ' removal forms');
  const missing = noPrefixes('_ifaceMode').filter(function (p) { return !prefixedBy(p, rows); });
  eq(missing.join(', '), '', 'no interface-mode `no` branch is missing from the list' +
    (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''));
}

console.log('\nAnd the console answers `?` at the depths a reader reaches:');
{
  const cfg = session(ROUTER);
  cfg.run('configure terminal');
  // `no spanning-tree ?` is not in this list: a router has no spanning tree, so the row is filtered
  // out of its page and the honest answer is the sentence below, not a completion. It is asked of a
  // switch further down.
  const depths = ['no vlan ?', 'no ip nat ?', 'no ospf ?', 'no router bgp ?',
    'no bgp neighbor ?', 'no ip name-server ?', 'no ip default-gateway ?', 'no scion ?',
    'no ipv6 unicast-routing ?', 'no ipv6 route ?'];
  for (const q of depths) {
    const out = cfg.run(q).output;
    ok(!out.some(function (l) { return /% No completions/.test(l); }),
      '`' + q + '` answers instead of "No completions"');
  }
  // A value slot is a value: `no vlan ?` says so.
  match(/Next: <id>/, cfg.run('no vlan ?').output, '`no vlan ?` names the value it wants');
  const iface = session(ROUTER);
  iface.run('configure terminal');
  iface.run('interface Gi0/0');
  for (const q of ['no ip nat ?', 'no ip ospf ?', 'no ip address ?',
    'no ip helper-address ?', 'no vrrp ?', 'no description ?']) {
    const out = iface.run(q).output;
    ok(!out.some(function (l) { return /% No completions/.test(l); }),
      '`' + q + '` (interface mode) answers');
  }
  // `no spanning-tree ?` is a switch question. On a router the family is filtered out of the page -
  // a router runs no spanning tree - so the answer is not a completion but a sentence saying why,
  // which is the point: an empty list that explains itself, not an empty list that looks like a typo.
  const spanRouter = iface.run('no spanning-tree ?').output.join('\n');
  ok(/runs no spanning tree|not on /i.test(spanRouter),
    '`no spanning-tree ?` on a router says why it has nothing to complete');
  const sw = session(SWITCH);
  sw.run('configure terminal');
  sw.run('interface ' + Array.from(sw.device.interfaces.keys())[0]);
  const spanSwitch = sw.run('no spanning-tree ?').output.join('\n');
  ok(!/% No completions/.test(spanSwitch), '`no spanning-tree ?` on a switch completes');
}

console.log('\nThe tag can be taken back off a subinterface:');
{
  const s = session(ROUTER);
  s.run('configure terminal');
  s.run('interface Gi0/0.20');
  const set = s.run('ip address 10.20.0.1 255.255.255.0').output;
  match(/10\.20\.0\.1/, set, 'the subinterface takes an address');
  const tagged = s.run('encapsulation dot1q 42').output;
  match(/Subinterface Gi0\/0\.20 encapsulation dot1q 42/, tagged, 'and a tag');
  const removed = s.run('no encapsulation dot1q').output;
  match(/Encapsulation removed from Gi0\/0\.20 \(was VLAN 42\)/, removed,
    'which can be removed, and the removal names the tag it took off');
  match(/back to the tag inferred from the interface number, VLAN 20/, removed,
    'and says what it reverted to');
  eq(s.device.interfaces.get('Gi0/0.20').encapVid, 20, 'the stored tag is back to the inferred one');
  match(/is already the inferred VLAN 20/, s.run('no encapsulation dot1q').output,
    'removing it again says there is nothing to remove, and why');
  const extra = s.run('no encapsulation dot1q 42').output;
  match(/% Unexpected argument "42"/, extra, 'and a word after it is refused');
  const physical = session(SWITCH);
  physical.run('configure terminal');
  physical.run('interface Fa0/1');
  match(/is not a subinterface - only a subinterface carries a tag/,
    physical.run('no encapsulation dot1q').output,
    'a physical port is refused by naming why it has no tag');
}

console.log('\nA refusal that knows the reason does not also claim not to recognise the words:');
{
  const sw = session(SWITCH);
  sw.run('configure terminal');
  sw.run('interface Fa0/1');
  const out = sw.run('ipv6 nd suppress-ra').output;
  match(/cannot advertise: it has no l3-forward capability/, out, 'the reason is given');
  ok(!out.some(function (l) { return /Unrecognized interface command/.test(l); }),
    'and the console no longer calls it unrecognised first');
  // An actually unknown command still says so.
  match(/% Unrecognized interface command: wibble wobble/, sw.run('wibble wobble').output,
    'a word nothing knows is still reported as unrecognised');
}

console.log('\nThe translation table can be emptied, and the rules stay:');
{
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const r2 = t.addDevice(ROUTER); r2.name = 'R2';
  const pc = t.addDevice(catalog.find(function (s) { return s.model === 'generic-pc'; })); pc.name = 'PC1';
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  t.connect(pc.id, 'eth0', sw.id, 'Fa0/1');
  t.connect(sw.id, 'Fa0/2', r1.id, 'Gi0/0');
  t.connect(r1.id, 'Gi0/1', r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  const mk = function (d) { const s = new CliSession(d, t, sim); s.run('enable'); return s; };
  const a = mk(r1), b = mk(r2), sp = mk(pc);
  const cfg = function (s, cmds) { s.run('configure terminal'); cmds.forEach(function (c) { s.run(c); }); s.run('end'); };
  cfg(a, ['hostname R1', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 203.0.113.2 255.255.255.0', 'exit',
    'ip route 0.0.0.0 0.0.0.0 203.0.113.254',
    'access-list 1 permit 10.0.0.0 0.0.0.255',
    'interface Gi0/0', 'ip nat inside', 'exit',
    'interface Gi0/1', 'ip nat outside', 'exit',
    'ip nat inside source list 1 interface Gi0/1 overload']);
  cfg(b, ['hostname R2', 'interface Gi0/0', 'ip address 203.0.113.254 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 198.51.100.9 255.255.255.0', 'exit']);
  cfg(sp, ['hostname PC1', 'interface eth0', 'ip address 10.0.0.50 255.255.255.0',
    'ip default-gateway 10.0.0.1', 'exit']);
  sp.run('ping 198.51.100.9 count 1');
  match(/pat/, a.run('show ip nat translations').output, 'there is a translation to clear');
  match(/1 translation cleared on R1/, a.run('clear ip nat translation *').output,
    '`clear ip nat translation *` empties it');
  match(/\(none/, a.run('show ip nat translations').output, 'and the table is empty');
  eq((r1.config.nat.rules || []).length, 1, 'while the rule is still configured');
  match(/was already empty/, a.run('clear ip nat translation *').output,
    'clearing an empty table says it was already empty');
  // Clearing one host's entries, and naming the ones that exist when there are none.
  sp.run('ping 198.51.100.9 count 1');
  const one = a.run('clear ip nat translation 10.0.0.50').output;
  match(/translation for 10\.0\.0\.50 cleared on R1/, one, 'one host\'s entries can be cleared by address');
  match(/% No translations for 10\.0\.0.99 on R1/, a.run('clear ip nat translation 10.0.0.99').output,
    'an address with no entries is refused');
  match(/Inside locals with entries: \(none\)/,
    a.run('clear ip nat translation 10.0.0.99').output, 'with the addresses that do have entries');
  // The bare form, a bad sub-word, and a third word.
  match(/% Incomplete command: clear ip nat translation \[\*\]/, a.run('clear ip nat').output,
    'a half-typed clear quotes the form');
  match(/% Unexpected argument "10.0.0.1"/, a.run('clear ip nat translation 10.0.0.50 10.0.0.1').output,
    'a second address is refused');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
