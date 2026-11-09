'use strict';
// `no switchport <leaf>` removes one leaf (#1287).
//
// Every `no switchport ...` form fell through to one handler:
//
//   no switchport access vlan    -> "Switchport reset to defaults on Fa0/1 (access VLAN 1)"
//   no switchport trunk native vlan 20
//   no switchport trunk allowed vlan
//   no switchport mode
//
// So removing one leaf cleared the mode, the access VLAN, the native VLAN and the allowed list together - five
// fields gone, announced as a reset. Two more consequences: the reset left `allowedVlans: []`, which the
// printer rendered as a bare `switchport trunk allowed vlan` line that the console answers with
// `% Incomplete command`; and a port already at defaults was told it had just been reset.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const vlanLib = require('../engine/vlan');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];

function lab() {
  const t = new Topology();
  const d = t.addDevice(SWITCH, 'sw');
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  s.run('configure terminal');
  const p = [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; })[0].name;
  s.run('interface ' + p);
  return { t: t, d: d, s: s, p: p,
    say: function (c) { return ((s.run(c).output) || []).map(String); },
    vlan: function () { return d.interfaces.get(p).vlan; },
    config: function () { s.run('end'); const out = ((s.run('show running-config').output) || []).map(String); return out; } };
}

// Everything the switchport surface stores, as one comparable string.
function snapshot(env) {
  const v = env.vlan();
  return [v.mode, v.accessVlan, v.nativeVlan, JSON.stringify(v.allowedVlans), v.voiceVlan].join('|');
}

// A port with every switchport field set to something non-default, in trunk mode.
function dressed(env) {
  env.say('switchport mode trunk');
  env.say('switchport access vlan 30');
  env.say('switchport trunk native vlan 20');
  env.say('switchport trunk allowed vlan 10,20');
  return env;
}

console.log('');
console.log('Each leaf negation removes its own leaf and nothing else:');
{
  const cases = [
    { cmd: 'no switchport access vlan', field: 'accessVlan', want: 1 },
    { cmd: 'no switchport trunk native vlan', field: 'nativeVlan', want: 1 },
    { cmd: 'no switchport trunk allowed vlan', field: 'allowedVlans', want: 'all' }
  ];
  for (const c of cases) {
    const env = dressed(lab());
    const before = env.vlan();
    const untouched = {
      mode: before.mode, accessVlan: before.accessVlan, nativeVlan: before.nativeVlan,
      allowedVlans: before.allowedVlans
    };
    const out = env.say(c.cmd);
    const after = env.vlan();
    ok(JSON.stringify(after[c.field]) === JSON.stringify(c.want),
      c.cmd + ': ' + c.field + ' is back to ' + JSON.stringify(c.want), JSON.stringify(after[c.field]));
    const others = Object.keys(untouched).filter(function (k) { return k !== c.field; });
    const kept = others.every(function (k) {
      return JSON.stringify(after[k]) === JSON.stringify(untouched[k]);
    });
    ok(kept, c.cmd + ': and the other three fields are untouched', JSON.stringify(after) + ' vs ' + JSON.stringify(untouched));
    ok(after.mode === 'trunk', c.cmd + ': the port is still a trunk', after.mode);
    ok(out.join(' ').indexOf('reset to defaults') === -1,
      c.cmd + ': and it does not claim to have reset the port', JSON.stringify(out));
  }
}

console.log('');
console.log('`no switchport mode` changes the mode and keeps the parameters:');
{
  const env = dressed(lab());
  const out = env.say('no switchport mode');
  const v = env.vlan();
  ok(v.mode === 'access', 'the port is an access port again', v.mode);
  ok(v.nativeVlan === 20 && JSON.stringify(v.allowedVlans) === JSON.stringify([10, 20]) && v.accessVlan === 30,
    'with every trunk and access parameter still stored', JSON.stringify(v));
  ok(/trunk settings kept: native 20, allowed 10,20/.test(out.join(' ')),
    'and the console says they were kept, and what they are', JSON.stringify(out));

  // ...so going back is one command, not four.
  env.say('switchport mode trunk');
  const back = env.vlan();
  ok(back.mode === 'trunk' && back.nativeVlan === 20 && JSON.stringify(back.allowedVlans) === JSON.stringify([10, 20]),
    'and `switchport mode trunk` puts it back with the same settings', JSON.stringify(back));
}

console.log('');
console.log('`no switchport` resets the port, and says what it changed:');
{
  const env = dressed(lab());
  const out = env.say('no switchport').join(' ');
  const v = env.vlan();
  ok(v.mode === 'access' && Number(v.accessVlan) === 1 && Number(v.nativeVlan) === 1 &&
    v.allowedVlans === 'all', 'every field is back to its default', JSON.stringify(v));
  ok(/mode trunk -> access/.test(out), 'the message names the mode change', out);
  ok(/access VLAN 30 -> 1/.test(out), 'and the access VLAN', out);
  ok(/native VLAN 20 -> 1/.test(out), 'and the native VLAN', out);
  ok(/allowed list -> all/.test(out), 'and the allowed list', out);
  ok(out.indexOf('reset to defaults') !== -1, 'as a reset', out);

  // A second reset has nothing to do, and must not claim otherwise.
  const again = env.say('no switchport').join(' ');
  ok(/^% /.test(again) && /already has default switchport settings/.test(again),
    'a port already at defaults is told so instead of being "reset" again', again);
}

