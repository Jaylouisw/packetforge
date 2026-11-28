'use strict';
// `vlan 20` on a switch that already has VLAN 20 is a selection, not a creation (#1666).
//
//   sw1(config)# vlan 20 name sales
//   VLAN 20 created (name: sales)
//   sw1(config)# vlan 20
//   VLAN 20 created (name: VLAN0020)      <- "sales" is gone, and the receipt says "created"
//   sw1# show vlan brief
//   20   VLAN0020                        active
//
// Two faults in one line, and the second is what made the first invisible. A real box changes a VLAN name
// through the `name` keyword only; `vlan <id>` on an id that exists enters VLAN configuration mode and leaves
// the record alone. The vendor states it twice, from both ends of the same edit:
//
//   * Consolidated Platform Command Reference, Cisco IOS Release 15.2(7)E (Catalyst 2960-X), `vlan` - "When
//     you enter the VLAN ID of an existing VLAN, you do not create a new VLAN, but you can modify VLAN
//     parameters for that VLAN."
//     https://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/command_reference/b_1527_2960x_cr/vlan_commands.html
//   * VLAN Command Reference, Cisco IOS XE Release 3SE (Catalyst 3850), `vlan` / `exit` - "When you enter the
//     exit VLAN configuration command, the VLAN is added if it did not already exist; otherwise, this
//     command does nothing."
//     https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3850/software/release/3se/vlan/command_reference/b_vlan_3se_3850_cr/b_vlan_3se_3850_cr_chapter_010.pdf
//
// A real box prints nothing for either case - there is no receipt for a no-op - so the sentences pinned here
// are this console's, in the shape the `ip route` door answers a repeated statement with (#1659). What this
// suite is really about is the record: a name an operator typed must not be replaced by the name the box
// would have generated, and `created` must mean created.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.error('  FAIL ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

