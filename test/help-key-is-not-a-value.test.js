'use strict';
// `?` is the key an operator presses to ask what goes here, and in the three free-text positions this console
// stored the key as the text itself (#1685):
//
//   hostname ?          renamed the box to "?" and printed nothing. The only way to find out was to look at a
//                       surface that shows the name - and the receipt that `hostname edge-1` gives is a prompt,
//                       not a line, so the silent case looked exactly like the successful one;
//   dns zone ?          answered "DNS zone ? ready" and wrote `dns zone ?` into the running-config, so a
//                       keypress left a zone nobody asked for and later `dns add` calls resolved under it;
//   vlan 42 name ?      created VLAN 42 and named it "?", printed "VLAN 42 created (name: ?)" - a receipt, but
//                       for a change the operator did not make.
//
// Every *typed* position already refuses the key by quoting it - `% Invalid VLAN id "?"`, `% Invalid router-id
// "?"`, `% Invalid pool name: ?` - because a value that cannot parse is a value that can be corrected. The
// free-text positions could not, because any string is a legal name, so the key became one. It is refused here,
// by name, before it can: the same defect in three places and one answer in all three.
//
// What is *not* changed, and is pinned below: a bare `hostname` is still an incomplete command (it is a short
// line, not a keypress - #1497), and a question mark inside a longer name is still part of the name, because
// only the whole value is the key.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const cli = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = function (m) { return catalog.find(function (x) { return x.model === m; }); };

function env(model) {
  const t = new Topology();
  const dev = t.addDevice(spec(model || 'ISR 4331'), 'd1');
  const sim = new Simulator(t);
  const s = new cli.CliSession(dev, t, sim);
  const said = [];
  // The answer to *this* command: a line that succeeds silently (a rename, an address) must not read as the
  // previous command's answer, which is how a test can pass on a stale refusal.
  const say = function (cmd) {
    const res = s.run(cmd) || {};
    const lines = res.output || [];
    lines.forEach(function (o) { said.push(o); });
    return lines.length ? lines[lines.length - 1] : '';
  };
  s.run('enable');
  return { t: t, dev: dev, s: s, sim: sim, say: say, said: said, run: function (c) { return s.run(c) || {}; } };
}

function config(e) {
  return ((e.run('show running-config').output) || []).join('\n');
}

section('1. `hostname ?` refuses the key instead of renaming the box');
{
  const e = env('ISR 4331');
  const was = e.dev.name;
  const wasCfg = e.dev.config.hostname;
  e.say('configure terminal');
  const said = e.say('hostname ?');
  ok(/^\s*%/.test(said), 'the answer is a refusal, not the silence a successful rename gives', said);
  ok(/help key/.test(said), 'and it names the key for what it is', said);
  ok(/hostname <name>/.test(said), 'and repeats the syntax that wanted a name', said);
  ok(/unchanged/.test(said), 'and says the name did not change', said);
  ok(e.dev.name === was, 'the box still answers to its old name', e.dev.name);
  ok(e.dev.config.hostname === wasCfg, 'and its config holds no new hostname', String(e.dev.config.hostname));
  ok(!/hostname \?/.test(config(e)), 'nothing called "?" reached the running-config');
}

section('2. the other refused, unchanged: a bare `hostname`, and a `?` inside a longer name');
{
  const e = env('ISR 4331');
  e.say('configure terminal');
  const bare = e.say('hostname');
  ok(/Incomplete command: hostname/.test(bare), 'a bare `hostname` is still a short line, not a keypress', bare);
  const inner = e.say('hostname edge?1');
  ok(!/^\s*%/.test(inner), 'a question mark inside a longer name is still part of the name', inner);
  ok(e.dev.config.hostname === 'edge?1', 'and it is stored as typed', String(e.dev.config.hostname));
  ok(/hostname edge\?1/.test(config(e)), 'and printed back by the running-config');
}

section('3. `dns zone ?` creates no zone called "?"');
{
  const e = env('ISR 4331');
  e.say('configure terminal');
  const said = e.say('dns zone ?');
  ok(/^\s*%/.test(said), 'the answer is a refusal, not "DNS zone ? ready"', said);
  ok(/help key/.test(said) && /dns zone <name>/.test(said), 'it names the key and the syntax', said);
  ok(!(e.dev.config.dnsZones || []).length, 'no zone was created', JSON.stringify((e.dev.config.dnsZones || []).map(function (z) { return z.name; })));
  ok(!/dns zone \?/.test(config(e)), 'and the running-config has no `dns zone ?` line');
  const good = e.say('dns zone lab.test');
  ok(/DNS zone lab\.test ready/.test(good), 'a real apex still opens a zone', good);
  ok(e.dev.config.dnsZones.length === 1, 'exactly one zone, the named one', String(e.dev.config.dnsZones.length));
}

section('4. `vlan 42 name ?` creates nothing and renames nothing');
{
  const e = env('Catalyst2960');
  e.say('configure terminal');
  const said = e.say('vlan 42 name ?');
  ok(/^\s*%/.test(said), 'the answer is a refusal, not "VLAN 42 created (name: ?)"', said);
  ok(/help key/.test(said) && /vlan .*name <text>/.test(said), 'it names the key and the syntax', said);
  ok(!/^\s*vlan 42/m.test(config(e)), 'no `vlan 42` line reached the running-config');
  const table = ((e.run('show vlan').output) || []).join('\n');
  ok(!/^\s*42\s/m.test(table), 'and `show vlan` does not list a VLAN 42 either');
  const good = e.say('vlan 42 name lab');
  ok(/VLAN 42 created \(name: lab\)/.test(good), 'a real name still creates the VLAN', good);
  ok(/^\s*vlan 42 lab$/m.test(config(e)), 'and prints as `vlan 42 lab`', config(e).split('\n').filter(function (l) { return /vlan 42/.test(l); }).join(' | '));
}

console.log('\n' + (failed ? 'FAILED' : 'OK') + ' \u2014 ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
