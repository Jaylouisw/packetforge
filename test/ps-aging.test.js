'use strict';
// ps-aging.test.js - the three settings the detail view printed and nothing could configure.
//
// Measured before this pass, on the port-security model committed two iterations earlier:
//   SW1#show port-security interface Fa0/1
//   Aging Time                 : 0 mins
//   Aging Type                 : Absolute
//   SecureStatic Address Aging : Disabled
//   SW1(config-if)#switchport port-security aging time 1
//   % Unrecognized port-security command: aging
//
// Three lines of a show command describing a device that was not there - the same defect as
// recommending a command that does not exist. Aging is also what stops a secure port being pinned to
// a laptop that has left the building, so it is the setting that makes the feature usable.
//
// "Now" here is the instant a question is asked about (`sim.setRunTime(ms)` / `at <ms>`, the same
// clock the rest of the console uses), because the lab has no wall clock to age against.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) + ')'));
}
function match(re, haystack, msg) {
  if (haystack && Array.isArray(haystack.output)) haystack = haystack.output;
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 800)) + ')'));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });
const MIN = 60 * 1000;

function lab() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  const pc = t.addDevice(PC); pc.name = 'PC1';
  const ports = Array.from(sw.interfaces.keys()).filter(function (n) {
    const i = sw.interfaces.get(n);
    return !i.svi && !i.parent;
  });
  t.connect(pc.id, 'eth0', sw.id, ports[0]);
  const sim = new Simulator(t);
  const mk = function (d) { const s = new CliSession(d, t, sim); s.run('enable'); return s; };
  const a = mk(sw), s1 = mk(pc);
  const cfg = function (s, cmds) {
    s.run('configure terminal');
    const out = [];
    for (const c of cmds) out.push.apply(out, s.run(c).output);
    s.run('end');
    return out;
  };
  cfg(s1, ['hostname PC1', 'interface eth0', 'ip address 10.0.0.50 255.255.255.0', 'exit']);
  const secure = function (cmds) {
    return cfg(a, ['interface ' + ports[0], 'switchport mode access', 'switchport port-security'].concat(cmds || []));
  };
  // A frame from `mac` arriving on the port at lab instant `atMs`.
  const speak = function (mac, atMs, port) {
    if (atMs !== undefined) sim.setRunTime(atMs);
    const frame = { etherType: 0x0806, srcMac: mac, dstMac: 'ff:ff:ff:ff:ff:ff',
      arp: { op: 'request', senderMac: mac, senderIp: '10.0.0.9',
        targetMac: '00:00:00:00:00:00', targetIp: '10.0.0.254' } };
    const from = (sim.events || []).length;
    sim._processFrame(sw, frame, port || ports[0]);
    return (sim.events || []).slice(from);
  };
  const idle = function (ms) { sim.setRunTime(ms); };
  return { t: t, sim: sim, sw: sw, pc: pc, a: a, cfg: cfg, secure: secure, speak: speak, idle: idle,
    port: ports[0], ports: ports, mac: pc.interfaces.get('eth0').mac };
}

console.log('\nThe three lines are settings now, and each says what it does:');
{
  const env = lab();
  const out = env.secure(['switchport port-security aging time 1']);
  match(/Aging time on Fa0\/1 set to 1 min/, out, 'the aging time can be set');
  match(/An address that has not been held for 1 min leaves the port, and the slot is free for the next station/,
    out, 'and the consequence is stated, because that is what aging is for');
  match(/Aging Time\s+: 1 mins/, env.a.run('show port-security interface Fa0/1'), 'the detail view reports it');
  const setType = env.secure(['switchport port-security aging type inactivity']);
  match(/Aging type on Fa0\/1 set to inactivity/, setType, 'the aging type can be set');
  match(/the clock resets every time the address is seen, so a quiet station ages out/,
    setType, 'and the two types are distinguished');
  match(/Aging Type\s+: Inactivity/, env.a.run('show port-security interface Fa0/1'), 'the detail view agrees');
  match(/Aging of static addresses enabled on Fa0\/1/, env.secure(['switchport port-security aging static']),
    'configured addresses can be made to age too');
  match(/SecureStatic Address Aging : Enabled/, env.a.run('show port-security interface Fa0/1'),
    'and the detail view says so');
  // The defaults are stated rather than implied.
  const fresh = lab();
  fresh.secure();
  const detail = fresh.a.run('show port-security interface Fa0/1').output.join('\n');
  match(/Aging Time\s+: 0 mins/, detail, 'a port that never asked for aging says 0 mins');
  match(/Aging Type\s+: Absolute/, detail, 'and names the default type');
  match(/SecureStatic Address Aging : Disabled/, detail, 'and the default for configured addresses');
}

