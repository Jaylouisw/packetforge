'use strict';
// The bridge priority the spanning tree has always honoured, and the command that never reached it (#1364).
//
// `computeStp()` has read `dev.config.stpPriority` since STP was modelled. Nothing in the product ever wrote
// it: no catalogue spec sets it, no CLI command set it, and `Device.serialize()` did not carry it. So every
// switch in every lab ran the default 32768, the root election was decided by MAC address alone, and an
// operator had no way to say "this one is the root" - which is the first thing anyone does to a switched
// network. `show spanning-tree` did not print the priority either, so the report could not explain why the
// tree looked the way it did.
//
// This file checks the whole path: the command, the refusals, the election, the report, the running-config
// line, and the save.
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const cliModule = require('../engine/cli');
const stpLib = require('../engine/stp');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = require('path').join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
const SW = specs.find(function (s) { return /CX 6000/.test(s.model); });
const ROUTER = specs.find(function (s) { return /ISR 4331/.test(s.model); });

// Three switches in a triangle: a real loop, so there is an election to lose.
function triangle() {
  const t = new Topology();
  t.addDevice(SW, 's1'); t.addDevice(SW, 's2'); t.addDevice(SW, 's3');
  const c = function (a, ap, b, bp) { t.connect(a, ap, b, bp, { mediaId: '1000base-t', speedMbps: 1000 }); };
  c('s1', '1/1/1', 's2', '1/1/1');
  c('s2', '1/1/2', 's3', '1/1/1');
  c('s3', '1/1/2', 's1', '1/1/2');
  // The bridge ID is priority then MAC. The catalogue's switches report the same lowest MAC, so set them
  // explicitly: without that, "the lower priority won" could be the tie-break on the id and prove nothing.
  // Every port, not one of them: the bridge ID uses the lowest MAC on the box, and a port left at the
  // catalogue's shared default is lower than anything set here.
  const macs = { s1: '02:00:00:00:00:03', s2: '02:00:00:00:00:02', s3: '02:00:00:00:00:01' };
  for (const id of Object.keys(macs)) {
    for (const iface of t.getDevice(id).interfaces.values()) iface.mac = macs[id];
  }
  return { t: t, sim: new Simulator(t) };
}
function run(env, devId, cmds) {
  const s = new CliSession(env.t.getDevice(devId), env.t, env.sim);
  const out = [];
  for (const c of cmds) out.push(((s.run(c) || {}).output || []).join(' '));
  return out.join('\n');
}
function election(env, atMs) {
  env.sim.setRunTime(atMs === undefined ? Infinity : atMs);
  if (typeof env.sim.recomputeStp === 'function') env.sim.recomputeStp();
  else env.sim.computeStp();
  const res = env.sim.stpResult || {};
  return res.root || null;
}

console.log('');
console.log('The root is decided by MAC until somebody sets a priority:');
{
  const env = triangle();
  const r = election(env);
  ok(!!r, 'an election ran');
  ok(r && r.key === 's3', 'the switch with the lowest MAC is root (s3)', r && r.key);
  ok(r && r.priority === stpLib.STP_DEFAULT_PRIORITY, 'at the default priority', r && r.priority);
}

console.log('');
console.log('Setting a priority moves the root:');
{
  const env = triangle();
  const said = run(env, 's1', ['enable', 'configure terminal', 'spanning-tree priority 4096']);
  ok(/Bridge priority set to 4096/.test(said), 'the command says what it did', said.slice(0, 90));
  ok(env.t.getDevice('s1').config.stpPriority === 4096, 'and stores it on the device');
  const r = election(env);
  ok(r && r.key === 's1', 's1 is now the root, though its MAC is the highest', r && r.key);
  ok(r && r.priority === 4096, 'and the election reports the priority it used', r && r.priority);

  // The other direction: the box that used to win by MAC now loses to a lower priority elsewhere.
  const env2 = triangle();
  run(env2, 's1', ['enable', 'configure terminal', 'spanning-tree priority 61440']);
  const r2 = election(env2);
  ok(r2 && r2.key === 's3', 'making one switch the worst candidate leaves the MAC winner in place', r2 && r2.key);
  ok(r2 && r2.priority === stpLib.STP_DEFAULT_PRIORITY, 'and the root still runs the default', r2 && r2.priority);
}

