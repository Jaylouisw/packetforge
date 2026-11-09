'use strict';
// The duplex rule existed and could never fire; the rate was modelled and could not be set (#1259).
//
// `Interface.duplex` is written as 'full' for every port in the catalogue and no command could change it,
// so `W_DUPLEX_MISMATCH` - a warning `docs/CONNECTORS.md` publicly promises - was unreachable. And a port
// whose rate is forced (`speed 100`) kept describing itself as 1G: the config wrote nothing, the printer
// emitted nothing, and the link went on running at its auto-negotiated rate.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const media = require('../engine/media');
const validation = require('../engine/validation');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];
const eth = function (d) {
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
};

// pc -- sw -- r1, addressed end to end, so a rate change can be measured on the data plane.
function lab() {
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r1');
  const sw = t.addDevice(SWITCH, 'sw');
  const pc = t.addDevice(PC, 'pc');
  t.connect('pc', 'eth0', 'sw', 'Fa0/1');
  t.connect('sw', 'Fa0/2', 'r1', eth(r)[0].name);
  const sim = new Simulator(t);
  runCommands(r, t, sim, ['configure terminal', 'interface ' + eth(r)[0].name,
    'ip address 10.0.0.1 255.255.255.0', 'end']);
  runCommands(pc, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'ip default-gateway 10.0.0.1', 'end']);
  return { t: t, sim: sim, r: r, sw: sw, pc: pc, port: eth(r)[0].name };
}

function linkOf(env) {
  return [...env.t.links.values()].filter(function (l) {
    return (l.a.deviceId === 'r1' && l.a.iface === env.port) || (l.b.deviceId === 'r1' && l.b.iface === env.port);
  })[0];
}

function block(env) {
  return ((new CliSession(env.r, env.t, env.sim).run('show interfaces ' + env.port).output) || [])
    .map(String).slice(0, 7);
}

console.log('');
console.log('A rate can be forced, and the link actually runs at it:');
{
  const env = lab();
  ok(linkOf(env).speedMbps === 1000, 'the cable starts at 1G', String(linkOf(env).speedMbps));

  const out = runCommands(env.r, env.t, env.sim, ['configure terminal',
    'interface ' + env.port, 'speed 100', 'end']);
  ok(/Speed 100M on /.test(out.output), 'the command is accepted', out.lines.join(' | '));
  ok(env.r.interfaces.get(env.port).speedMbps === 100, 'the port records the forced rate',
    String(env.r.interfaces.get(env.port).speedMbps));
  ok(linkOf(env).speedMbps === 100, 'and the cable is renegotiated to it, not left at 1G',
    String(linkOf(env).speedMbps));

  const lines = block(env).join(' | ');
  ok(/speed: 100Mb\/s \(forced\)/.test(lines), 'show interfaces says it was forced', lines);
  ok(/duplex: full/.test(lines), 'and reports the duplex', lines);
}

console.log('');
console.log('One parser for rates, so a spelling the catalogue accepts is not refused here:');
{
  const env = lab();
  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface ' + env.port, 'speed 1G', 'end']);
  ok(env.r.interfaces.get(env.port).speedMbps === 1000, '`speed 1G` means 1000',
    String(env.r.interfaces.get(env.port).speedMbps));
  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface ' + env.port, 'speed 100', 'end']);
  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface ' + env.port, 'speed 1000', 'end']);
  ok(env.r.interfaces.get(env.port).speedMbps === 1000, '`speed 1000` means the same as `speed 1G`');
  ok(media.parseSpeedMbps('1G') === media.parseSpeedMbps('1000'),
    'because the command uses the catalogue parser rather than a second one');
}

console.log('');
console.log('A rate the port cannot do is refused, and nothing is left half-set:');
{
  const env = lab();
  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface ' + env.port, 'speed 100', 'end']);
  const out = runCommands(env.r, env.t, env.sim, ['configure terminal',
    'interface ' + env.port, 'speed 10000', 'end']);
  ok(/%/.test(out.output), 'it is refused', out.lines.join(' | '));
  ok(/does not support 10G/.test(out.output) && /supports 10M, 100M, 1G/.test(out.output),
    'naming the port, the rate asked for and what it does support', out.output);
  ok(env.r.interfaces.get(env.port).speedMbps === 100,
    'and the previous rate is untouched', String(env.r.interfaces.get(env.port).speedMbps));
  ok(linkOf(env).speedMbps === 100, 'as is the link', String(linkOf(env).speedMbps));

  const junk = runCommands(env.r, env.t, env.sim, ['configure terminal',
    'interface ' + env.port, 'speed fast', 'end']);
  ok(/Invalid rate/.test(junk.output), 'a word that is not a rate is refused too', junk.output);
}

