'use strict';
// Which spelling of an interface name does a `show running-config` stanza header print?
//
// This console printed the catalogue's panel spelling:
//
//     interface Gi1/0/1
//     !
//     interface Gi1/0/2
//
// A box prints the type word in full, whatever was typed at the prompt: a Catalyst's own
// `show running-config interface fastEthernet 0/6` comes back headed `interface FastEthernet0/6`
// (Cisco support doc 113260), and a Catalyst 9200's `show running-config interface
// gigabitethernet1/0/1` comes back headed `interface GigabitEthernet1/0/1` (IOS XE 17.7 interface
// and hardware command reference). The 4000 Series ISR's own default configuration goes
// `interface GigabitEthernet0/0/0` / `no ip address` / `negotiation auto` / `!`. So the file an
// operator reads, pastes and diffs named one port `Gi1/0/1` where the box names it
// `GigabitEthernet1/0/1` - and named it two ways in the same session, because
// `show ip interface brief` had already been taught to spell the type out.
//
// The panel name stays the key: every lookup, every cable and the stored config object keep it,
// so `show interfaces` still heads its block with `Gi1/0/1` (that block is this console's own
// shape, and a tested rule owns the spelling there). Only the vendor's file moves, through the
// same table the brief table uses, so the two vendor-shaped views cannot disagree.
// research/running-config-interface-name.md records the captures and what is still open.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const ifaceName = require('../engine/iface-name');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) {
  const found = catalog.filter(function (s) { return s.model === model; })[0];
  if (!found) throw new Error('the catalogue has no ' + model);
  return found;
}

function session(model, id) {
  const t = new Topology();
  const d = t.addDevice(spec(model), id || 'd1');
  const s = new CliSession(d, t, new Simulator(t));
  return {
    t: t, d: d, s: s,
    run: function (lines) {
      const out = [];
      for (const c of [].concat(lines)) {
        let r;
        try { r = s.run(c); } catch (e) { out.push('% EXCEPTION: ' + e.message); continue; }
        for (const l of ((r && r.output) || [])) out.push(String(l));
      }
      return out;
    },
    config: function () { return this.run(['enable', 'show running-config']); }
  };
}
function headers(cfg) { return cfg.filter(function (l) { return /^interface /.test(l); }); }
function rejections(lines) { return lines.filter(function (l) { return /^%/.test(l); }); }
function bodyOf(cfg, header) {
  const at = cfg.indexOf(header);
  if (at === -1) return [];
  const out = [];
  for (let i = at + 1; i < cfg.length && cfg[i] !== '!'; i++) out.push(cfg[i]);
  return out;
}

console.log('');
console.log('A factory Catalyst prints the type word in full, one stanza per port:');
{
  const env = session('C2960X-24TS-L');
  const cfg = env.config();
  const heads = headers(cfg);
  const ports = [...env.d.interfaces.values()].filter(function (i) { return !require('../engine/device').isConsoleLine(i); });
  ok(heads.length === ports.length, 'a stanza for every port', heads.length + ' headers, ' + ports.length + ' ports');
  ok(heads.every(function (l) { return /^interface GigabitEthernet1\/0\/\d+$/.test(l); }),
    'every header spells the type out', JSON.stringify(heads.slice(0, 2)));
  ok(!cfg.some(function (l) { return /^interface Gi[\d/.]+$/.test(l); }),
    'and no header uses the panel abbreviation',
    JSON.stringify(cfg.filter(function (l) { return /^interface Gi[\d/.]+$/.test(l); }).slice(0, 2)));
  ok(cfg.indexOf('interface GigabitEthernet1/0/1') !== -1, 'the first port is `interface GigabitEthernet1/0/1`');
  ok(cfg.indexOf('interface GigabitEthernet1/0/28') !== -1, 'and the last is spelled the same way');
}