console.log('');
console.log('A priority the standard cannot express is refused, not rounded:');
{
  const env = triangle();
  const bad = run(env, 's3', ['enable', 'configure terminal', 'spanning-tree priority 4500']);
  ok(/% 4500 is not a valid bridge priority/.test(bad), 'a value that is not a multiple of 4096 is refused', bad.slice(0, 80));
  ok(/multiple of 4096/.test(bad), 'and the refusal names the rule');
  ok(/nearest valid values are 4096 and 8192/.test(bad), 'and offers the two values that would work', bad.slice(0, 160));
  ok(env.t.getDevice('s3').config.stpPriority === null, 'nothing was stored');

  const high = run(env, 's3', ['enable', 'configure terminal', 'spanning-tree priority 65536']);
  ok(/range is 0 to 61440/.test(high), 'a value above the range is refused with the range', high.slice(0, 90));

  const notNumber = run(env, 's3', ['enable', 'configure terminal', 'spanning-tree priority high']);
  // It used to print the bare usage line. Naming the word is the difference between "something is wrong here"
  // and "this word is the problem" - and it keeps `priority high` distinguishable from `spanning-tree portfast`,
  // which is now answered about portfast (#1493).
  ok(/"high" is not a bridge priority/.test(notNumber), 'a word instead of a number is quoted back as the problem', notNumber.slice(0, 110));
  ok(/takes a number/.test(notNumber), 'and the refusal says what the command does take');
  ok(env.t.getDevice('s3').config.stpPriority === null, 'and still nothing is stored');

  // IOS spells this per VLAN. One spanning tree means one priority, so a VLAN id must not be accepted and
  // quietly applied to everything.
  const perVlan = run(env, 's3', ['enable', 'configure terminal', 'spanning-tree vlan 1 priority 4096']);
  ok(/one spanning tree, not one per VLAN/.test(perVlan), 'a per-VLAN form is refused, naming the reason', perVlan.slice(0, 100));
  ok(env.t.getDevice('s3').config.stpPriority === null, 'and it does not set the device-wide value instead');
}

console.log('');
console.log('Clearing it puts the election back:');
{
  const env = triangle();
  run(env, 's1', ['enable', 'configure terminal', 'spanning-tree priority 0']);
  ok(election(env).key === 's1', 'priority 0 is the lowest possible and wins', election(env).key);
  const cleared = run(env, 's1', ['enable', 'configure terminal', 'no spanning-tree priority']);
  ok(/back to the default 32768/.test(cleared), 'clearing says what the default is', cleared.slice(0, 90));
  ok(env.t.getDevice('s1').config.stpPriority === null, 'and stores nothing');
  ok(election(env).key === 's3', 'so the MAC winner is root again', election(env).key);
  const again = run(env, 's1', ['enable', 'configure terminal', 'no spanning-tree priority']);
  ok(/No bridge priority set/.test(again), 'clearing twice refuses rather than pretending', again.slice(0, 90));
}

