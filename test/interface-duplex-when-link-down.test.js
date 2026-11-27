'use strict';
// What duplex a box reports for a port that has nothing to negotiate with.
//
// `show interfaces <port>` printed `duplex: full` for every port in the catalogue, because the model keeps one
// resolved duplex (`Interface.duplex = 'full'`) and that is what the block printed. For a port with no cable
// that is a state nothing agreed to, and it sat beside a rate already marked `(auto)` - the same line
// disagreeing with itself about how much of it had been negotiated.
//
// A Catalyst prints the *setting* for a port that is not up. The 2960-XR command reference's own sample of this
// command, on a port reading `down, line protocol is down (notconnect)`:
//
//   Auto-duplex, Auto-speed, media type is 10/100/1000BaseTX
//   https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15_2_6_e/command_reference/b_1526_2960xr_cr/interface_and_hardware_commands.pdf
//
// and the setting's default is `auto`: "Command Default: The default is auto for Fast Ethernet and Gigabit
// Ethernet ports" (Catalyst 2960-X 15.2(7)E Interface and Hardware Commands, `duplex`). Once the link is up the
// same line reads `Full-duplex, 1000Mb/s` - the resolved value, with no `Auto-`.
// research/interface-duplex-when-link-down.md carries the captures and what is left inferred.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return s.model === '2811'; })[0];

function block(dev, t, sim, port) {
  return ((new CliSession(dev, t, sim).run('show interfaces ' + port).output) || []).map(String);
}
function duplexOf(dev, t, sim, port) {
  const line = block(dev, t, sim, port).filter(function (l) { return /duplex:/.test(l); })[0] || '';
  return (line.split('duplex:')[1] || '').trim();
}
function config(dev, t, sim) {
  return ((new CliSession(dev, t, sim).run('show running-config').output) || []).map(String);
}

// One cabled pair and one port with nothing in it, so the two answers can be read side by side.
function lab() {
  const t = new Topology();
  const a = t.addDevice(ROUTER, 'r1');
  const b = t.addDevice(ROUTER, 'r2');
  t.connect('r1', 'Fa0/1', 'r2', 'Fa0/0');
  const sim = new Simulator(t);
  return { t: t, sim: sim, r: a, peer: b };
}

console.log('');
console.log('A port with no link reports its setting, which is auto:');
{
  const env = lab();
  ok(duplexOf(env.r, env.t, env.sim, 'Fa0/0') === 'auto',
    'an uncabled port prints `duplex: auto`, not a duplex no link agreed to',
    duplexOf(env.r, env.t, env.sim, 'Fa0/0'));
  const lines = block(env.r, env.t, env.sim, 'Fa0/0');
  ok(/status: down \(no cable\)/.test(lines.join('\n')), 'and its status still says why it is down', lines[1]);
  ok(/speed: 100Mb\/s \(auto\)/.test(lines.join('\n')),
    'the rate on that line already says (auto), which is the rule the duplex now follows', lines.join(' | '));
  ok(env.r.interfaces.get('Fa0/0').duplex === 'full',
    'the resolved duplex the data plane reads is untouched', env.r.interfaces.get('Fa0/0').duplex);
}

console.log('');
console.log('A port whose link is up reports the negotiated duplex:');
{
  const env = lab();
  const d = duplexOf(env.r, env.t, env.sim, 'Fa0/1');
  ok(d === 'full', 'an up port prints `duplex: full`, with no (auto)', d);
  ok(/status: up, protocol: up/.test(block(env.r, env.t, env.sim, 'Fa0/1').join('\n')), 'and it is up');
}

console.log('');
console.log('A setting an operator made is reported whether the link is up or not:');
{
  const env = lab();
  const out = runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface Fa0/0', 'duplex full', 'end']);
  ok(/Duplex full on Fa0\/0/.test(String(out.output)), 'the command is accepted', String(out.output));
  ok(duplexOf(env.r, env.t, env.sim, 'Fa0/0') === 'full',
    'a dead port hard-set to full prints full', duplexOf(env.r, env.t, env.sim, 'Fa0/0'));
  ok(env.r.interfaces.get('Fa0/0').duplexMode === 'full', 'and the setting is recorded as full');

  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface Fa0/0', 'duplex auto', 'end']);
  ok(duplexOf(env.r, env.t, env.sim, 'Fa0/0') === 'auto', '`duplex auto` puts it back to auto on a dead link');
}

