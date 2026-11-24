'use strict';
// A port assigned to a VLAN that does not exist makes that VLAN (#1535).
//
// On a Cisco switch `switchport access vlan 22`, when VLAN 22 has never been created, answers with one line
// and applies the assignment anyway:
//
//     Switch(config-if)# switchport access vlan 22
//     % Access VLAN does not exist. Creating vlan 22
//
// (Layer 2 Configuration Guide, Cisco IOS XE 17.14.x, Catalyst 9300, "Example: Configuring an IEEE 802.1Q
// Tunneling Port"; the Catalyst 9500 17.12 chapter of the same name prints the identical line. It is one
// sentence - a `%` error and the notice it carries - and research/vlan-autocreate-notice-line.md records
// why this console used to print it as two.)
// `show vlan` lists VLAN 22 afterwards, and `show running-config` has a `vlan 22` line, because the VLAN really
// is in the VLAN database - not only in the port's configuration.
//
// This console used to move the port and say nothing about the VLAN. `show vlan` still grew a row (it builds
// the id set from the port table too), so the table and the port agreed while the running-config did not: the
// same hole #1232 closed for VLANs somebody typed `vlan 22` for, left open on the one command that can make a
// VLAN without anybody typing `vlan`.
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

function lab() {
  const t = new Topology();
  const d = t.addDevice(SWITCH, 'sw1');
  const sim = new Simulator(t);
  const s = new CliSession(d, t, sim);
  s.run('enable');
  s.run('configure terminal');
  const ether = [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  return {
    t: t, d: d, sim: sim, s: s,
    p: ether[0].name, q: ether[1].name,
    run: function (cmds) {
      const out = [];
      for (const c of cmds) for (const l of (s.run(c).output || [])) out.push(String(l));
      return out;
    },
    vlan: function () { return d.interfaces.get(ether[0].name).vlan; }
  };
}

console.log('');
console.log('A VLAN that does not exist is created, and the console says so:');
{
  const env = lab();
  const out = env.run(['interface ' + env.p, 'switchport access vlan 44']);
  // Exactly the line the vendor prints, before anything else, and no second line about the same VLAN.
  ok(out.length >= 1 && out[0] === '% Access VLAN does not exist. Creating vlan 44',
    'the first line is the vendor sentence, whole, naming the VLAN it made', JSON.stringify(out));
  ok(env.vlan().accessVlan === 44, 'and the assignment is applied anyway', JSON.stringify(env.vlan()));
  ok(env.d.config.vlans && env.d.config.vlans[44] && env.d.config.vlans[44].name === 'VLAN0044',
    'the VLAN is in the VLAN database, under the name `vlan 44` would have given it',
    JSON.stringify(env.d.config.vlans));
}

console.log('');
console.log('The three views agree about it:');
{
  const env = lab();
  env.run(['interface ' + env.p, 'switchport access vlan 44', 'end']);
  const cfg = env.run(['show running-config']).filter(function (l) { return l.trim(); });
  // The line carries the id alone. VLAN 44's name is `VLAN0044` only because nothing named it, and a box
  // does not write the name it would have generated (research/running-config-vlan-default-name.md): Cisco's
  // transparent-mode capture lists never-named VLANs as `vlan 20-21,50-51` with no `name` sub-line. This
  // assertion used to pin `vlan 44 VLAN0044`, which is the line the console printed, not the line a box does.
  ok(cfg.some(function (l) { return l.trim() === 'vlan 44'; }),
    '`show running-config` carries the VLAN line, with the id alone',
    JSON.stringify(cfg.filter(function (l) { return /^vlan /.test(l); })));
  const show = env.run(['show vlan']);
  const row = show.filter(function (l) { return /^44\s/.test(l); })[0];
  ok(!!row, '`show vlan` lists it', JSON.stringify(show));
  ok(row && /VLAN0044/.test(row) && /Fa0\/1/.test(row), 'with the generated name and the port that made it', row);
  // And it survives being copied out and pasted back, which is the point of the running-config line.
  const t2 = new Topology();
  const d2 = t2.addDevice(SWITCH, 'sw1');
  const s2 = new CliSession(d2, t2, new Simulator(t2));
  s2.run('enable');
  s2.run('configure terminal');
  const back = [];
  for (const line of cfg.filter(function (l) { return !/^!/.test(l); })) {
    for (const l of (s2.run(line).output || [])) back.push(String(l));
  }
  // A real switch prints the same notice here: `show running-config` writes the interface stanzas before the
  // `vlan` lines, so the paste assigns the port before the VLAN is declared. The only line the paste may
  // complain about is that notice - anything else is a config the printer cannot read back.
  const AUTO = /^% Access VLAN does not exist\. Creating vlan \d+$/;
  const complaints = back.filter(function (l) { return /^%/.test(l) && !AUTO.test(l); });
  ok(!complaints.length, 'the printed config reads back, with only the auto-create notice the paste earns',
    JSON.stringify(complaints));
  ok(d2.config.vlans && d2.config.vlans[44], 'and VLAN 44 is there after the paste',
    JSON.stringify(d2.config.vlans));
}

console.log('');
console.log('It is said once, and only when there is something to make:');
{
  const env = lab();
  env.run(['interface ' + env.p, 'switchport access vlan 44']);
  const again = env.run(['switchport access vlan 44']);
  ok(!again.some(function (l) { return /Access VLAN does not exist|Creating vlan/.test(l); }),
    'assigning the same VLAN twice announces nothing the second time', JSON.stringify(again));

  const env1 = lab();
  const one = env1.run(['interface ' + env1.p, 'switchport access vlan 1']);
  ok(!one.some(function (l) { return /Creating vlan/.test(l); }),
    'VLAN 1 is not created - every switch has it already', JSON.stringify(one));

  const env2 = lab();
  const typed = env2.run(['vlan 20 twenty', 'interface ' + env2.q, 'switchport access vlan 20']);
  ok(!typed.some(function (l) { return /Access VLAN does not exist|Creating vlan/.test(l); }),
    'a VLAN somebody created with `vlan 20` is not announced as missing', JSON.stringify(typed));
  ok(env2.d.config.vlans[20].name === 'twenty', 'and its name is the one they typed, not the generated one',
    JSON.stringify(env2.d.config.vlans[20]));
}

console.log('');
console.log('A port staged for a trunk still learns what it was told:');
{
  const env = lab();
  env.run(['interface ' + env.p, 'switchport mode trunk']);
  const out = env.run(['switchport access vlan 44']);
  ok(out.some(function (l) { return /Creating vlan 44/.test(l); }),
    'the VLAN is still made, and the console still says so', JSON.stringify(out));
  ok(out.join(' ').indexOf('stored; the port is in trunk mode') !== -1,
    'the note about the mode survives, because the port is not using the value yet', JSON.stringify(out));
  ok(env.vlan().mode === 'trunk' && env.vlan().accessVlan === 44,
    'the mode is untouched and the access VLAN is staged', JSON.stringify(env.vlan()));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
