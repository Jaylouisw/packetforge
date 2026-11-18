'use strict';
// VLAN 1 is not something a switch can lose.
//
// It exists before anybody types anything, and every vendor says the same about what may be done with it:
//
//   * "VLAN 1 is the default VLAN and is created during system initialization." ... "You cannot delete or
//     rename VLAN 1."                                             (Cisco C9000 VLAN Configuration Guide)
//   * "VLAN IDs 1 and 1002 to 1005 are automatically created and cannot be removed." / "You cannot delete the
//     default VLANs for the different media types: Ethernet VLAN 1..."  (Catalyst 2960 12.2(55)SE CG, VLANs)
//   * "On Catalyst 4500 series switches ... default VLANs 1 and 1002 to 1005 cannot be modified."
//                                                                 (Catalyst 4500 12.2(52)SG CG, VLANs)
//   * "VLAN1 is the default VLAN and cannot be created or deleted." ... "You cannot change the name of VLAN1."
//                                                                 (Nexus 3548 L2 Switching Guide 6.0(2))
//   * "You cannot change the name of the default VLAN."          (Extreme Switch Engine, Renaming a VLAN)
//   * and the refusal itself, on IOS XE 17.18.2:
//         ACC-SW1(config)# no vlan 1
//         %Default VLAN 1 may not be deleted.
//     which a Catalyst 2960X prints with the media VLAN's number in the same slot, and a range prints once per
//     default VLAN:
//         2960X-Gigabit(config)#no vlan 1002
//         %Default VLAN 1002 may not be deleted.
//     research/default-vlan-refusal-wording.md collects the four independent transcripts.
//
//   https://www.cisco.com/c/en/us/td/docs/switches/lan/c9000/lyr2-fwd/vlan/vlan-configuration-guide/configure-vlan.html
//   http://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_55_se/configuration/guide/scg_2960/swvlan.html
//   https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/52sg/configuration/guide/config/vlans.pdf
//   https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus3548/sw/layer_2_switching/60x/b_Cisco_N3548_Layer_2_Switching_Config_602_A1_1/b_Cisco_N3548_Layer_2_Switching_Config_602_A1_1_chapter_011.pdf
//   https://documentation.extremenetworks.com/Switch%20Engine%20v34.1.1%20User%20Guide/content/documents/Switch_Operating_Systems/Switch_Engine/User_Guide/renaming_a_vlan.shtml
//   https://www.pinglabz.com/change-native-vlan-cisco-switch/
//
// This console did the opposite of all of it. `no vlan 1` answered "% VLAN 1 does not exist" - a denial about
// the one VLAN that certainly does exist, the one `show vlan` lists as `1 default` on a switch that has never
// been configured, and the one every access port starts in. And `vlan 1` announced "VLAN 1 created (name:
// VLAN0001)" and wrote a name into the config that the box does not own: afterwards `show vlan` said the
// default VLAN was called VLAN0001, and `show running-config` carried a `vlan 1` line no real switch prints.
//
// The port door already knew the rule - `_createVlanForPort()` refuses to make VLAN 1, and the
// `vlan-auto-create` suite asserts it - so the console door was the only one arguing. Both doors now state the
// same fact: VLAN 1 exists, and it can be neither created, renamed nor deleted.
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
  return {
    t: t, d: d, sim: sim,
    // A fresh session per batch keeps the test reading like an operator, not like a fixture.
    run: function (cmds) {
      const c = new CliSession(d, t, sim);
      c.run('enable');
      c.run('configure terminal');
      const out = [];
      for (const cmd of cmds) for (const l of (c.run(cmd).output || [])) out.push(String(l));
      return out;
    },
    show: function (cmd) {
      const c = new CliSession(d, t, sim);
      c.run('enable');
      return ((c.run(cmd).output || [])).map(String);
    },
    vlanRow1: function () {
      return this.show('show vlan').filter(function (l) { return /^1\s/.test(l); })[0] || '';
    },
    running: function () { return this.show('show running-config'); }
  };
}