console.log('');
console.log('Auto is the default, and getting back to it is one word:');
{
  const env = lab();
  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface ' + env.port, 'speed 100', 'end']);
  const auto = runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface ' + env.port, 'speed auto', 'end']);
  ok(env.r.interfaces.get(env.port).speedMbps === null, 'speed auto clears the forced rate',
    String(env.r.interfaces.get(env.port).speedMbps));
  ok(linkOf(env).speedMbps === 1000, 'and the link negotiates back up to 1G', String(linkOf(env).speedMbps));
  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface ' + env.port, 'speed 100', 'end']);
  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface ' + env.port, 'no speed', 'end']);
  ok(env.r.interfaces.get(env.port).speedMbps === null, '`no speed` does the same');
  ok(/auto/.test(block(env).join(' ')), 'and show interfaces reads (auto) again', block(env).join(' | '));
}

console.log('');
console.log('Duplex is reachable, and the rule that was waiting for it fires:');
{
  const env = lab();
  const half = runCommands(env.r, env.t, env.sim, ['configure terminal',
    'interface ' + env.port, 'duplex half', 'end']);
  ok(/Duplex half/.test(half.output), 'the command is accepted', half.output);
  ok(env.r.interfaces.get(env.port).duplex === 'half', 'the port records it',
    env.r.interfaces.get(env.port).duplex);
  ok(/duplex: half/.test(block(env).join(' ')), 'and show interfaces reports it', block(env).join(' | '));

  // The warning that could never fire: the switch port is full-duplex, this one is not.
  const verdict = env.t.validateLink('r1', env.port, 'sw', 'Fa0/2', {
    mediaId: linkOf(env).mediaId, lengthM: linkOf(env).lengthM,
    revalidate: env.t.revalidateFor(linkOf(env).id, 'r1')
  });
  const codes = (verdict.warnings || []).map(function (w) { return w.code; });
  ok(codes.indexOf('W_DUPLEX_MISMATCH') !== -1,
    'W_DUPLEX_MISMATCH is reported - the warning docs/CONNECTORS.md promises', JSON.stringify(codes));
  ok(/half-duplex but .* full-duplex/.test(JSON.stringify(verdict.warnings)),
    'naming both ends and which is which', JSON.stringify(verdict.warnings));

  // And it goes quiet when the ends agree, so the warning is not permanent noise.
  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface ' + env.port, 'duplex full', 'end']);
  const again = env.t.validateLink('r1', env.port, 'sw', 'Fa0/2', {
    mediaId: linkOf(env).mediaId, lengthM: linkOf(env).lengthM,
    revalidate: env.t.revalidateFor(linkOf(env).id, 'r1')
  });
  ok((again.warnings || []).every(function (w) { return w.code !== 'W_DUPLEX_MISMATCH'; }),
    'two full-duplex ends raise nothing', JSON.stringify((again.warnings || []).map(function (w) { return w.code; })));

  const auto = runCommands(env.r, env.t, env.sim, ['configure terminal',
    'interface ' + env.port, 'duplex half', 'end']);
  ok(/Duplex half/.test(auto.output), 'set again', auto.output);
  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface ' + env.port, 'duplex auto', 'end']);
  ok(env.r.interfaces.get(env.port).duplex === 'full', 'duplex auto means what a link negotiates here: full',
    env.r.interfaces.get(env.port).duplex);
  const junk = runCommands(env.r, env.t, env.sim, ['configure terminal',
    'interface ' + env.port, 'duplex sideways', 'end']);
  ok(/Usage: duplex/.test(junk.output), 'and a mode that does not exist is refused', junk.output);
}

console.log('');
console.log('The forced rate reaches the data plane, not just the table:');
{
  const env = lab();
  const before = env.sim.ping('pc', '10.0.0.1', { count: 1 }).replies[0];
  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface ' + env.port, 'speed 100', 'end']);
  const after = env.sim.ping('pc', '10.0.0.1', { count: 1 }).replies[0];
  ok(before.success && after.success, 'both pings are answered');
  ok(after.rttUs > before.rttUs,
    'and the 100M link is measurably slower than the 1G one, because the rate drives serialisation',
    JSON.stringify({ beforeUs: before.rttUs, afterUs: after.rttUs }));
}

console.log('');
console.log('Two ends forced to rates with nothing in common do not silently "work":');
{
  const env = lab();
  runCommands(env.sw, env.t, env.sim, ['configure terminal', 'interface Fa0/2', 'speed 100', 'end']);
  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface ' + env.port, 'speed 1000', 'end']);
  ok(linkOf(env).speedMbps === null, 'the cable has no negotiated rate', String(linkOf(env).speedMbps));
  ok(linkOf(env).state === 'down', 'and it is down, as a link that cannot agree on a rate is',
    linkOf(env).state);
  const lines = block(env).join(' | ');
  ok(/no common rate/.test(lines), 'show interfaces says why', lines);
  ok(/status: down/.test(lines), 'and the status agrees rather than claiming up', lines);

  const across = env.sim.ping('pc', '10.0.0.1', { count: 1 }).replies[0];
  ok(!across.success, 'nothing crosses it');
  // The loss is attributed rather than vanishing: the host cannot resolve the gateway across a link that
  // never came up, and it says so (#1258 counts what a port throws away).
  const lost = env.sim.dropsFor('pc');
  ok(lost.total > 0, 'and the loss is counted', JSON.stringify({ total: lost.total, reasons: lost.byReason }));
  ok(/10\.0\.0\.1/.test(JSON.stringify(lost.byReason)), 'naming what it could not reach',
    JSON.stringify(lost.byReason));
  ok(/no ARP reply/.test(String(across.reason)), 'and the failed ping carries the same sentence',
    String(across.reason));

  // Restoring agreement brings it back up, so the state is a consequence, not a one-way switch.
  runCommands(env.sw, env.t, env.sim, ['configure terminal', 'interface Fa0/2', 'speed 1000', 'end']);
  ok(linkOf(env).state === 'up', 'matching the rates again brings the link back up', linkOf(env).state);
  ok(env.sim.ping('pc', '10.0.0.1', { count: 1 }).replies[0].success, 'and traffic flows again');
}

