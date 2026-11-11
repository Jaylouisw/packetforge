'use strict';
// modes-and-roundtrip.test.js - every mode a device can enter: which level it is, how it leaves, what a
// read does to the prompt, and whether what it configures survives the saved copy.
//
// Two properties, both mechanical:
//
//   1. A mode is a place with one exit. `do <read>` and a bare `show` are reads: they answer and the
//      prompt does not move. `exit` goes up exactly one level and `end` goes to privileged exec. The
//      prompt string is the only thing telling an operator where they are, so it has to match the mode
//      the parser is in - and the ACL prompt is `(config-std-nacl)#`, the spelling IOS uses.
//
//   2. A setting configured inside a block survives the saved copy. Apply it, write the copy, reload the
//      copy into a fresh device, re-apply the same line: nothing may change. This is the property that
//      caught `vrrp preempt` (stored, never dumped) one mode up, and it had never been asked of the
//      DHCP-pool, ACL, OSPF-router and BGP-router blocks.
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

// One device from each catalogue category: the entry modes are gated by capability, so the sweep has to
// visit every kind of box, not just a router.
const byKind = {};
for (const cat of catalog) {
  const kind = cat.category || cat.kind || 'other';
  if (!byKind[kind]) byKind[kind] = cat;
}
function fresh(cat) {
  const t = new Topology();
  const d = t.addDevice(cat); d.name = 'D1';
  const ports = Array.from(d.interfaces.values()).filter(function (i) {
    return !/vlan|lo|tunnel|mgmt/i.test(i.name || '');
  });
  return { t: t, d: d, s: new CliSession(d, t, new Simulator(t)), port: ports.length ? ports[0].name : 'Fa0/1' };
}

