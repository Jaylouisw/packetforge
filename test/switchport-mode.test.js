'use strict';
// A VLAN parameter is not a mode change (#1285).
//
// `switchport trunk native vlan 20`, `switchport trunk allowed vlan 10,20` and `switchport access vlan 30`
// each set the port's *mode* as a side effect. On an access port, staging a trunk with `switchport trunk
// native vlan 20` - which is what the command is for, and what real gear accepts, so the trunk can be built
// before the cable is patched - silently turned that port into a trunk: a different command, about a
// different column of the table, changed what the port forwards.
//
// The other half of the same defect: because the parameters were printed only in the mode that uses them, a
// staged trunk vanished from `show running-config` entirely and never came back.
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

function lab() {
  const t = new Topology();
  const d = t.addDevice(SWITCH, 'sw1');
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  s.run('configure terminal');
  const ifaces = [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  return { t: t, d: d, s: s, p: ifaces[0].name, q: ifaces[1].name,
    say: function (c) { return ((s.run(c).output) || []).map(String); },
    mode: function () { return d.interfaces.get(ifaces[0].name).vlan.mode; },
    vlan: function () { return d.interfaces.get(ifaces[0].name).vlan; } };
}

console.log('');
console.log('Staging a trunk leaves an access port an access port:');
{
  const env = lab();
  const out = [].concat(env.say('interface ' + env.p), env.say('switchport trunk native vlan 20'));
  ok(env.mode() === 'access', 'the mode is still access', env.mode());
  ok(env.vlan().nativeVlan === 20, 'but the native VLAN is stored', JSON.stringify(env.vlan()));
  ok(/stored; the port is in access mode/.test(out.join(' ')),
    'and the console says the value is stored rather than in use', JSON.stringify(out));
  ok(/switchport mode trunk/.test(out.join(' ')),
    'and names the command that would put it to work', JSON.stringify(out));

  const out2 = env.say('switchport trunk allowed vlan 10,20');
  ok(env.mode() === 'access', 'an allowed list does not flip it either', env.mode());
  ok(JSON.stringify(env.vlan().allowedVlans) === JSON.stringify([10, 20]), 'the list is stored',
    JSON.stringify(env.vlan().allowedVlans));
  ok(/stored; the port is in access mode/.test(out2.join(' ')), 'and says so', JSON.stringify(out2));

  const out3 = env.say('switchport trunk allowed vlan all');
  ok(env.mode() === 'access', 'nor does `allowed vlan all`', env.mode());
  ok(env.vlan().allowedVlans === 'all', 'which is stored as all', JSON.stringify(env.vlan().allowedVlans));
  ok(/stored; the port is in access mode/.test(out3.join(' ')), 'and says so', JSON.stringify(out3));
}

console.log('');
console.log('And staging an access VLAN leaves a trunk a trunk:');
{
  const env = lab();
  env.say('interface ' + env.p);
  env.say('switchport mode trunk');
  ok(env.mode() === 'trunk', 'the port is a trunk to begin with', env.mode());
  const out = env.say('switchport access vlan 30');
  ok(env.mode() === 'trunk', 'the mode is still trunk', env.mode());
  ok(env.vlan().accessVlan === 30, 'with the access VLAN stored for later', JSON.stringify(env.vlan()));
  ok(/stored; the port is in trunk mode/.test(out.join(' ')), 'and the console says what it stored',
    JSON.stringify(out));
  // Applying a parameter while already in the right mode is not an event worth a note.
  const same = env.say('switchport trunk native vlan 20');
  ok(!/stored;/.test(same.join(' ')), 'a parameter used by the current mode gets no note', JSON.stringify(same));
}

console.log('');
console.log('The data plane follows the mode, not the parameters:');
{
  const env = lab();
  env.say('interface ' + env.p);
  env.say('switchport trunk native vlan 20');
  env.say('switchport trunk allowed vlan 10,20');
  function verdict(cfg, vid) {
    const actions = vlanLib.classifyEgress(cfg, vid);
    const a = (Array.isArray(actions) ? actions : [actions])[0] || {};
    return a.action || 'none';
  }
  const cfg = env.vlan();
  ok(verdict(cfg, 20) === 'drop',
    'a staged trunk does not carry tagged VLAN 20 while the port is access',
    JSON.stringify(vlanLib.classifyEgress(cfg, 20)));
  ok(verdict(cfg, 1) !== 'drop', 'it still carries its access VLAN',
    JSON.stringify(vlanLib.classifyEgress(cfg, 1)));

  // ...and putting it to work is one command, which is the point of staging it.
  env.say('switchport mode trunk');
  const cfg2 = env.vlan();
  ok(verdict(cfg2, 20) !== 'drop', 'after `switchport mode trunk` it carries 20',
    JSON.stringify(vlanLib.classifyEgress(cfg2, 20)));
  ok(verdict(cfg2, 30) === 'drop', 'and still refuses what the allowed list omits',
    JSON.stringify(vlanLib.classifyEgress(cfg2, 30)));
}

console.log('');
console.log('`show vlan` lists the port under the VLAN it carries, not the one it is staged for:');
{
  const env = lab();
  env.say('interface ' + env.p);
  env.say('switchport trunk native vlan 20');
  env.say('end');
  const rows = env.say('show vlan');
  const row20 = rows.filter(function (l) { return /^20\s/.test(l); })[0] || '';
  const row1 = rows.filter(function (l) { return /^1\s/.test(l); })[0] || '';
  ok(row1.indexOf(env.p) !== -1, 'the port is a member of VLAN 1, which it carries', row1);
  ok(row20.indexOf(env.p) === -1, 'and not of VLAN 20, which it is only staged for', row20 || '(no VLAN 20 row)');
}

console.log('');
console.log('Nothing stored is left out of the backup, in either mode:');
{
  const env = lab();
  env.say('interface ' + env.p);
  env.say('switchport trunk native vlan 20');
  env.say('switchport trunk allowed vlan 10,20');
  env.say('switchport access vlan 30');
  env.say('end');
  const cfg = env.say('show running-config');
  const lines = cfg.filter(function (l) { return /switchport/.test(l); });
  ok(lines.length === 4, 'all four settings are printed under an access port', JSON.stringify(lines));
  ok(lines.some(function (l) { return /switchport mode access/.test(l); }), 'including the mode',
    JSON.stringify(lines));
  ok(lines.some(function (l) { return /switchport access vlan 30/.test(l); }), 'the access VLAN',
    JSON.stringify(lines));
  ok(lines.some(function (l) { return /switchport trunk native vlan 20/.test(l); }), 'the native VLAN',
    JSON.stringify(lines));
  ok(lines.some(function (l) { return /switchport trunk allowed vlan 10,20/.test(l); }), 'the allowed list',
    JSON.stringify(lines));

  // Replayed into a fresh device, it produces the same config, byte for byte.
  const fresh = lab();
  const errs = [];
  for (const line of cfg) {
    for (const l of (fresh.s.run(line).output || [])) if (/^%/.test(String(l))) errs.push(String(l));
  }
  ok(errs.length === 0, 'and the backup replays with nothing rejected', JSON.stringify(errs));
  const again = fresh.say('show running-config');
  ok(again.join('\n') === cfg.join('\n'), 'byte for byte',
    'first difference at line ' + (again.findIndex(function (l, i) { return l !== cfg[i]; }) + 1));
  ok(fresh.mode() === 'access', 'into the same mode', fresh.mode());
  ok(JSON.stringify(fresh.vlan().allowedVlans) === JSON.stringify([10, 20]),
    'and the same stored parameters', JSON.stringify(fresh.vlan()));
}

console.log('');
console.log('The trunk case keeps printing the trunk case:');
{
  const env = lab();
  env.say('interface ' + env.p);
  env.say('switchport mode trunk');
  env.say('end');
  const lines = env.say('show running-config').filter(function (l) { return /switchport/.test(l); });
  ok(lines.length === 1 && /switchport mode trunk/.test(lines[0]),
    'a trunk with default parameters prints one line, as before', JSON.stringify(lines));

  const env2 = lab();
  env2.say('interface ' + env2.p);
  env2.say('switchport access vlan 20');
  env2.say('end');
  const lines2 = env2.say('show running-config').filter(function (l) { return /switchport/.test(l); });
  ok(lines2.length === 2, 'an access port with a non-default VLAN prints two, as before',
    JSON.stringify(lines2));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
