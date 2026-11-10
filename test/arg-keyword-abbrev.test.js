'use strict';
// arg-keyword-abbrev.test.js - a keyword abbreviates wherever it stands, not only as the first word.
//
// The console abbreviates keywords by prefix, and its tree comes from the help rows. That rule was
// applied to the command words but not to a keyword standing in an *argument* position, so:
//
//   R1#show run int Gi0/0    % show running-config takes one port, not "int Gi0/0"
//   R1#show arp int Gi0/0    % show arp takes one port or one address, not "int Gi0/0"
//
// Both refusals name no port and offer no clue, for a word ("int") that has exactly one
// continuation in that slot and cannot be a port name. The argument parsers stripped the literal
// `interface` and nothing else, so the two spellings an operator actually types of the same read
// gave different answers: one the config, the other advice about the port list.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

const ROUTER = ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
  'interface Gi0/1', 'ip address 10.1.0.1 255.255.255.0', 'no shutdown', 'exit',
  'arp 10.0.0.5 00:11:22:33:44:55', 'vlan 10 name lab',
  'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'exit',
  'router bgp 65001', 'bgp router-id 1.1.1.1', 'neighbor 10.0.0.2 remote-as 65002', 'exit',
  'ip access-list extended TEST', 'permit ip any any', 'exit'];
const SWITCH = ['vlan 10', 'interface Fa0/1', 'switchport access vlan 10', 'exit',
  'interface Vlan10', 'ip address 10.10.0.1 255.255.255.0', 'exit',
  'spanning-tree vlan 10 root primary'];

function lab(model, name, prep) {
  const t = new Topology();
  const d = t.addDevice(find(model)); d.name = name;
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  s.run('configure terminal');
  (prep || []).forEach(function (l) { s.run(l); });
  s.run('end');
  return { t: t, d: d, s: s };
}

console.log('\n`interface` abbreviates in an argument position:');
{
  const full = text(lab('generic-router', 'R1', ROUTER).s.run('show running-config interface Gi0/0'));
  for (const short of ['int', 'inte', 'inter', 'interf']) {
    const env = lab('generic-router', 'R1', ROUTER);
    const got = text(env.s.run('show running-config ' + short + ' Gi0/0'));
    ok(got === full, '"show running-config ' + short + ' Gi0/0" answers the same as the full spelling');
  }
  const env = lab('generic-router', 'R1', ROUTER);
  ok(/needs a port after "interface"/.test(text(env.s.run('show run in'))),
    'a truncated abbreviation is a truncated command, not an ignored argument');
  // One letter is genuinely ambiguous - it could be the start of a port name - so it stays refused.
  ok(/takes one port/.test(text(env.s.run('show run i Gi0/0'))),
    'a single letter is still refused (it could be the start of a port name)');
}

console.log('\n…in every command that takes a port, not only the one that was reported:');
{
  const pairs = [
    ['generic-router', ROUTER, 'show running-config int Gi0/0', 'show running-config interface Gi0/0'],
    ['generic-router', ROUTER, 'show arp int Gi0/0', 'show arp interface Gi0/0'],
    ['generic-router', ROUTER, 'show ip arp int Gi0/0', 'show ip arp interface Gi0/0'],
    ['generic-router', ROUTER, 'show ip interface int Gi0/0', 'show ip interface interface Gi0/0'],
    ['generic-switch', SWITCH, 'show mac address-table int Fa0/1', 'show mac address-table interface Fa0/1'],
    ['generic-switch', SWITCH, 'show interfaces counters int Fa0/1', 'show interfaces counters interface Fa0/1'],
    ['generic-switch', SWITCH, 'show port-security int Fa0/1', 'show port-security interface Fa0/1']
  ];
  for (const [model, prep, short, full] of pairs) {
    const a = text(lab(model, 'X1', prep).s.run(short));
    const b = text(lab(model, 'X1', prep).s.run(full));
    ok(a === b && !/^\s*%/m.test(a.split('\n')[0] || ''), '"' + short + '" matches "' + full + '"');
  }
  const clear = text(lab('generic-router', 'R1', ROUTER).s.run('clear arp int Gi0/0'));
  ok(/ARP cache on R1 for Gi0\/0/.test(clear), 'clear arp takes the abbreviation too');
}

console.log('\nThe rule, swept across every show row made of literal keywords:');
{
  // For each `show …` row whose words are all literal keywords, abbreviate each keyword after the
  // first to three characters *when that prefix identifies exactly one keyword in the exec
  // vocabulary*, and require the same answer as the full spelling.
  const vocab = new Set();
  const rowsBy = new Map();
  for (const [model, name, prep] of [['generic-router', 'R1', ROUTER], ['generic-switch', 'SW1', SWITCH]]) {
    const env = lab(model, name, prep);
    const rows = text(env.s.run('?')).split('\n').map(function (l) { return l.trim(); })
      .filter(function (l) { return l && !l.startsWith('%'); })
      .map(function (l) { return l.split(/\s{2,}/)[0]; })
      .filter(function (s) { return /^show /.test(s) && s.indexOf('<') === -1; });
    const literal = rows.filter(function (s) {
      return s.split(/\s+/).every(function (w) { return /^[a-z][a-z0-9-]*$/.test(w); });
    });
    literal.forEach(function (s) {
      s.split(/\s+/).slice(1).forEach(function (w) { vocab.add(w); });
    });
    rowsBy.set(model + '/' + name, { rows: literal, prep: prep });
  }
  ok(vocab.size > 12, 'the exec vocabulary has ' + vocab.size + ' keywords to abbreviate');
  let checked = 0;
  for (const [key, info] of rowsBy) {
    const model = key.split('/')[0];
    for (const row of info.rows) {
      // `show history` prints the commands typed, so two runs cannot agree by construction.
      // Ordinary control flow, not an exemption: it is the output that differs, not the answer.
      if (/^show history$/.test(row)) continue;
      const words = row.split(/\s+/);
      for (let i = 1; i < words.length; i++) {
        const p3 = words[i].slice(0, 3);
        const cands = [...vocab].filter(function (v) { return v.startsWith(p3); });
        if (cands.length !== 1) continue;
        const abbr = words.map(function (w, j) { return j === i ? p3 : w; }).join(' ');
        const a = text(lab(model, 'X1', info.prep).s.run(row));
        const b = text(lab(model, 'X1', info.prep).s.run(abbr));
        ok(a === b, '"' + abbr + '" answers like "' + row + '"');
        checked++;
      }
    }
  }
  ok(checked >= 4, 'the sweep abbreviated ' + checked + ' keyword positions');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
