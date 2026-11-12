'use strict';
// No command may swallow a word it did not understand (#1495).
//
// This is the breadth version of #1493, where three handlers answered a neighbouring command's question. Instead
// of waiting to notice one, the sweep below hands every command family a word that does not exist and sorts the
// answers into three classes:
//
//   SILENT    nothing objected - and a typo that changes state with no witness is the worst answer of all. The
//             sweep found two: `channel-group flurbish` created a channel group called "flurbish", put the port in
//             it and answered "Interface Fa0/2 added to channel group flurbish (mode active)"; and
//             `shutdown flurbish` closed the port and never mentioned the word.
//   UNQUOTED  objected without naming the word - acceptable only when the answer is about the *capability* the
//             device lacks (`cannot switch frames: it has no l2-forward capability`) or when it lists the values
//             the command does take (`Usage: duplex auto | full | half`). Both tell the reader what to do instead.
//   QUOTED    named the word back. This is the shortest route from a typo to a correction.
//
// The rule this test enforces: every one of these answers is in UNQUOTED-or-QUOTED, and nothing is silent. A
// refusal is also required to leave the configuration exactly as it was.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = function (m) { return catalog.find(function (x) { return x.model === m; }); };
const WORD = 'flurbish';

function env() {
  const t = new Topology();
  const r = t.addDevice(spec('ISR 4331'), 'r1');
  const sw = t.addDevice(spec('Catalyst2960'), 'sw');
  const ports = function (d) {
    return Array.from(d.interfaces.values()).filter(function (p) { return p.type === 'ethernet'; })
      .map(function (p) { return p.name; });
  };
  return { t: t, r: r, sw: sw, rp: ports(r), sp: ports(sw) };
}
function isPrompt(l) { return /^[A-Za-z0-9][A-Za-z0-9 ._\/-]*[>#]/.test(l); }
function flat(o, p, acc) {
  acc = acc || {};
  Object.keys(o || {}).forEach(function (k) {
    const v = o[k], key = p ? p + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, acc);
    else acc[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  });
  return acc;
}
function attempt(who, cmds) {
  const e = env();
  const dev = who === 'r' ? e.r : e.sw;
  const filled = cmds.map(function (s) {
    return s.replace('{RP1}', e.rp[1]).replace('{SP1}', e.sp[1]).replace('{SP2}', e.sp[2]);
  });
  const before = JSON.stringify(flat(dev.config, ''));
  const lines = runCommands(dev, e.t, new Simulator(e.t), ['enable', 'configure terminal'].concat(filled)).lines;
  const after = JSON.stringify(flat(dev.config, ''));
  const said = lines.filter(function (l) { return !isPrompt(l); });
  const refusals = said.filter(function (l) { return /^\s*%/.test(l); });
  return { said: said, refusals: refusals, changed: before !== after, last: filled[filled.length - 1], dev: dev, e: e };
}
// The two acceptable ways to refuse without quoting the word.
const NAMES_CAPABILITY = /cannot |no [a-z0-9-]+ capability|is not enabled|is only configurable|is not supported/;
const LISTS_ALTERNATIVES = /Usage:|use (active|passive|on)|auto \| full \| half|auto\|full\|half|inside \| outside|inside\|outside/;

const CASES = [
  ['ip', 'r', ['ip ' + WORD]],
  ['ipv6', 'r', ['ipv6 ' + WORD]],
  ['no', 'r', ['no ' + WORD]],
  ['router', 'r', ['router ' + WORD]],
  ['line', 'r', ['line ' + WORD]],
  ['access-list', 'r', ['access-list ' + WORD]],
  ['logging', 'r', ['logging ' + WORD]],
  ['ntp', 'r', ['ntp ' + WORD]],
  ['snmp', 'r', ['snmp ' + WORD]],
  ['banner', 'r', ['banner ' + WORD]],
  ['ip ospf (config)', 'r', ['ip ospf ' + WORD]],
  ['ip nat (config)', 'r', ['ip nat ' + WORD]],
  ['ip dhcp (config)', 'r', ['ip dhcp ' + WORD]],
  ['ip route', 'r', ['ip route ' + WORD]],
  ['ip name-server', 'r', ['ip name-server ' + WORD]],
  ['scion', 'r', ['scion ' + WORD]],
  ['speed', 'r', ['interface {RP1}', 'speed ' + WORD]],
  ['speed (switch)', 's', ['interface {SP1}', 'speed ' + WORD]],
  ['duplex', 'r', ['interface {RP1}', 'duplex ' + WORD]],
  ['duplex (switch)', 's', ['interface {SP1}', 'duplex ' + WORD]],
  ['encapsulation', 'r', ['interface {RP1}', 'encapsulation ' + WORD]],
  ['clock rate', 'r', ['interface {RP1}', 'clock rate ' + WORD]],
  ['vrrp', 'r', ['interface {RP1}', 'vrrp ' + WORD]],
  ['channel-group (switch)', 's', ['interface {SP1}', 'channel-group ' + WORD]],
  ['channel-group (router)', 'r', ['interface {RP1}', 'channel-group ' + WORD]],
  ['switchport (switch)', 's', ['interface {SP1}', 'switchport ' + WORD]],
  ['switchport mode (switch)', 's', ['interface {SP1}', 'switchport mode ' + WORD]],
  ['switchport access vlan (switch)', 's', ['interface {SP1}', 'switchport access vlan ' + WORD]],
  ['switchport (router)', 'r', ['interface {RP1}', 'switchport ' + WORD]],
  ['spanning-tree', 's', ['interface {SP1}', 'spanning-tree ' + WORD]],
  ['power inline', 's', ['interface {SP1}', 'power inline ' + WORD]],
  ['shutdown (switch)', 's', ['interface {SP1}', 'shutdown ' + WORD]],
  ['shutdown (router)', 'r', ['interface {RP1}', 'shutdown ' + WORD]]
];

section('1. Every command family is handed a word that does not exist');
{
  const silent = [], vague = [], wrote = [];
  const quoted = [];
  for (const c of CASES) {
    const r = attempt(c[1], c[2]);
    const text = r.refusals.join(' ');
    if (!r.refusals.length) { silent.push(c[0] + ' -> ' + JSON.stringify(r.said.slice(-1)[0] || '(nothing)')); continue; }
    const named = text.toLowerCase().indexOf(WORD) !== -1;
    if (named) quoted.push(c[0]);
    else if (!NAMES_CAPABILITY.test(text) && !LISTS_ALTERNATIVES.test(text)) vague.push(c[0] + ' -> ' + r.refusals[0]);
    if (r.changed) wrote.push(c[0]);
  }
  ok(CASES.length >= 33, 'the sweep covers the command families (' + CASES.length + ' cases)');
  ok(silent.length === 0, 'no family accepts a word it does not know', silent.join('; '));
  ok(vague.length === 0, 'and every refusal either names the word, names the missing capability, or lists the values it takes', vague.join('; '));
  ok(wrote.length === 0, 'and no refused command wrote configuration', wrote.join(', '));
  ok(quoted.length >= 25, 'most refusals name the word back (' + quoted.length + ' of ' + CASES.length + ')');
}

section('2. The three that used to be silent or misleading, named');
{
  // `channel-group flurbish` created a group called "flurbish" and reported success.
  const lag = attempt('s', ['interface {SP1}', 'channel-group ' + WORD]);
  ok(/Invalid channel group id "flurbish"/.test(lag.refusals.join(' ')), 'a channel group id has to be a number',
    lag.refusals.join(' '));
  ok(!lag.dev.config.lags || !lag.dev.config.lags[WORD], 'and no group called "flurbish" exists',
    JSON.stringify(lag.dev.config.lags || {}));
  ok(lag.dev.interfaces.get(lag.e.sp[1]).enabled !== false, 'the port is untouched');

  // `shutdown flurbish` closed the port and said nothing.
  const shut = attempt('s', ['interface {SP1}', 'shutdown ' + WORD]);
  ok(/takes no argument/.test(shut.refusals.join(' ')), 'a word after `shutdown` is refused', shut.refusals.join(' '));
  ok(shut.dev.interfaces.get(shut.e.sp[1]).enabled === true, 'and the port is left up',
    String(shut.dev.interfaces.get(shut.e.sp[1]).enabled));

  // `ip route flurbish` was reported as a missing argument.
  const route = attempt('r', ['ip route ' + WORD]);
  ok(/Invalid destination "flurbish": not an IPv4 address/.test(route.refusals.join(' ')),
    'one bad word is called a bad destination, not a missing mask', route.refusals.join(' '));
  ok(!/Incomplete/.test(route.refusals.join(' ')), 'and it does not ask for the rest of the line first');
}

section('3. The valid forms still work');
{
  const lag = attempt('s', ['interface {SP1}', 'channel-group 5 mode active']);
  ok(/added to channel group 5/.test(lag.said.join(' ')), '`channel-group 5 mode active` bundles the port');
  ok(lag.dev.config.lags && lag.dev.config.lags['5'], 'and records group 5', JSON.stringify(lag.dev.config.lags));

  const off = attempt('s', ['interface {SP1}', 'shutdown']);
  ok(off.dev.interfaces.get(off.e.sp[1]).enabled === false, '`shutdown` alone still closes the port');
  const on = attempt('s', ['interface {SP1}', 'no shutdown']);
  ok(on.dev.interfaces.get(on.e.sp[1]).enabled === true, '`no shutdown` still opens it');

  const good = attempt('r', ['ip route 10.9.0.0 255.255.255.0 10.0.0.9']);
  ok(/Route added: 10\.9\.0\.0\/24/.test(good.said.join(' ')), 'a valid route is still installed');
  ok(good.dev.config.routes && good.dev.config.routes.length === 1, 'and stored');

  const badMask = attempt('r', ['ip route 192.0.2.0 255.0.255.0 10.1.1.9']);
  ok(/Invalid mask: 255\.0\.255\.0/.test(badMask.refusals.join(' ')), 'a non-contiguous mask is still refused with its reason');
  const short = attempt('r', ['ip route 10.9.0.0']);
  ok(/Incomplete command: ip route/.test(short.refusals.join(' ')), 'and a real missing argument is still called incomplete');

  const mode = attempt('s', ['interface {SP1}', 'channel-group 5 mode flurbish']);
  ok(/Invalid mode: flurbish/.test(mode.refusals.join(' ')), 'an invalid mode is still refused by name (mode was always checked)');
}

section('');
if (failed) {
  console.error(passed + ' passed, ' + failed + ' failed');
  process.exit(1);
}
console.log(passed + ' passed, 0 failed');