function lab() {
  const t = new Topology();
  const d = t.addDevice(SWITCH, 'sw1');
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  s.run('configure terminal');
  const ether = [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  return {
    t: t, d: d, s: s,
    p: ether[0].name,
    run: function (cmds) {
      const out = [];
      for (const c of cmds) for (const l of (s.run(c).output || [])) out.push(String(l));
      return out;
    },
    name: function (id) { return d.config.vlans && d.config.vlans[id] ? d.config.vlans[id].name : null; },
    // Reads the table and leaves the session in configuration mode, where it found it: end and
    // configure terminal bracket the read, so a caller may keep typing config lines afterwards.
    row: function (id) {
      const said = [];
      for (const c of ['end', 'show vlan brief', 'configure terminal']) {
        for (const l of (this.s.run(c).output || [])) said.push(String(l));
      }
      return said.filter(function (l) { return new RegExp('^' + id + ' ').test(l); })[0] || null;
    }
  };
}

console.log('');
console.log('A bare re-entry selects the VLAN and leaves its name alone:');
{
  const env = lab();
  const first = env.run(['vlan 20 name sales']);
  ok(first.length === 1 && first[0] === 'VLAN 20 created (name: sales)',
    'naming a VLAN that does not exist creates it, and the receipt says created', JSON.stringify(first));
  const again = env.run(['vlan 20']);
  ok(env.name(20) === 'sales', 'the typed name survives `vlan 20`', String(env.name(20)));
  ok(again.length === 1 && again[0] === 'VLAN 20 already exists (name: sales): nothing was changed',
    'and the receipt no longer claims a creation', JSON.stringify(again));
  const row = env.row(20);
  ok(!!row && /sales/.test(row), '`show vlan brief` still lists the VLAN under that name', String(row));
  ok(!!row && !/VLAN0020/.test(row), 'and nowhere prints the generated name', String(row));
}

console.log('');
console.log('The same name typed again is the same statement, not a change:');
{
  const env = lab();
  env.run(['vlan 20 name sales']);
  const out = env.run(['vlan 20 name sales']);
  ok(out.length === 1 && out[0] === 'VLAN 20 already exists (name: sales): nothing was changed',
    'a repeated `vlan 20 name sales` adds nothing and says nothing was changed', JSON.stringify(out));
  ok(env.name(20) === 'sales', 'and the record is still `sales`');
  const made = env.run(['vlan 30']);
  const twice = env.run(['vlan 30']);
  ok(made[0] === 'VLAN 30 created (name: VLAN0030)', 'a new VLAN is still created', JSON.stringify(made));
  ok(twice[0] === 'VLAN 30 already exists (name: VLAN0030): nothing was changed',
    'a plain re-creation of a default-named VLAN is not a creation either', JSON.stringify(twice));
}

console.log('');
console.log('A different name is a rename, and the receipt carries both names:');
{
  const env = lab();
  env.run(['vlan 20 name sales']);
  const out = env.run(['vlan 20 name ops']);
  ok(out.length === 1 && out[0] === 'VLAN 20 renamed (name: sales -> ops)',
    'the change is reported as a rename, naming what it replaced', JSON.stringify(out));
  ok(env.name(20) === 'ops', 'and the VLAN now holds the new name', String(env.name(20)));
  ok(/ops/.test(env.row(20)), 'the table shows it', String(env.row(20)));
  const bare = env.run(['vlan 20 provisioning']);
  ok(bare[0] === 'VLAN 20 renamed (name: ops -> provisioning)',
    '`vlan 20 provisioning` renames too, rather than storing a second VLAN', JSON.stringify(bare));
}

console.log('');
console.log('A VLAN that does not exist is still created, in every spelling:');
{
  const env = lab();
  ok(env.run(['vlan 40'])[0] === 'VLAN 40 created (name: VLAN0040)', 'bare id');
  ok(env.run(['vlan 41 name lab'])[0] === 'VLAN 41 created (name: lab)', '`name` keyword');
  ok(env.run(['vlan 42 lab'])[0] === 'VLAN 42 created (name: lab)', 'bare word');
  ok(env.run(['no vlan 40'])[0] === 'VLAN 40 removed', 'the VLAN is removed');
  ok(env.run(['vlan 40'])[0] === 'VLAN 40 created (name: VLAN0040)', 'and re-creating it says created');
}

console.log('');
console.log('A VLAN a port made is not "created" by the console door:');
{
  const env = lab();
  const made = env.run(['interface ' + env.p, 'switchport access vlan 44']);
  ok(made[0] === '% Access VLAN does not exist. Creating vlan 44',
    'the port door announces the creation, in the vendor sentence', JSON.stringify(made));
  const out = env.run(['end', 'configure terminal', 'vlan 44'])
    .filter(function (l) { return !/^Enter configuration commands/.test(l); });
  ok(env.name(44) === 'VLAN0044', 'the port-made VLAN keeps the name it was given');
  ok(out.length === 1 && out[0] === 'VLAN 44 already exists (name: VLAN0044): nothing was changed',
    'and the console door says so rather than creating it a second time', JSON.stringify(out));
  const renamed = env.run(['vlan 44 name voice']);
  ok(renamed[0] === 'VLAN 44 renamed (name: VLAN0044 -> voice)',
    'a name may still be given to it afterwards, as a rename', JSON.stringify(renamed));
}

console.log('');
console.log('The printed config replays without losing a name:');
{
  const env = lab();
  env.run(['vlan 20 name sales', 'vlan 30']);
  const cfg = env.run(['end', 'show running-config'])
    .filter(function (l) { return /^vlan /.test(l.trim()); });
  ok(cfg.some(function (l) { return l.trim() === 'vlan 20 sales'; }),
    '`show running-config` carries the typed name', JSON.stringify(cfg));
  ok(cfg.some(function (l) { return l.trim() === 'vlan 30'; }),
    'and the id alone for the one nothing named', JSON.stringify(cfg));
  const back = env.run(['configure terminal'].concat(cfg.map(function (l) { return l.trim(); })))
    .filter(function (l) { return /^VLAN /.test(l); });
  ok(env.name(20) === 'sales' && env.name(30) === 'VLAN0030',
    'the replay leaves both records exactly as they were',
    JSON.stringify(env.d.config.vlans));
  ok(back.length === 2 && back.every(function (l) { return /^VLAN \d+ already exists/.test(l); }),
    'and every line of the replay answers "already exists"', JSON.stringify(back));
}

console.log('');
console.log('VLAN 1 keeps its own answer:');
{
  const env = lab();
  const out = env.run(['vlan 1']);
  ok(out.length === 1 && !/created/.test(out[0]) && /already exists/.test(out[0]),
    '`vlan 1` still describes the default VLAN, and still does not claim a creation', JSON.stringify(out));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
