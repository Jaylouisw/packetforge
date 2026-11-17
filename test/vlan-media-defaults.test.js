'use strict';
// The four FDDI / Token Ring defaults cannot be deleted, and the refusal has to say so.
//
// `show vlan` prints five rows on a switch nobody has configured: VLAN 1 and 1002-1005. The removal command
// answered `no vlan 1002` with "% VLAN 1002 does not exist" - about a row the table had just printed, in the
// same session. The device's rule is stated flatly in its own range table:
//
//   | 1002-1005 | Normal | Cisco defaults for FDDI and Token Ring. You cannot delete VLANs 1002-1005. |
//
// (Catalyst 6500 15.4SY software configuration guide, Table 26-1
//  https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst6500/ios/15-4SY/config_guide/sup6T/15_3_sy_swcg_6T/vlans.html ;
//  Catalyst 3560 12.2(25)SEA guide, Table 17-1) and twice more in the VLAN chapters - "VLAN IDs 1 and 1002 to
// 1005 are automatically created and cannot be removed" and "You cannot delete the default VLANs for the
// different media types: Ethernet VLAN 1 and FDDI or Token Ring VLANs 1002 to 1005" (2960-CX/3560-CX 15.2(4)E,
// 3850 3.2.0SE, "Configuring VLANs").
//
// The same table also settles what the refusal may NOT say: its Reserved row is "0, 4095 | For system use only",
// and 1002-1005 sits under Normal. So "reserved by IEEE 802.1Q (1002-1005)" - which both the console and the
// port validator printed - attributed a Cisco media default to the standard. research/vlan-media-defaults.md.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const ROUTER = catalog.filter(function (s) {
  return s.category === 'router' && (s.capabilities || []).indexOf('l3-forward') !== -1;
})[0];

const NAMES = { 1002: 'fddi-default', 1003: 'token-ring-default', 1004: 'fddinet-default', 1005: 'trnet-default' };

function say(dev, t, sim, cmds) {
  return runCommands(dev, t, sim, cmds).lines.map(String);
}
function fresh(spec, id) {
  const t = new Topology();
  const dev = t.addDevice(spec, id || 'sw');
  return { t: t, dev: dev, sim: new Simulator(t) };
}
// The VLAN table's row for one id, read by column because "1002 fddi-default" has a single space after the id.
function rowFor(lines, id) {
  return lines.filter(function (l) {
    return Number(l.slice(0, 4).trim()) === id && l.charAt(0) !== ' ';
  })[0] || null;
}

console.log('A media default cannot be deleted, and the answer says why:');
{
  const L = fresh(SWITCH);
  for (const id of Object.keys(NAMES)) {
    const out = say(L.dev, L.t, L.sim, ['configure terminal', 'no vlan ' + id]);
    const answer = out.join(' | ');
    ok(!/does not exist/.test(answer), 'no vlan ' + id + ' does not claim the VLAN is absent', answer);
    ok(/cannot be deleted/.test(answer), 'no vlan ' + id + ' says it cannot be deleted', answer);
    ok(answer.indexOf(NAMES[id]) !== -1, 'and names the row it is refusing to remove (' + NAMES[id] + ')', answer);
  }
}

console.log('Nothing was removed, and the table still says all five rows:');
{
  const L = fresh(SWITCH);
  const before = say(L.dev, L.t, L.sim, ['show vlan']);
  say(L.dev, L.t, L.sim, ['configure terminal', 'no vlan 1002', 'no vlan 1003', 'no vlan 1004', 'no vlan 1005']);
  const after = say(L.dev, L.t, L.sim, ['show vlan']);
  for (const id of Object.keys(NAMES)) {
    const r = rowFor(after, Number(id));
    ok(!!r && r.indexOf(NAMES[id]) !== -1, 'VLAN ' + id + ' is still listed as ' + NAMES[id], r);
    ok(r && String(r).indexOf('act/unsup') !== -1, 'and still act/unsup', r);
  }
  ok(before.length === after.length, 'the whole table is the same size', before.length + ' -> ' + after.length);
  const cfg = say(L.dev, L.t, L.sim, ['show running-config']).join(String.fromCharCode(10));
  ok(!/^vlan 100[2-5]/m.test(cfg), 'and the running-config gained no vlan line for them', cfg.slice(0, 200));
}

console.log('A VLAN that really is absent still answers with its absence:');
{
  const L = fresh(SWITCH);
  const out = say(L.dev, L.t, L.sim, ['configure terminal', 'no vlan 1006']).join(' | ');
  ok(/VLAN 1006 does not exist/.test(out), 'no vlan 1006 keeps the old answer', out);
  const made = say(L.dev, L.t, L.sim, ['configure terminal', 'vlan 20', 'no vlan 20']);
  ok(/removed|deleted/i.test(made.join(' | ')), 'an ordinary VLAN is still removable', made.join(' | '));
  const rows = say(L.dev, L.t, L.sim, ['show vlan']);
  ok(!rowFor(rows, 20), 'and its row is gone from the table');
}

console.log('VLAN 1 is refused in its own words, unchanged:');
{
  const L = fresh(SWITCH);
  const out = say(L.dev, L.t, L.sim, ['configure terminal', 'no vlan 1']).join(' | ');
  ok(/VLAN 1 is the default VLAN/.test(out), 'no vlan 1 still names the access-port rule', out);
  ok(!/does not exist/.test(out), 'and does not deny it either', out);
}

console.log('Creating one is refused as a media default, not as an IEEE reservation:');
{
  const L = fresh(SWITCH);
  for (const id of Object.keys(NAMES)) {
    const out = say(L.dev, L.t, L.sim, ['configure terminal', 'vlan ' + id]).join(' | ');
    ok(/is reserved/.test(out), 'vlan ' + id + ' is still refused as reserved', out);
    ok(/FDDI and Token Ring/.test(out), 'and names the media it belongs to', out);
    ok(!/IEEE/.test(out), 'and no longer attributes it to IEEE 802.1Q', out);
  }
  const port = say(L.dev, L.t, L.sim, ['configure terminal', 'interface Fa0/1', 'switchport access vlan 1002']).join(' | ');
  ok(/access VLAN 1002 is reserved/.test(port), 'the port door gives the same reason', port);
  ok(!/IEEE/.test(port), 'without the IEEE attribution', port);
}

console.log('A router, which has no VLAN database, is unchanged:');
{
  const L = fresh(ROUTER, 'r1');
  const out = say(L.dev, L.t, L.sim, ['configure terminal', 'no vlan 1002']).join(' | ');
  ok(/cannot be deleted/.test(out), 'the refusal is the same rule on a box with no bridge', out);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