console.log('');
console.log('VLAN 1 exists before anything is configured, and cannot be deleted:');
{
  const env = lab();
  const row = env.vlanRow1();
  ok(/^1\s/.test(row) && /default/.test(row), 'a switch that has never been configured lists VLAN 1 named "default"', row);

  // The sentence is the box's, character for character: "%Default VLAN 1 may not be deleted." - no space after
  // the `%`, a full stop at the end, nothing else on the line. This console used to answer in its own words
  // ("...: every access port starts in it and it cannot be deleted"), which is true and is not what an operator
  // reading the console of a real switch will ever see; the reason the rule exists lives in docs/CLI.md.
  // research/default-vlan-refusal-wording.md carries the transcripts this comes from.
  const out = env.run(['no vlan 1']);
  ok(out.length === 1 && out[0] === '%Default VLAN 1 may not be deleted.',
    '`no vlan 1` is refused in the vendor sentence', JSON.stringify(out));
  ok(!/does not exist/i.test(out[0]), 'it does not claim the default VLAN is missing', out[0]);
  ok(!/^% /.test(out[0]), 'and the vendor form keeps no space after the %', out[0]);

  ok(/default/.test(env.vlanRow1()), 'VLAN 1 is still there afterwards, still named "default"', env.vlanRow1());
  ok(!env.d.config.vlans || !env.d.config.vlans[1], 'and no VLAN 1 record was written in its place',
    JSON.stringify(env.d.config.vlans));
}

console.log('');
console.log('`vlan 1` creates nothing, because there is nothing to create:');
{
  const env = lab();
  const out = env.run(['vlan 1']);
  ok(!out.some(function (l) { return /created/i.test(l); }), 'it does not announce a creation', JSON.stringify(out));
  ok(out.length === 1 && !/^%/.test(out[0]), 'it answers in prose, not as an error - the VLAN is already right',
    JSON.stringify(out));
  ok(/default VLAN/.test(out[0]) && /nothing to create/.test(out[0]),
    'and says the default VLAN already exists', out[0]);
  ok(!env.d.config.vlans || !env.d.config.vlans[1], 'no VLAN 1 record is stored', JSON.stringify(env.d.config.vlans));
  ok(/default/.test(env.vlanRow1()), '`show vlan` still calls it "default", not VLAN0001', env.vlanRow1());

  // The config a switch prints is the config a reader can paste back. A `vlan 1` line neither box has is noise
  // that a restore then has to interpret.
  env.run(['vlan 20 twenty']);
  const after = env.running();
  ok(after.some(function (l) { return /^vlan 20 twenty$/.test(l); }), 'a real VLAN does print a `vlan` line',
    JSON.stringify(after));
  ok(!after.some(function (l) { return /^vlan 1\b/.test(l); }), 'and VLAN 1 prints none', JSON.stringify(after));
}

console.log('');
console.log('The name of the default VLAN cannot be changed:');
{
  const env = lab();
  const out = env.run(['vlan 1 name Corp']);
  ok(out.length === 1 && /^%/.test(out[0]), '`vlan 1 name Corp` is refused', JSON.stringify(out));
  ok(/cannot be renamed/.test(out[0]), 'and says why - VLAN 1 cannot be renamed', out[0]);
  ok(/default/.test(env.vlanRow1()), 'the name is still "default"', env.vlanRow1());
  ok(!env.d.config.vlans || !env.d.config.vlans[1], 'and nothing was stored', JSON.stringify(env.d.config.vlans));

  // Naming it what it is already called is not a change, so it is not an error either.
  const same = env.run(['vlan 1 name default']);
  ok(!same.some(function (l) { return /^%/.test(l); }), '`vlan 1 name default` is not an error', JSON.stringify(same));
  ok(/default/.test(env.vlanRow1()), 'and leaves the name alone', env.vlanRow1());
}

console.log('');
console.log('A lab saved by an older build cannot smuggle a VLAN 1 record back in:');
{
  const env = lab();
  // Exactly what `vlan 1` used to write: a record whose name the box does not own.
  env.d.config.vlans = { 1: { name: 'Corp' }, 20: { name: 'twenty' } };
  const out = env.run(['no vlan 1']);
  ok(out.length === 1 && out[0] === '%Default VLAN 1 may not be deleted.',
    'the deletion is refused for what VLAN 1 is, not for whether a record exists', JSON.stringify(out));
  ok(env.d.config.vlans[1] && env.d.config.vlans[1].name === 'Corp', 'and the stored record is untouched',
    JSON.stringify(env.d.config.vlans));
}

console.log('');
console.log('The rule is about VLAN 1 and nothing else - other VLANs still behave:');
{
  const env = lab();
  env.run(['vlan 20 twenty']);
  const gone = env.run(['no vlan 20']);
  ok(gone[0] === 'VLAN 20 removed', '`no vlan 20` still removes VLAN 20', JSON.stringify(gone));

  const absent = env.run(['no vlan 30']);
  ok(/does not exist/.test(absent[0]), '`no vlan 30` still says a VLAN that is not there is not there', absent[0]);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
