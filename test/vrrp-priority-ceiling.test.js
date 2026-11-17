'use strict';
// 255 is the address owner's priority, not a value an operator can type.
//
// The engine accepted `vrrp 7 priority 255` and printed "(1-255)" when it refused anything. On IOS the
// keyword's own parser range is 1-254 -- `vrrp 1 priority ?` answers `<1-254>  Priority level(default 100)`
// -- and a group takes 255 only when this router's interface address is one of its virtual addresses.
// Accepting 255 let an operator claim "I am the owner" on a box that does not own the address, and the
// console's stated range was one wider than the vendor's on the low side of the same sentence.
//
// The RFC value is still legal on the wire, so engine/vrrp.js keeps accepting 255 in validateGroup() -
// the check that matters here is the CLI's, which is the only door an operator types through.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const vrrp = require('../engine/vrrp');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function section(name) { console.log('\n' + name); }
function isPrompt(l) { return /^[A-Za-z0-9][A-Za-z0-9 ._\/-]*[>#]/.test(l); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ISR 4331/.test(s.model); })[0];

// A router with one addressed port and group 7 on it, so a priority can be typed.
function lab() {
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r1');
  const ports = [...r.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  return { t: t, r: r, sim: new Simulator(t), port: ports[1].name };
}
function config(env, commands) {
  return runCommands(env.r, env.t, env.sim,
    ['configure terminal', 'interface ' + env.port, 'ip address 10.7.0.1 255.255.255.0'].concat(commands))
    .lines.filter(function (l) { return !isPrompt(l); });
}
function groupOn(env) {
  return (env.r.config.vrrp || []).filter(function (g) { return g.vrid === 7; })[0];
}
function showVrrp(env) {
  return ((new CliSession(env.r, env.t, env.sim).run('show vrrp').output) || []).map(String);
}

// ---------------------------------------------------------------------------
section('the accepted range is 1-254');
{
  const env = lab();
  const out = config(env, ['vrrp 7 ip 10.7.0.254', 'vrrp 7 priority 254']);
  ok(out.some(function (l) { return /priority 254/.test(l); }), '254 is accepted at the high edge');
  ok(groupOn(env).priority === 254, 'the group holds 254');

  const one = config(lab(), ['vrrp 7 ip 10.7.0.254', 'vrrp 7 priority 1']);
  ok(one.some(function (l) { return /priority 1\b/.test(l); }), '1 is accepted at the low edge');
}

// ---------------------------------------------------------------------------
section('255 is refused, and refused rather than clamped');
{
  const env = lab();
  const out = config(env, ['vrrp 7 ip 10.7.0.254', 'vrrp 7 priority 255']);
  const refusal = out.filter(function (l) { return /^%/.test(l); })[0] || '';
  ok(refusal !== '', 'priority 255 is refused');
  ok(/255/.test(refusal), 'the refusal quotes the value typed');
  ok(/1-254/.test(refusal), 'the refusal states the range 1-254');
  ok(groupOn(env).priority === 100, 'a refused 255 leaves the default 100, it does not become 254');

  // A priority already set survives a refused change: the group is not reset by the attempt.
  const kept = lab();
  config(kept, ['vrrp 7 ip 10.7.0.254', 'vrrp 7 priority 200', 'vrrp 7 priority 255']);
  ok(groupOn(kept).priority === 200, 'a refused 255 leaves an existing 200 alone');
}

// ---------------------------------------------------------------------------
section('0 and 256 are outside the range at both ends');
{
  const env = lab();
  const out = config(env, ['vrrp 7 ip 10.7.0.254', 'vrrp 7 priority 0', 'vrrp 7 priority 256']);
  const refusals = out.filter(function (l) { return /^%/.test(l); });
  ok(refusals.length === 2, 'both 0 and 256 are refused');
  ok(refusals.every(function (l) { return /1-254/.test(l); }), 'both refusals state 1-254');
  ok(groupOn(env).priority === 100, 'neither attempt created or altered the group priority');
}

// ---------------------------------------------------------------------------
section('what the group prints is what was accepted');
{
  const env = lab();
  config(env, ['vrrp 7 ip 10.7.0.254', 'vrrp 7 priority 254']);
  env.sim.computeVrrp();
  const row = showVrrp(env)[1] || '';
  ok(/\b254\b/.test(row), 'show vrrp prints 254 for a group configured with 254');
}

// ---------------------------------------------------------------------------
section('the console advertises the range it enforces');
{
  const env = lab();
  const help = runCommands(env.r, env.t, env.sim, ['help']).lines.join('\n');
  ok(/priority <1-254>/.test(help), 'help states `priority <1-254>`');
  ok(!/priority <1-255>/.test(help), 'help no longer states the old 1-255');
}

// ---------------------------------------------------------------------------
section('255 is still the protocol value it is');
{
  // The RFC reserves 255 for the address owner and 0 for a master releasing the group. The library is the
  // protocol model and still accepts both; only the configuration door is narrower.
  ok(vrrp.validateGroup({ vrid: 7, ips: ['10.7.0.254'], priority: 255 }).ok === true,
    'validateGroup still accepts a priority-255 group (the owner value)');
  ok(vrrp.validateGroup({ vrid: 7, ips: ['10.7.0.254'], priority: 0 }).ok === true,
    'validateGroup still accepts priority 0 (master relinquished)');
  ok(vrrp.VRRP_OWNER_PRIORITY === 255, 'the owner priority the election applies is still 255');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