console.log('');
console.log('The report explains the tree it prints:');
{
  const env = triangle();
  run(env, 's1', ['enable', 'configure terminal', 'spanning-tree priority 4096']);
  election(env);
  const shown = run(env, 's1', ['enable', 'show spanning-tree']);
  ok(/Bridge priority 4096/.test(shown), 'show spanning-tree prints the priority in force', shown.split('\n')[0]);
  ok(/this bridge is the root/.test(shown), 'and says when this bridge is the root');
  ok(/root bridge s1 priority 4096/.test(shown), 'naming the device by its lab name, not its model', shown.split('\n')[0]);
  const other = run(env, 's2', ['enable', 'show spanning-tree']);
  ok(/Bridge priority 32768/.test(other), 'a switch that kept the default says 32768', other.split('\n')[0]);
  ok(!/this bridge is the root/.test(other), 'and does not claim to be the root');
  ok(/root bridge s1 priority 4096/.test(other), 'while still naming who is');

  // No simulator: the command must not invent an election result.
  const bare = new CliSession(env.t.getDevice('s2'), env.t, null);
  bare.run('enable');
  const unmeasured = (bare.run('show spanning-tree') || {}).output.join('\n');
  ok(/root bridge not measured/.test(unmeasured), 'with no election behind it, the root is reported as not measured',
    unmeasured.split('\n').slice(0, 2).join(' / '));
}

console.log('');
console.log('A router with nothing to bridge is told the truth:');
{
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  const sim = new Simulator(t);
  const s = new CliSession(t.getDevice('r1'), t, sim);
  s.run('enable'); s.run('configure terminal');
  const said = (s.run('spanning-tree priority 4096') || {}).output.join(' ');
  ok(/no bridging ports/.test(said), 'setting it on a router says no election runs here', said.slice(0, 120));
  ok(t.getDevice('r1').config.stpPriority === 4096, 'the value is still stored, because the box can gain ports later');
}

console.log('');
console.log('The priority survives a save, and so does the root it chose:');
{
  const env = triangle();
  run(env, 's2', ['enable', 'configure terminal', 'spanning-tree priority 4096']);
  const before = election(env);
  const doc = env.t.serialize();
  const json = JSON.parse(JSON.stringify(doc));
  const back = Topology.fromJSON(json, specs);
  const sim2 = new Simulator(back);
  sim2.setRunTime(Infinity);
  if (typeof sim2.recomputeStp === 'function') sim2.recomputeStp(); else sim2.computeStp();
  const after = (sim2.stpResult || {}).root || {};
  ok(back.getDevice('s2').config.stpPriority === 4096, 'the reloaded device has its priority', back.getDevice('s2').config.stpPriority);
  ok(after.key === before.key, 'and the root is the same bridge (' + before.key + ')', after.key);
  ok(after.priority === before.priority, 'with the same priority', after.priority);

  // A device that never set one must not grow a value on the way through.
  ok(back.getDevice('s3').config.stpPriority === null, 'a switch that kept the default comes back with no value');
  const doc2 = back.serialize();
  const s3doc = doc2.devices.filter(function (d) { return d.id === 's3'; })[0];
  ok(!('stpPriority' in s3doc.config),
    'and the document does not carry a priority it never had (key absent, not null)',
    JSON.stringify(s3doc.config.stpPriority));
}

console.log('');
console.log('The running-config carries it, so a restore keeps the root:');
{
  const env = triangle();
  run(env, 's2', ['enable', 'configure terminal', 'spanning-tree priority 4096']);
  const config = run(env, 's2', ['enable', 'show running-config']);
  const line = config.split('\n').filter(function (l) { return /spanning-tree/.test(l); })[0];
  ok(!!line && /spanning-tree priority 4096/.test(line), 'the line is printed', line);

  // Replay it onto a fresh box: the printer and the parser have to agree, or a paste changes the election.
  const fresh = new Topology();
  fresh.addDevice(SW, 's2');
  const s = new CliSession(fresh.getDevice('s2'), fresh, null);
  s.run('enable'); s.run('configure terminal');
  const replay = (s.run('spanning-tree priority 4096') || {}).output.join(' ');
  ok(fresh.getDevice('s2').config.stpPriority === 4096, 'replaying the printed line sets the same value', replay.slice(0, 60));

  const bare = run(triangle(), 's2', ['enable', 'show running-config']);
  ok(!/spanning-tree/.test(bare), 'a device with no priority prints no line for it');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