console.log('');
console.log('Removing what is not there refuses, and names what is there:');
{
  const env = lab();
  const cases = [
    ['no switchport access vlan', /access VLAN is already the default \(1\)/],
    ['no switchport trunk native vlan', /trunk native VLAN is already the default \(1\)/],
    ['no switchport trunk allowed vlan', /trunk already allows all VLANs/],
    ['no switchport mode', /is already in access mode/],
    ['no switchport', /already has default switchport settings/]
  ];
  for (const [cmd, want] of cases) {
    const out = env.say(cmd).join(' ');
    ok(want.test(out), cmd + ' refuses at the default', out);
    ok(/^% /.test(out), cmd + ' says so as a refusal', out);
  }
  const before = snapshot(env);
  const mismatched = env.say('no switchport access vlan 30').join(' ');
  ok(/access VLAN is 1, not 30/.test(mismatched), 'a value that is not set is refused with both numbers',
    mismatched);
  ok(snapshot(env) === before, 'and nothing changed', snapshot(env));

  const env2 = dressed(lab());
  const before2 = snapshot(env2);
  const out2 = env2.say('no switchport access vlan 30').join(' ');
  ok(/Access VLAN 30 removed/.test(out2), 'the value that IS set is removed when named', out2);
  ok(snapshot(env2) !== before2, 'and that one did change the port');
}

console.log('');
console.log('Nothing reachable leaves a config the console cannot read back:');
{
  // The matrix is the point: the invariant has to hold for every state these commands can reach, not for the
  // one port a test happened to type into.
  const histories = [
    [],
    ['switchport mode trunk'],
    ['switchport trunk native vlan 20'],
    ['switchport trunk allowed vlan 10,20'],
    ['switchport access vlan 30'],
    ['switchport mode trunk', 'switchport trunk native vlan 20', 'switchport trunk allowed vlan 10,20'],
    ['switchport mode trunk', 'no switchport mode'],
    ['switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'no switchport trunk allowed vlan'],
    ['switchport mode trunk', 'no switchport'],
    ['switchport access vlan 30', 'no switchport'],
    ['switchport mode trunk', 'switchport access vlan 30', 'no switchport access vlan']
  ];
  let checked = 0, bare = [], unreplayable = [], notIdentical = [];
  for (const history of histories) {
    const env = lab();
    for (const cmd of history) env.say(cmd);
    const cfg = env.config();
    const sw = cfg.filter(function (l) { return /switchport/.test(l); });
    for (const line of sw) {
      if (/switchport trunk allowed vlan\s*$/.test(line)) bare.push(history.join(' / ') + ' -> ' + line);
    }
    // Replay the whole config into a fresh device.
    const fresh = lab();
    for (const line of cfg) {
      for (const l of (fresh.s.run(line).output || [])) {
        if (/^%/.test(String(l))) unreplayable.push(history.join(' / ') + ' -> ' + line + ' :: ' + String(l));
      }
    }
    const again = fresh.config();
    if (again.join('\n') !== cfg.join('\n')) notIdentical.push(history.join(' / '));
    checked++;
  }
  ok(bare.length === 0, 'no state prints a bare `switchport trunk allowed vlan`', JSON.stringify(bare));
  ok(unreplayable.length === 0, checked + ' states replay with nothing rejected', JSON.stringify(unreplayable.slice(0, 3)));
  ok(notIdentical.length === 0, 'and every one is byte-identical after the round trip', JSON.stringify(notIdentical));
}

console.log('');
console.log('The data plane follows, not the leftovers:');
{
  const env = dressed(lab());
  const v = env.vlan();
  function verdict(cfg, vid) {
    const a = vlanLib.classifyEgress(cfg, vid);
    return ((Array.isArray(a) ? a : [a])[0] || {}).action;
  }
  ok(verdict(v, 30) === 'drop', 'a trunk refuses the access VLAN it is only staged for', String(verdict(v, 30)));
  ok(verdict(v, 20) !== 'drop', 'and carries its native VLAN', String(verdict(v, 20)));

  env.say('no switchport trunk allowed vlan');
  ok(verdict(env.vlan(), 30) !== 'drop', 'removing the allowed list lets everything through again',
    String(verdict(env.vlan(), 30)));

  env.say('no switchport mode');
  ok(verdict(env.vlan(), 20) === 'drop', 'and back in access mode it carries only its access VLAN',
    String(verdict(env.vlan(), 20)));
}

console.log('');
console.log('A negation that changes VLAN membership flushes what the port had learned:');
{
  // Learned MACs are the one piece of state a switch cannot keep across a membership change: the entry says
  // "this MAC is on Fa0/1 in VLAN 1", and after the negation it is on a port that carries a different VLAN.
  const t = new Topology();
  const a = t.addDevice(PC, 'a');
  const sw = t.addDevice(SWITCH, 'sw');
  t.connect('a', 'eth0', 'sw', 'Fa0/1');
  const sim = new Simulator(t);
  a.interfaces.get('eth0').ip = '10.0.0.10';
  a.interfaces.get('eth0').mask = '255.255.255.0';
  a.interfaces.get('eth0').enabled = true;
  sim.ping('a', '10.0.0.99', { count: 1 });
  const learned = (sw.macTable || new Map()).size;
  ok(learned >= 1, 'the switch learned the host', String(learned));

  const s = new CliSession(sw, t, sim);
  s.run('enable'); s.run('configure terminal'); s.run('interface Fa0/1');
  s.run('switchport access vlan 20');
  s.run('no switchport access vlan');
  ok((sw.macTable || new Map()).size === 0, 'and the entry did not survive the VLAN change and its removal',
    String((sw.macTable || new Map()).size));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