console.log('\n`inactivity` ages from the last time the station was seen:');
{
  const env = lab();
  env.secure(['switchport port-security aging time 1', 'switchport port-security aging type inactivity']);
  env.speak(env.mac, 0);
  match(/02:00:00:00:01:00\s+1\s+Fa0\/1/, env.a.run('show port-security address'), 'the address is held');
  // Seen again at 50 s: the clock restarts, so at 70 s it is only 20 s idle and must still be held.
  env.speak(env.mac, 50000);
  env.idle(70000);
  match(/02:00:00:00:01:00\s+1\s+Fa0\/1/, env.a.run('show port-security address'),
    'traffic resets the clock, so the address is still held at 70s');
  // At 110 s it is 60 s since the last sighting: aged out.
  env.idle(110 * 1000);
  const addr = env.a.run('show port-security address').output;
  match(/No secure addresses at this instant: 1 aged out \(02:00:00:00:01:00 on Fa0\/1\)/, addr,
    'and it ages out 60s after the last sighting');
  match(/Secured ports with a free slot: Fa0\/1/, addr, 'the empty table says why it is empty');
  // The event is written by the data path, not by the show command (the show above already swept
  // this table). A fresh lab, a frame at the later instant, and the sweep is visible on the timeline.
  const dataPath = lab();
  dataPath.secure(['switchport port-security aging time 1', 'switchport port-security aging type inactivity']);
  dataPath.speak(dataPath.mac, 0);
  const late = dataPath.speak('02:00:00:00:77:77', 130 * 1000);
  const aged = late.filter(function (e) { return e.type === 'port-security-age'; })[0];
  ok(!!aged, 'aging is on the timeline when the data path meets it');
  eq(aged && aged.mac, dataPath.mac, 'naming the address that left');
  eq(aged && aged.iface, dataPath.port, 'and the port it left');
  ok(late.some(function (e) { return e.type === 'port-security-learn'; }),
    'and the frame that met it takes the freed slot');
}

console.log('\n`absolute` ages from the first sighting, whatever the traffic does:');
{
  const env = lab();
  env.secure(['switchport port-security aging time 1']);   // absolute is the default type
  env.speak(env.mac, 0);
  env.speak(env.mac, 50000);
  env.idle(70000);
  // 70 s from the first sighting is past 1 min, and the 50 s traffic does not buy more time.
  match(/No secure addresses at this instant: 1 aged out/, env.a.run('show port-security address'),
    'absolute ages from the first sighting, so traffic does not extend its life');
}

console.log('\nAn aged-out address frees the slot, which is the point of aging:');
{
  const env = lab();
  // `restrict` so the violation counts without err-disabling the port: this block is about the slot,
  // not about what a violation costs.
  env.secure(['switchport port-security aging time 1', 'switchport port-security aging type inactivity',
    'switchport port-security violation restrict']);
  env.speak(env.mac, 0);
  // A second station is a violation while the first is held: the port is full.
  const blocked = env.speak('02:00:00:00:99:99', 10000);
  ok(blocked.some(function (e) { return e.type === 'port-security-drop'; }),
    'while the address is held, a second station is a violation');
  // Now let the first age out, and the same second station is simply the new occupant.
  const accepted = env.speak('02:00:00:00:99:99', 120 * 1000);
  ok(accepted.some(function (e) { return e.type === 'port-security-learn'; }),
    'once it has aged out, the next station is learned instead of refused');
  match(/02:00:00:00:99:99\s+1\s+Fa0\/1\s+SecureDynamic/, env.a.run('show port-security address'),
    'and it is the address the port holds');
  // Aging runs before the decision, so the violation count did not move for the accepted frame.
  match(/Security Violation Count\s+: 1/, env.a.run('show port-security interface Fa0/1'),
    'the one violation was the frame that really was a violation');
}

console.log('\nNo aging configured means nothing ever ages out:');
{
  const env = lab();
  env.secure();
  env.speak(env.mac, 0);
  env.idle(30 * 24 * 60 * MIN);
  match(/02:00:00:00:01:00\s+1\s+Fa0\/1/, env.a.run('show port-security address'),
    'a port that never asked for aging keeps its address a month later');
  match(/^0 mins$/m, env.a.run('show port-security interface Fa0/1').output
    .filter(function (l) { return /^Aging Time/.test(l); }).map(function (l) { return l.split(': ')[1]; }),
    'which is what "0 mins" means');
}

