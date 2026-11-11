'use strict';
// A typo must not become an object (#1409).
//
// Found by pointing a lens at every number in the config surface: type a word where a number belongs and see what
// the box does. Every other door refused and quoted the word - `% Invalid access list number: WORD`,
// `% Invalid virtual router id: WORD (1-255)`, `% Invalid rate "WORD"`, `% Invalid mask: WORD` - and the VLAN
// doors did not:
//
//   sw1(config)#vlan WORD
//   VLAN NaN created (name: VLAN0NaN)
//   sw1#show running-config
//   vlan NaN VLAN0NaN
//   sw1#show vlan
//   VLAN    Name                             Status    Ports
//   1       default                          active    1, 2, 3, 4            <- the NaN VLAN is not here
//
//   sw1(config-if)#switchport access vlan WORD
//   Access VLAN NaN on 1
//   sw1#show interfaces 1
//     switchport: access VLAN 1                    <- and here it is VLAN 1
//
// The root cause is one line of ordering: `normalizePortConfig()` exists to hand the engine a usable port, so it
// replaces an unreadable value with VLAN 1, and `validatePortConfig()` was handed the *normalised* copy. Every
// unusable value therefore arrived as a safe 1 and passed - NaN, 1.5 and 'WORD' alike - so the integer rule the
// validator has always had could never fire. The console then printed its own `parseInt` result instead of the
// validated value, which is why the number in the answer was one that does not exist.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const vlanLib = require('../engine/vlan');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = function (m) { return catalog.find(function (x) { return x.model === m; }); };
// A box that really switches frames: VLAN commands are refused by capability everywhere else, and a refusal for
// the wrong reason would pass this suite without proving anything.
const SWITCH = 'EKI-7708G-4FI';