console.log('');
console.log('The setting is in the configuration, and the default is not:');
{
  const env = lab();
  ok(!config(env.r, env.t, env.sim).some(function (l) { return /^\s*duplex /.test(l); }),
    'a fresh config has no duplex line, because auto is the default');
  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface Fa0/0', 'duplex full', 'end']);
  ok(config(env.r, env.t, env.sim).some(function (l) { return l === ' duplex full'; }),
    'an explicit `duplex full` is written - it used to be invisible, keyed on the resolved value',
    config(env.r, env.t, env.sim).filter(function (l) { return /duplex/.test(l); }).join(' | '));
  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface Fa0/0', 'no duplex', 'end']);
  ok(!config(env.r, env.t, env.sim).some(function (l) { return /^\s*duplex /.test(l); }),
    'and `no duplex` returns it to the default and takes the line away');
}

console.log('');
console.log('Half duplex, the one setting a 10/100 port keeps while dead:');
{
  const env = lab();
  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface Fa0/0', 'speed 100', 'end']);
  const out = runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface Fa0/0', 'duplex half', 'end']);
  ok(/Duplex half/.test(String(out.output)), '`duplex half` at 100 Mb/s is accepted', String(out.output));
  ok(duplexOf(env.r, env.t, env.sim, 'Fa0/0') === 'half', 'a dead port set to half prints half',
    duplexOf(env.r, env.t, env.sim, 'Fa0/0'));
  ok(config(env.r, env.t, env.sim).some(function (l) { return l === ' duplex half'; }),
    'and the config carries `duplex half`');
}

console.log('');
console.log('The mismatch rule still reads the resolved duplex, so nothing about forwarding moved:');
{
  const env = lab();
  const link = [...env.t.links.values()].filter(function (l) {
    return l.a.deviceId === 'r1' && l.a.iface === 'Fa0/1';
  })[0];
  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface Fa0/1', 'speed 100', 'duplex half', 'end']);
  runCommands(env.peer, env.t, env.sim, ['configure terminal', 'interface Fa0/0', 'speed 100', 'end']);
  const verdict = env.t.validateLink('r1', 'Fa0/1', 'r2', 'Fa0/0', {
    mediaId: link.mediaId, lengthM: link.lengthM, revalidate: env.t.revalidateFor(link.id, 'r1')
  });
  const codes = (verdict.warnings || []).map(function (w) { return w.code; });
  ok(codes.indexOf('W_DUPLEX_MISMATCH') !== -1,
    'half against the other end\'s auto-resolved full is still a mismatch', JSON.stringify(codes));
  ok(env.r.interfaces.get('Fa0/1').duplex === 'half', 'because the resolved value is what the rule reads');
  ok(env.peer.interfaces.get('Fa0/0').duplex === 'full',
    'and auto on the far end still resolves to full, which the rule compares');
}

console.log('');
console.log('A saved lab brings the setting back, and a port at auto gains no key:');
{
  const env = lab();
  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface Fa0/0', 'duplex full', 'end']);
  const doc = JSON.parse(JSON.stringify(env.t.serialize()));
  const saved = (doc.devices || []).filter(function (d) { return d.id === 'r1'; })[0] || {};
  const port = (saved.interfaces || []).filter(function (i) { return i.name === 'Fa0/0'; })[0] || {};
  ok(port.duplexMode === 'full', 'the non-default setting is in the document', JSON.stringify(port.duplexMode));
  const other = (saved.interfaces || []).filter(function (i) { return i.name === 'Fa0/1'; })[0] || {};
  ok(!('duplexMode' in other), 'and a port left at auto grows no key, so no sweep sees a new field',
    JSON.stringify(Object.keys(other)));
  const back = Topology.fromJSON(doc);
  const r1 = back.getDevice('r1');
  ok(r1.interfaces.get('Fa0/0').duplexMode === 'full', 'and a reload keeps it');
  ok(r1.interfaces.get('Fa0/1').duplexMode === 'auto', 'while an untouched port comes back auto');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