console.log('\nConfigured addresses are permanent unless aging static says otherwise:');
{
  const env = lab();
  env.secure(['switchport port-security aging time 1', 'switchport port-security aging type inactivity',
    'switchport port-security mac-address 0200.0000.0abc']);
  env.idle(10 * MIN);
  match(/02:00:00:00:0a:bc\s+1\s+Fa0\/1\s+SecureConfigured/,
    env.a.run('show port-security address').output.join('\n'),
    'a configured address survives aging by default');
  const env2 = lab();
  env2.secure(['switchport port-security aging time 1', 'switchport port-security aging type inactivity',
    'switchport port-security aging static', 'switchport port-security mac-address 0200.0000.0abc']);
  env2.idle(10 * MIN);
  match(/No secure addresses at this instant/, env2.a.run('show port-security address'),
    'with aging static, a configured address ages out too');
  const ret = env2.secure(['no switchport port-security aging static']);
  match(/Aging of static addresses disabled on Fa0\/1/, ret, 'and it can be turned off again');
  match(/Configured addresses are kept until "no switchport port-security mac-address" removes them/, ret,
    'naming the command that does remove them');
}

console.log('\nEvery word of the aging command is checked where it is typed:');
{
  const env = lab();
  env.secure();
  for (const [line, why] of [
    ['switchport port-security aging', 'a setting is required'],
    ['switchport port-security aging bogus', 'that is not a setting'],
    ['switchport port-security aging time', 'the time is missing'],
    ['switchport port-security aging time abc', 'a time is a number'],
    ['switchport port-security aging time 0', 'zero is not a time: it is the absence of one'],
    ['switchport port-security aging time 1441', 'IOS tops out at 1440 minutes'],
    ['switchport port-security aging type', 'the type is missing'],
    ['switchport port-security aging type forever', 'that is not an aging type'],
    ['switchport port-security aging time 5 6', 'a time is one number'],
    ['switchport port-security aging static extra', 'static takes no argument']
  ]) {
    match(/%/, env.secure([line]), '"' + line + '" is refused (' + why + ')');
  }
  match(/is outside 1-1440 minutes/, env.secure(['switchport port-security aging time 1441']),
    'the range refusal names the range');
  match(/To stop aging entirely: no switchport port-security aging time/,
    env.secure(['switchport port-security aging time 0']),
    'and points at the way to turn aging off, which is not 0');
  // Idempotence, both ways.
  env.secure(['switchport port-security aging time 5']);
  match(/is already 5 min/, env.secure(['switchport port-security aging time 5']), 'setting it twice says so');
  match(/reset to 0 - secure addresses no longer age out \(was 5 min\)/,
    env.secure(['no switchport port-security aging time']), 'and the time can be reset, naming what it was');
  match(/already disabled/, env.secure(['no switchport port-security aging static']),
    'turning off what is already off says so');
  match(/already absolute/, env.secure(['no switchport port-security aging type']),
    'and the type resets to the default it already had');
}

console.log('\nAging is configuration, so it dumps and pastes:');
{
  const env = lab();
  env.secure(['switchport port-security aging time 10', 'switchport port-security aging type inactivity',
    'switchport port-security aging static']);
  const dump = env.a.run('show running-config').output;
  match(/^\s+switchport port-security aging time 10$/m, dump, 'the time is dumped');
  match(/^\s+switchport port-security aging type inactivity$/m, dump, 'the type is dumped');
  match(/^\s+switchport port-security aging static$/m, dump, 'and aging static');
  // A port on the defaults contributes none of the three lines.
  const fresh = lab();
  fresh.secure();
  const plain = fresh.a.run('show running-config').output.join('\n');
  ok(!/aging/.test(plain), 'a port left on the defaults contributes no aging line');
  const t2 = new Topology();
  const twin = t2.addDevice(SWITCH);
  const s2 = new CliSession(twin, t2, new Simulator(t2));
  s2.run('enable'); s2.run('configure terminal');
  for (const line of dump.slice(1)) {
    // Ordinary control flow: the banner and the terminator are not commands to paste.
    if (/^!/.test(line) || /^end$/.test(line)) continue;
    s2.run(line);
  }
  s2.run('end');
  const st = twin.portSecurity.ports[env.port];
  eq(st && st.agingTimeMin, 10, 'the pasted config restores the aging time');
  eq(st && st.agingType, 'inactivity', 'the type');
  eq(st && st.agingStatic, true, 'and aging static');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