console.log('');
console.log('Whatever was typed, the file prints the port\'s one full name:');
{
  const env = session('C2960X-24TS-L');
  const said = env.run(['enable', 'configure terminal',
    'interface gi 1/0/1', 'description typed short', 'exit',
    'interface GigabitEthernet 1/0/2', 'description typed long spaced', 'exit',
    'interface g1/0/3', 'description typed as a prefix', 'exit',
    'end']);
  ok(rejections(said).length === 0, 'all three spellings open their port', JSON.stringify(rejections(said)));
  const cfg = env.config();
  for (const [n, text] of [['1/0/1', 'typed short'], ['1/0/2', 'typed long spaced'], ['1/0/3', 'typed as a prefix']]) {
    const head = 'interface GigabitEthernet' + n;
    ok(cfg.indexOf(head) !== -1, n + ' is headed ' + head, head);
    ok(bodyOf(cfg, head).some(function (l) { return l.trim() === 'description ' + text; }),
      'and the description typed for it is inside that block', JSON.stringify(bodyOf(cfg, head)));
  }
  ok(!cfg.some(function (l) { return /^interface gi /.test(l) || /^interface g1\//.test(l); }),
    'no stanza echoes the spelling that was typed');
}

console.log('');
console.log('A subinterface keeps the tag after the expanded parent name:');
{
  const env = session('C2960X-24TS-L');
  env.run(['enable', 'configure terminal', 'interface Gi1/0/3.10', 'encapsulation dot1q 10', 'end']);
  const cfg = env.config();
  ok(cfg.indexOf('interface GigabitEthernet1/0/3.10') !== -1,
    'the child is `interface GigabitEthernet1/0/3.10`', JSON.stringify(headers(cfg).filter(function (l) { return /\.10$/.test(l); })));
  ok(bodyOf(cfg, 'interface GigabitEthernet1/0/3.10').some(function (l) { return l.trim() === 'encapsulation dot1q 10'; }),
    'with its tag inside the block');
  ok(env.d.interfaces.has('Gi1/0/3.10'), 'and the stored name is still the panel spelling');
}

console.log('');
console.log('A router, and a box whose own ports are named GE:');
{
  const isr = session('ISR 4331');
  const cfg = isr.config();
  ok(cfg.indexOf('interface GigabitEthernet0/0/0') !== -1, 'a 4331 prints `interface GigabitEthernet0/0/0`');
  ok(cfg.indexOf('interface GigabitEthernet0') !== -1, 'and the management port `interface GigabitEthernet0`');
  ok(!cfg.some(function (l) { return /^interface Gi0/.test(l); }), 'with no `Gi0…` header anywhere');

  const huawei = session('S5735-L24T4S');
  const said = huawei.run(['enable', 'configure terminal', 'interface GE0/0/1', 'description huawei uplink', 'end']);
  ok(rejections(said).length === 0, 'the VRP panel name opens its port', JSON.stringify(rejections(said)));
  ok(huawei.config().indexOf('interface GigabitEthernet0/0/1') !== -1,
    'and the file prints the word VRP prints, `interface GigabitEthernet0/0/1`');
}

console.log('');
console.log('A name the table does not know is printed exactly as the panel has it:');
{
  const ucg = session('UCG-Fiber');
  const cfg = ucg.config();
  ok(cfg.indexOf('interface Port 1') !== -1, 'UniFi keeps `interface Port 1` (the name has a space)');
  ok(cfg.indexOf('interface SFP+ 1') !== -1, 'and `interface SFP+ 1`');
  ok(!cfg.some(function (l) { return /^interface Port-channel/.test(l); }),
    'and nothing invents a Cisco word for it');

  const mt = session('ICR-3231');
  ok(mt.config().indexOf('interface eth1') !== -1, 'a RouterOS-style `eth1` stays `eth1`');
}

console.log('');
console.log('The two vendor-shaped views name a port the same way:');
{
  const env = session('C2960X-24TS-L');
  const heads = headers(env.config()).map(function (l) { return l.replace(/^interface /, ''); });
  const brief = env.run(['enable', 'show ip interface brief'])
    .filter(function (l) { return /^\S+\s+unassigned|^\S+\s+\d/.test(l) && !/^Interface/.test(l); })
    .map(function (l) { return l.split(/\s+/)[0]; });
  const missing = heads.filter(function (h) { return brief.indexOf(h) === -1; });
  ok(missing.length === 0, 'every config header has a row in `show ip interface brief` under the same name',
    JSON.stringify(missing.slice(0, 3)));
  ok(ifaceName.displayName('Gi1/0/1') === 'GigabitEthernet1/0/1', 'both go through displayName()');
}

console.log('');
console.log('The file still replays, and the panel spelling still reads the port back:');
{
  const a = session('C2960X-24TS-L', 'sw1');
  a.run(['enable', 'configure terminal',
    'hostname ACCESS-1',
    'interface Gi1/0/1', 'switchport access vlan 20', 'description desk', 'exit',
    'interface Gi1/0/2', 'switchport mode trunk', 'exit',
    'interface Gi1/0/3', 'shutdown', 'exit',
    'vlan 20 lab', 'end']);
  const cfg = a.config();
  const b = session('C2960X-24TS-L', 'sw1');
  const out = b.run(['enable', 'configure terminal'].concat(cfg).concat(['end']));
  ok(rejections(out).length === 0, 'the printed file is accepted back without a complaint',
    JSON.stringify(rejections(out).slice(0, 3)));
  ok(b.d.interfaces.get('Gi1/0/1').vlan.accessVlan === 20, 'the access VLAN landed on Gi1/0/1');
  ok(b.d.interfaces.get('Gi1/0/1').description === 'desk', 'and its description');
  ok(b.d.interfaces.get('Gi1/0/2').vlan.mode === 'trunk', 'the trunk landed on Gi1/0/2');
  ok(b.d.interfaces.get('Gi1/0/3').enabled === false, 'and the shutdown on Gi1/0/3');
  ok(b.config().join('\n') === cfg.join('\n'), 'the config is byte-identical afterwards');
  ok(a.run(['show interfaces Gi1/0/1']).some(function (l) { return /^Gi1\/0\/1 \(/.test(l); }),
    '`show interfaces` still heads its block with the panel spelling');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