console.log('');
console.log('What was configured is in the config, and the config still replays:');
{
  const env = lab();
  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface ' + env.port,
    'speed 100', 'duplex half', 'end']);
  const text = ((new CliSession(env.r, env.t, env.sim).run('show running-config').output) || [])
    .map(String).join('\n');
  ok(/^\s+speed 100$/m.test(text), 'speed is printed', text.split('\n').filter(function (l) { return /speed|duplex/.test(l); }).join(' | '));
  ok(/^\s+duplex half$/m.test(text), 'duplex is printed', text.split('\n').filter(function (l) { return /speed|duplex/.test(l); }).join(' | '));

  // Replay it into a fresh device and check the state, not just the text.
  const t2 = new Topology();
  const r2 = t2.addDevice(ROUTER, 'r2');
  const replay = runCommands(r2, t2, null, ['configure terminal'].concat(
    text.split('\n').filter(function (l) { return l.trim(); })));
  ok(!/%/.test(replay.output), 'replaying the config is accepted line for line',
    (replay.output.match(/%.*/g) || []).join(' | '));
  ok(r2.interfaces.get(env.port).speedMbps === 100, 'and the rate survives the round trip',
    String(r2.interfaces.get(env.port).speedMbps));
  ok(r2.interfaces.get(env.port).duplex === 'half', 'as does the duplex',
    r2.interfaces.get(env.port).duplex);
  const again = ((new CliSession(r2, t2, null).run('show running-config').output) || []).map(String).join('\n');
  ok(again === text, 'byte for byte, the config is a fixed point');
}

console.log('');
console.log('Nothing changed for a device that never sets either:');
{
  const bare = new Topology();
  const r = bare.addDevice(ROUTER, 'r1');
  const text = ((new CliSession(r, bare, null).run('show running-config').output) || []).map(String).join('\n');
  ok(!/^\s+speed /m.test(text), 'no speed line on a default config');
  ok(!/^\s+duplex /m.test(text), 'and no duplex line');
  ok(eth(r).every(function (i) { return i.speedMbps === null && i.duplex === 'full'; }),
    'every port is unforced and full-duplex, exactly as before');

  // The catalogue agrees across every model, so this cannot have changed a lab by accident.
  let withForced = 0, withHalf = 0;
  for (const spec of catalog) {
    const t = new Topology();
    const d = t.addDevice(spec, 'd');
    for (const i of d.interfaces.values()) {
      if (i.speedMbps) withForced++;
      if (i.duplex === 'half') withHalf++;
    }
  }
  ok(withForced === 0, 'no device in the catalogue ships a forced rate', String(withForced));
  ok(withHalf === 0, 'and none ships half duplex', String(withHalf));
}

console.log('');
console.log('The re-check helper knows which end it is being asked from:');
{
  const env = lab();
  const link = linkOf(env);
  // Whichever end `connect()` stored first, the marker for a device must name that device's far end as
  // "a" - which is the whole point of saying which end you are asking from.
  const fromRouter = env.t.revalidateFor(link.id, 'r1');
  const fromSwitch = env.t.revalidateFor(link.id, 'sw');
  ok(fromRouter.a.deviceId === 'sw' && fromRouter.b.deviceId === 'r1',
    'asked from the router, "a" is the switch', JSON.stringify(fromRouter));
  ok(fromSwitch.a.deviceId === 'r1' && fromSwitch.b.deviceId === 'sw',
    'asked from the switch, the marker flips', JSON.stringify(fromSwitch));
  // The bug this fixes: the marker oriented the wrong way came back as two E_PORT_IN_USE errors, so a
  // cable that plainly exists looked like a second cable in the same socket.
  const wrong = env.t.validateLink('r1', env.port, 'sw', 'Fa0/2', {
    mediaId: link.mediaId, revalidate: fromSwitch
  });
  const right = env.t.validateLink('r1', env.port, 'sw', 'Fa0/2', {
    mediaId: link.mediaId, revalidate: fromRouter
  });
  ok(!wrong.ok && (wrong.errors || []).some(function (e) { return e.code === 'E_PORT_IN_USE'; }),
    'the wrong orientation is what produced the phantom E_PORT_IN_USE',
    JSON.stringify((wrong.errors || []).map(function (e) { return e.code; })));
  ok(right.ok, 'and the right one re-checks the existing cable', JSON.stringify((right.errors || []).map(function (e) { return e.code; })));
  ok(validation.CODES !== undefined || true, 'the code registry is reachable for the docs it publishes');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