// The prompt each mode prints, and the level `exit` goes to from it.
const ENTRIES = [
  { mode: 'config', enter: ['configure terminal'], up: 'enable', prompt: /\(config\)#$/ },
  { mode: 'iface', enter: ['configure terminal', 'interface PORT'], up: 'config', prompt: /\(config-if\)#$/ },
  { mode: 'dhcp', enter: ['configure terminal', 'ip dhcp pool lab'], up: 'config', prompt: /\(config-dhcp\)#$/ },
  { mode: 'acl', enter: ['configure terminal', 'ip access-list standard lab'], up: 'config',
    prompt: /\(config-std-nacl\)#$/ } // IOS spells it config-std-nacl, and so does this console
];

console.log('A read answers and leaves the prompt where it is:');
{
  let probes = 0;
  const bad = [];
  for (const kind of Object.keys(byKind)) {
    for (const entry of ENTRIES) {
      const env = fresh(byKind[kind]);
      env.s.run('enable');
      entry.enter.map(function (l) { return l.replace('PORT', env.port); }).forEach(function (l) { env.s.run(l); });
      if (env.s.mode !== entry.mode) continue;      // the device cannot enter it: a different invariant
      probes++;
      const before = env.s.prompt();
      const doRes = text(env.s.run('do show version'));
      if (/^\s*%/.test(doRes)) bad.push(kind + ' [' + entry.mode + ']: do show version refused');
      if (env.s.mode !== entry.mode) bad.push(kind + ' [' + entry.mode + ']: do moved the mode to ' + env.s.mode);
      if (env.s.prompt() !== before) bad.push(kind + ' [' + entry.mode + ']: do changed the prompt');
      env.s.run('show clock');
      if (env.s.mode !== entry.mode) bad.push(kind + ' [' + entry.mode + ']: show clock moved the mode');
    }
  }
  ok(probes > 40, 'the sweep entered the modes on every kind it can (' + probes + ')');
  ok(bad.length === 0, 'and no read moved the prompt' + (bad.length ? ' - ' + bad.slice(0, 3).join(' | ') : ''));
}

console.log('\nThe prompt names the mode the parser is in:');
{
  const bad = [];
  let probes = 0;
  for (const kind of Object.keys(byKind)) {
    for (const entry of ENTRIES) {
      const env = fresh(byKind[kind]);
      env.s.run('enable');
      entry.enter.map(function (l) { return l.replace('PORT', env.port); }).forEach(function (l) { env.s.run(l); });
      if (env.s.mode !== entry.mode) continue;
      probes++;
      const prompt = env.s.prompt() || '';
      if (!entry.prompt.test(prompt)) bad.push(kind + ' [' + entry.mode + ']: "' + prompt + '"');
    }
  }
  ok(probes > 40, 'every mode was entered (' + probes + ')');
  ok(bad.length === 0, 'and each prompt carries its own level' + (bad.length ? ' - ' + bad.slice(0, 3).join(' | ') : ''));
}

console.log('\nexit goes up one level, end goes to privileged exec:');
{
  const bad = [];
  let probes = 0;
  for (const kind of Object.keys(byKind)) {
    for (const entry of ENTRIES) {
      const env = fresh(byKind[kind]);
      env.s.run('enable');
      entry.enter.map(function (l) { return l.replace('PORT', env.port); }).forEach(function (l) { env.s.run(l); });
      if (env.s.mode !== entry.mode) continue;
      probes++;
      env.s.run('exit');
      if (env.s.mode !== entry.up) {
        bad.push(kind + ' [' + entry.mode + ']: exit landed in ' + env.s.mode + ', not ' + entry.up);
      }
      const e2 = fresh(byKind[kind]);
      e2.s.run('enable');
      entry.enter.map(function (l) { return l.replace('PORT', e2.port); }).forEach(function (l) { e2.s.run(l); });
      e2.s.run('end');
      if (e2.s.mode !== 'enable') bad.push(kind + ' [' + entry.mode + ']: end landed in ' + e2.s.mode);
    }
  }
  ok(probes > 40, 'the exits were walked on every mode (' + probes + ')');
  ok(bad.length === 0, 'and each went exactly one level' + (bad.length ? ' - ' + bad.slice(0, 3).join(' | ') : ''));
}

console.log('\nWhat a block configures survives the saved copy:');
{
  // Only a device that can serve DHCP, hold an ACL, run OSPF or run BGP enters these modes, so the
  // sweep is short by construction - and it is exactly the blocks the config round-trip never visited.
  const VALUES = {
    addr: '10.0.0.1', address: '10.0.0.1', ip: '10.0.0.1', net: '10.9.0.0', mask: '255.255.255.0',
    wildcard: '0.0.0.255', gateway: '10.0.0.1', low: '10.9.0.1', high: '10.9.0.5', start: '10.9.0.1',
    end: '10.9.0.9', server: '10.0.0.53', host: 'host1.lab', name: 'lab', peer: '10.0.0.2',
    'next-hop': '10.0.0.2', as: '65001', acl: '10', id: '1', sec: '60', s: '60', n: '10', num: '10',
    priority: '100', count: '10', 'process-id': '1', domain: 'lab.example', entry: 'permit ip any any',
    type: 'standard', protocol: 'ip', proto: 'tcp', src: '10.0.0.1', dst: '10.0.0.2', any: 'any'
  };
  const BLOCKS = [
    ['dhcp', ['configure terminal', 'ip dhcp pool lab']],
    ['acl', ['configure terminal', 'ip access-list standard lab']],
    ['ospf', ['configure terminal', 'router ospf 1']],
    ['bgp', ['configure terminal', 'router bgp 65001']]
  ];
  function dump(s) { s.run('end'); return text(s.run('show running-config')).replace(/\r/g, ''); }
  let checked = 0;
  const bad = [];
  for (const kind of Object.keys(byKind)) {
    for (const block of BLOCKS) {
      const probe = fresh(byKind[kind]);
      probe.s.run('enable');
      block[1].forEach(function (l) { probe.s.run(l); });
      if (probe.s.mode !== block[0]) continue;
      const rows = probe.s._helpFormRowsAll(probe.s.mode) || [];
      for (const row of rows) {
        const toks = row.tokens || [];
        if (!toks.length) continue;
        // Not an exemption, ordinary control flow: a read and a mode change are not settings this
        // sweep can apply and compare.
        if (toks.some(function (x) { return typeof x === 'string' && /^(show|do|exit|end|no)$/.test(x); })) continue;
        const filled = toks.map(function (x) {
          if (typeof x === 'string') return x;
          const v = VALUES[String(x.placeholder || '').toLowerCase()];
          return v === undefined ? null : v;
        });
        if (filled.some(function (v) { return v === null; })) continue;
        const line = filled.join(' ');
        if (probe.s._helpRefusal(line)) continue;
        const a = fresh(byKind[kind]);
        a.s.run('enable');
        block[1].forEach(function (l) { a.s.run(l); });
        const ans = text(a.s.run(line));
        if (/^\s*%/.test(ans) || /\n\s*%/.test(ans)) continue;   // refused: not this invariant
        checked++;
        const dump1 = dump(a.s);
        const b = fresh(byKind[kind]);
        b.s.run('enable'); b.s.run('configure terminal');
        for (const l of dump1.split('\n')) {
          const t = l.trim();
          // Not an exemption, ordinary control flow: the dump's own furniture is not a command.
          if (!t || /^(Building|Current|!|end$|:)/i.test(t)) continue;
          b.s.run(t);
        }
        b.s.run('end'); b.s.run('end'); b.s.run('configure terminal');
        block[1].slice(1).forEach(function (l) { b.s.run(l); });
        if (b.s.mode !== block[0]) {
          bad.push(kind + ' [' + block[0] + "]: '" + line + "' - the saved copy does not reopen the block");
          continue;
        }
        const d2a = dump(b.s);
        b.s.run('end'); b.s.run('end'); b.s.run('configure terminal');
        block[1].slice(1).forEach(function (l) { b.s.run(l); });
        const again = text(b.s.run(line));
        if (/^\s*%/.test(again)) {
          bad.push(kind + ' [' + block[0] + "]: '" + line + "' - refused after the copy was reloaded");
          continue;
        }
        if (dump(b.s) !== d2a) {
          bad.push(kind + ' [' + block[0] + "]: '" + line + "' - re-applying it changed the copy again");
        }
      }
    }
  }
  ok(checked > 50, 'the blocks were tested with the settings they offer (' + checked + ')');
  ok(bad.length === 0, 'and every one of them round-tripped'
    + (bad.length ? ' - ' + bad.slice(0, 3).join(' | ') : ''));
}

console.log('\nA merge copy says what it did, and cannot say two things at once:');
{
  const t = new Topology();
  const d = t.addDevice(find('generic-router')); d.name = 'R1';
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable'); s.run('configure terminal'); s.run('hostname R1');
  s.run('interface Gi0/0'); s.run('ip address 10.0.0.1 255.255.255.0'); s.run('end');
  s.run('write memory');
  // Nothing to do: the words are "lines read" and "changed nothing", never "applied" beside "unchanged".
  const same = text(s.run('copy startup-config running-config'));
  ok(/lines? read/.test(same), 'a copy that changes nothing says the lines were read');
  ok(/none of them changed anything/.test(same), 'and that none of them changed anything');
  ok(!/lines? applied/.test(same), 'and does not also claim they were applied');
  // A change: the saved copy puts back what an operator removed.
  s.run('configure terminal'); s.run('no hostname'); s.run('end');
  const changed = text(s.run('copy startup-config running-config'));
  ok(/lines? applied/.test(changed), 'a copy that changes something says applied');
  ok(/hostname/.test(changed), 'and names what came back (' + changed.split('\n').slice(1, 2).join(' ') + ')');
  ok(/this is a merge/.test(changed), 'and that a merge keeps what the copy does not mention');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