function cli(t, dev, cmds) {
  return runCommands(dev, t, null, ['enable', 'configure terminal'].concat(cmds)).lines
    .filter(function (l) { return !/\(config|>enable|#configure/.test(String(l)); });
}
function show(t, dev, cmd) {
  const s = new Simulator(t);
  s.setRunTime(60000);
  return runCommands(dev, t, s, ['enable', cmd]).lines.join('\n');
}
function lab() {
  const t = new Topology();
  const d = t.addDevice(spec(SWITCH), 'sw1');
  const port = Array.from(d.interfaces.values()).filter(function (p) { return p.type === 'ethernet'; })[0].name;
  return { t: t, d: d, port: port };
}

console.log('The validator is handed the value the caller passed, not a repaired copy');
{
  const bad = [NaN, 1.5, 'WORD', '1.5', -5, 0, 4095, {}, true];
  const accepted = bad.filter(function (v) { return vlanLib.validatePortConfig({ accessVlan: v }).ok; });
  ok(accepted.length === 0, 'a value that is not a whole VLAN id is refused in every form',
    accepted.map(String).join(', '));
  // Read the refusal defensively: with the old validator these return `ok: true` and no errors at all, and a
  // crash there would hide the other twenty checks behind it.
  const refusal = function (cfg) { return vlanLib.validatePortConfig(cfg).errors[0] || {}; };
  ok(refusal({ accessVlan: NaN }).code === 'E_VLAN_RANGE',
    'with the range code the integer rule always intended');
  ok(/got NaN/.test(refusal({ accessVlan: NaN }).message || ''),
    'and it says which value it refused, not a substitute', refusal({ accessVlan: NaN }).message);
  ok(/got "WORD"/.test(refusal({ accessVlan: 'WORD' }).message || ''),
    'quoting a word as a word', refusal({ accessVlan: 'WORD' }).message);
  const good = [1, 10, '10', 4094];
  ok(good.every(function (v) { return vlanLib.validatePortConfig({ accessVlan: v }).ok; }),
    'a whole number, or a whole number in a string, is still accepted');
  ok(vlanLib.validatePortConfig({ accessVlan: null }).ok && vlanLib.validatePortConfig({}).ok,
    'and nothing at all still means "not configured"');
  ok(vlanLib.validatePortConfig({ voiceVlan: 0 }).ok,
    'voiceVlan 0 keeps meaning "none", as the normaliser has always read it');
  // The other three fields were laundered the same way, so they are checked the same way.
  ok(['nativeVlan', 'pvid', 'voiceVlan'].every(function (f) {
    const cfg = {}; cfg[f] = NaN;
    return !vlanLib.validatePortConfig(cfg).ok;
  }), 'every VLAN field on a port, not just accessVlan');
}

console.log('');
console.log('`vlan <id>` refuses a word instead of creating a VLAN numbered NaN');
{
  const { t, d } = lab();
  const said = cli(t, d, ['vlan WORD']);
  ok(said.length === 1 && /^% Invalid VLAN id "WORD"/.test(said[0]), 'the answer is one refusal, quoting the word',
    JSON.stringify(said));
  ok(/whole number from 1 to 4094/.test(said[0]), 'and it says what a VLAN id is', said[0]);
  ok(Object.keys(d.config.vlans || {}).length === 0, 'nothing was created',
    JSON.stringify(Object.keys(d.config.vlans || {})));
  const rc = show(t, d, 'show running-config');
  ok(!/NaN/.test(rc), 'running-config prints no NaN', rc.split('\n').filter(function (l) { return /vlan/.test(l); }).join(' | '));
  ok(!/NaN/.test(show(t, d, 'show vlan')), 'and neither does show vlan');
  ok(!/NaN/.test(JSON.stringify(t.serialize())), 'nor the saved file');

  ok(/^% Invalid VLAN id "1.5"/.test(cli(t, d, ['vlan 1.5'])[0]),
    'a fractional id is refused rather than truncated to 1', cli(t, d, ['vlan 1.5'])[0]);
  ok(cli(t, d, ['vlan 4095'])[0] === '% VLAN id 4095 is outside 1-4094',
    'an out-of-range id is refused in VLAN terms, not with an internal field name', cli(t, d, ['vlan 4095'])[0]);
  ok(/VLAN id 1002 is reserved/.test(cli(t, d, ['vlan 1002'])[0]),
    'and the reserved block is named as the VLAN it is', cli(t, d, ['vlan 1002'])[0]);
  ok(cli(t, d, ['vlan'])[0] === '% Incomplete command: give a VLAN id (1-4094)',
    'a missing id says the command is incomplete', cli(t, d, ['vlan'])[0]);
  ok(cli(t, d, ['vlan 20'])[0] === 'VLAN 20 created (name: VLAN0020)', 'a real id still works');
  ok(show(t, d, 'show vlan').split('\n').some(function (l) { return /^20\s/.test(l); }),
    'and the VLAN table lists it, which the NaN one never was');
}

console.log('');
console.log('`no vlan <id>` refuses a word instead of claiming a NaN does not exist');
{
  const { t, d } = lab();
  const said = cli(t, d, ['no vlan WORD']);
  ok(/^% Invalid VLAN id "WORD"/.test(said[0]), 'the word is quoted back', said[0]);
  ok(!/NaN/.test(said[0]), 'and NaN is not reported as a VLAN id');
  ok(cli(t, d, ['vlan 20'])[0].indexOf('created') !== -1 && /VLAN 20 removed/.test(cli(t, d, ['no vlan 20'])[0]),
    'removing a VLAN that exists still works');
  ok(cli(t, d, ['no vlan 20'])[0] === '% VLAN 20 does not exist',
    'and removing one that does not names the id that was typed', cli(t, d, ['no vlan 20'])[0]);
}

console.log('');
console.log('The switchport doors refuse it too, and stop reporting a NaN VLAN');
{
  const { t, d, port } = lab();
  const doors = [
    [['interface ' + port, 'switchport access vlan WORD'], 'an access VLAN'],
    [['interface ' + port, 'switchport trunk native vlan XY'], 'a trunk native VLAN'],
    [['interface ' + port, 'switchport voice vlan Q'], 'a voice VLAN']
  ];
  for (const [cmds, what] of doors) {
    const sub = new Topology();
    const d2 = sub.addDevice(spec(SWITCH), 'sw1');
    const p2 = Array.from(d2.interfaces.values()).filter(function (p) { return p.type === 'ethernet'; })[0].name;
    const lines = cmds.map(function (c) { return c.replace(new RegExp(port + '$'), p2); });
    const said = cli(sub, d2, lines);
    const token = /\S+$/.exec(cmds[1])[0];
    ok(said.length === 1 && new RegExp('^% Invalid VLAN id "' + token + '"').test(said[0]),
      'switchport ' + what + ' refuses and quotes the token', JSON.stringify(said));
    ok(said[0].indexOf(what) !== -1, 'and names the parameter the operator was setting', said[0]);
    const stored = JSON.stringify(d2.interfaces.get(p2).vlan || {});
    ok(!/NaN/.test(stored), 'the port stores no NaN', stored);
    const si = show(sub, d2, 'show interfaces ' + p2);
    ok(!/NaN/.test(si), 'and show interfaces prints none', si.split('\n').filter(function (l) { return /switchport/.test(l); }).join(' | '));
  }
}

console.log('');
console.log('Same answers on every model that can switch, and the whole numeric surface stays disciplined');
{
  const bad = [];
  let checked = 0;
  const switchers = catalog.filter(function (x) {
    return Array.isArray(x.capabilities) && x.capabilities.indexOf('l2-forward') !== -1;
  });
  for (const s of switchers.slice(0, 120)) {
    const t = new Topology();
    const d = t.addDevice(s, 'd1');
    const eth = Array.from(d.interfaces.values()).filter(function (p) { return p.type === 'ethernet'; });
    if (!eth.length) continue;
    checked++;
    const port = eth[0].name;
    const said = cli(t, d, ['vlan WORD', 'no vlan WORD', 'interface ' + port, 'switchport access vlan WORD']);
    const refusals = said.filter(function (l) { return /^%/.test(String(l)); });
    if (refusals.length !== 3) bad.push(s.model + ': ' + JSON.stringify(said));
    if (/NaN/.test(JSON.stringify(t.serialize()))) bad.push(s.model + ': save document holds NaN');
  }
  ok(checked > 40, 'the sweep covered boxes that switch frames', String(checked));
  ok(bad.length === 0, 'every one refuses the word at all three doors', bad.slice(0, 4).join(' ;; '));

  // The rest of the numeric surface, in one place: a word where a number belongs is always refused, and the
  // refusal always quotes the word. This is the check that found the VLAN hole by contrast.
  const t = new Topology();
  const d = t.addDevice(spec('ISR 4331'), 'r1');
  const ports = Array.from(d.interfaces.values()).filter(function (p) { return p.type === 'ethernet'; });
  const port = ports[0].name;
  const surfaces = [
    ['access-list WORD permit ip any any'],
    ['spanning-tree priority WORD'],
    ['interface P', 'speed WORD'],
    ['interface P', 'vrrp WORD ip 10.5.5.254'],
    ['interface P', 'vrrp 300 ip 10.5.5.254'],
    ['interface P', 'ip address WORD 24'],
    ['interface P', 'ip address 10.5.5.1 WORD'],
    ['interface P', 'ip access-group WORD in']
  ];
  const unrefused = [];
  for (const lines of surfaces) {
    const sub = new Topology();
    const d2 = sub.addDevice(spec('ISR 4331'), 'r1');
    const p2 = Array.from(d2.interfaces.values()).filter(function (p) { return p.type === 'ethernet'; })[0].name;
    const said = cli(sub, d2, lines.map(function (l) { return l.replace(/\bP\b/g, p2); }));
    if (!said.some(function (l) { return /^%/.test(String(l)); })) unrefused.push(lines.join('; ') + ' -> ' + JSON.stringify(said));
  }
  ok(unrefused.length === 0, 'every other numeric argument is refused too', unrefused.join(' ;; '));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
