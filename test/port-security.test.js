'use strict';
// port-security.test.js - the switch's opinion about who may speak on a port.
//
// Measured before this pass, on a switch that already learns a source MAC per port and VLAN:
//   SW1(config-if)#switchport port-security
//   % Unrecognized interface command: switchport port-security
//   SW1#show port-security
//   % Invalid show command: port-security
//
// The bridge learned whatever arrived and forwarded to whatever it had learned, with no opinion about
// who was allowed to speak. Port security is the opinion, and the three violation modes are the point:
// they differ in what they cost, and a model that only dropped the frame would hide the difference.
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
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 800)) + ')'));
}
function noMatch(re, haystack, msg) {
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(!re.test(text), msg + (re.test(text) ? ' (found ' + re + ')' : ''));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const INTRUDER = '02:00:00:00:99:99';

function lab(opts) {
  const o = opts || {};
  const t = new Topology();
  const sw = t.addDevice(o.device || SWITCH); sw.name = 'SW1';
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
  const port = ports[0];
  const secure = function (lines) {
    return cfg(a, ['interface ' + port, 'switchport mode access'].concat(lines || []));
  };
  return { t: t, sim: sim, sw: sw, pc: pc, a: a, s1: s1, cfg: cfg, secure: secure,
    port: port, ports: ports, mac1: pc.interfaces.get('eth0').mac };
}

// A frame arriving on the secured port. `_processFrame` is the function the data path calls when a
// frame arrives, so this is the same door and the same order of checks, not a shortcut around them.
function speak(env, mac, ip) {
  const frame = { etherType: 0x0806, srcMac: mac, dstMac: 'ff:ff:ff:ff:ff:ff',
    arp: { op: 'request', senderMac: mac, senderIp: ip || '10.0.0.99',
      targetMac: '00:00:00:00:00:00', targetIp: '10.0.0.254' } };
  const from = (env.sim.events || []).length;
  env.sim._processFrame(env.sw, frame, env.port);
  return (env.sim.events || []).slice(from);
}
function types(events) { return events.map(function (e) { return e.type; }); }

console.log('\nA port is secured with IOS defaults, and says what they are:');
{
  const env = lab();
  const out = env.secure(['switchport port-security']);
  match(/Port security enabled on Fa0\/1/, out, 'the port is secured');
  match(/Maximum 1 secure address, violation mode shutdown \(IOS defaults\)/, out,
    'the defaults are named, because they decide what happens next');
  match(/The first source to arrive is learned; a second one is a violation/, out,
    'and the behaviour is stated in one sentence');
  match(/already enabled on Fa0\/1 \(maximum 1, violation shutdown\)/,
    env.secure(['switchport port-security']), 'enabling twice reports the settings rather than re-enabling');
  const summary = env.a.run('show port-security').output;
  match(/Secure Port\s+MaxSecureAddr\s+CurrentAddr\s+SecurityViolation\s+Security Action/, summary,
    'the summary table has the columns IOS prints');
  match(/Fa0\/1\s+1\s+0\s+0\s+shutdown/, summary, 'with the port, its limit, its count, its violations and its mode');
  match(/1 secured port of 8 bridged ports/, summary, 'and how many of the switch\'s ports are secured');
}

console.log('\nThe first source is learned - that is not a violation:');
{
  const env = lab();
  env.secure(['switchport port-security']);
  const ev = speak(env, env.mac1, '10.0.0.50');
  ok(types(ev).indexOf('port-security-learn') !== -1, 'learning the first source is an event');
  noMatch(/port-security-drop/, types(ev).join(' '), 'and nothing is dropped');
  eq(env.sw.macTableFor(1).get(env.mac1), env.port, 'the address is in the CAM as usual');
  const addr = env.a.run('show port-security address').output;
  match(/02:00:00:00:01:00\s+1\s+Fa0\/1\s+SecureDynamic\s+0/, addr,
    'and `show port-security address` lists it as learned');
  match(/1 secure address: 0 configured, 0 sticky, 1 learned/, addr, 'with a count that adds up');
  // Speaking again from the same address is the normal case and must stay cheap.
  const again = speak(env, env.mac1, '10.0.0.50');
  ok(types(again).indexOf('port-security-learn') === -1, 'a known source is not relearned');
  noMatch(/port-security-drop/, types(again).join(' '), 'and is not a violation');
  eq((env.a.run('show port-security address').output.join('\n').match(/02:00:00:00:01:00/g) || []).length, 1,
    'and appears once in the table');
}

console.log('\n`shutdown` costs the port: the frame is dropped and the port err-disables:');
{
  const env = lab();
  env.secure(['switchport port-security']);
  speak(env, env.mac1, '10.0.0.50');
  const ev = speak(env, INTRUDER);
  const drop = ev.filter(function (e) { return e.type === 'port-security-drop'; })[0];
  ok(!!drop, 'the intruding frame is dropped');
  eq(drop && drop.mode, 'shutdown', 'and the event names the mode that decided it');
  eq(drop && drop.errDisabled, true, 'and that the port was disabled');
  // The frame must not be remembered: the table would then contain the address the port refused.
  eq(env.sw.macTableFor(1).get(INTRUDER), undefined, 'the intruder is not learned on the way past');
  const summary = env.a.run('show port-security').output;
  match(/Fa0\/1 \(err-disabled\)\s+1\s+1\s+1\s+shutdown/, summary,
    'the summary marks the port err-disabled and counts one violation');
  match(/1 err-disabled by a violation: Fa0\/1 - "shutdown" then "no shutdown" recovers/, summary,
    'and names the recovery');
  match(/Fa0\/1\s+err-disabled\s+1/, env.a.run('show interfaces status').output,
    '`show interfaces status` says err-disabled, not notconnect: something is plugged in');
  const detail = env.a.run('show port-security interface Fa0/1').output;
  match(/Port Status\s+: Secure-shutdown/, detail, 'the detail says Secure-shutdown');
  match(/Last Source Address:Vlan\s+: 02:00:00:00:99:99:1/, detail, 'and names the last source seen');
  match(/Security Violation Count\s+: 1/, detail, 'and the count');
  // A second frame arrives on a dead port: dropped, and not counted twice for one incident.
  const second = speak(env, INTRUDER);
  const secondDrop = second.filter(function (e) { return e.type === 'port-security-drop'; })[0];
  ok(!!secondDrop, 'a frame on an err-disabled port is still dropped');
  eq(secondDrop && secondDrop.counted, false,
    'and is not counted: one incident is one violation, not one per frame');
  match(/Security Violation Count\s+: 1/, env.a.run('show port-security interface Fa0/1').output,
    'and the count stays at one');
}

console.log('\n`restrict` costs the counter: the frame is dropped and the port keeps working:');
{
  const env = lab();
  const setMode = env.secure(['switchport port-security', 'switchport port-security violation restrict']);
  match(/Violation mode on Fa0\/1 set to restrict/, setMode, 'the mode is set');
  speak(env, env.mac1, '10.0.0.50');
  const ev = speak(env, INTRUDER);
  const drop = ev.filter(function (e) { return e.type === 'port-security-drop'; })[0];
  eq(drop && drop.mode, 'restrict', 'the drop names restrict');
  eq(drop && drop.errDisabled, false, 'and does not disable the port');
  eq(drop && drop.counted, true, 'and is counted');
  match(/Port Status\s+: Secure-up/, env.a.run('show port-security interface Fa0/1').output,
    'the port is still Secure-up');
  match(/Security Violation Count\s+: 1/, env.a.run('show port-security interface Fa0/1').output, 'one violation');
  speak(env, INTRUDER);
  match(/Security Violation Count\s+: 2/, env.a.run('show port-security interface Fa0/1').output,
    'and a second intruding frame is a second violation');
  match(/Fa0\/1\s+1\s+1\s+2\s+restrict/, env.a.run('show port-security').output, 'the summary agrees');
  match(/Fa0\/1\s+connected\s+1/, env.a.run('show interfaces status').output, 'the port is still connected');
  // The host it serves is unaffected.
  const known = speak(env, env.mac1, '10.0.0.50');
  noMatch(/port-security-drop/, types(known).join(' '), 'the allowed station keeps working');
}

console.log('\n`protect` costs nothing visible: dropped, not counted, not logged:');
{
  const env = lab();
  env.secure(['switchport port-security', 'switchport port-security violation protect']);
  speak(env, env.mac1, '10.0.0.50');
  const ev = speak(env, INTRUDER);
  const drop = ev.filter(function (e) { return e.type === 'port-security-drop'; })[0];
  eq(drop && drop.mode, 'protect', 'the frame is dropped by protect');
  eq(drop && drop.counted, false, 'and is not counted');
  match(/Security Violation Count\s+: 0/, env.a.run('show port-security interface Fa0/1').output,
    'the counter stays at zero - which is what protect means, and why it hides incidents');
  match(/Port Status\s+: Secure-up/, env.a.run('show port-security interface Fa0/1').output, 'the port is up');
  eq(env.sw.macTableFor(1).get(INTRUDER), undefined, 'and the intruder is not learned');
}

console.log('\nThe limit is the thing being decided, so it can be raised and lowered:');
{
  const env = lab();
  const setMax = env.secure(['switchport port-security', 'switchport port-security maximum 2']);
  match(/maximum on Fa0\/1 set to 2/, setMax, 'the limit is set');
  speak(env, env.mac1, '10.0.0.50');
  const second = speak(env, INTRUDER);
  noMatch(/port-security-drop/, types(second).join(' '), 'a second source fits inside a limit of 2');
  const third = speak(env, '02:00:00:00:98:98');
  ok(types(third).indexOf('port-security-drop') !== -1, 'and a third one does not');
  match(/Fa0\/1 \(err-disabled\)\s+2\s+2\s+1\s+shutdown/, env.a.run('show port-security').output,
    'two addresses held of a maximum of two, one violation');
  // Lowering the limit below what is held keeps the addresses and refuses the next new one.
  const env2 = lab();
  env2.secure(['switchport port-security', 'switchport port-security maximum 3']);
  speak(env2, env2.mac1, '10.0.0.50');
  speak(env2, INTRUDER);
  const lowered = env2.secure(['switchport port-security maximum 1']);
  match(/The port already holds 2 secure addresses - they are kept, and the next new source is a violation/,
    lowered, 'lowering the limit keeps the addresses and says what happens next');
  ok(types(speak(env2, '02:00:00:00:97:97')).indexOf('port-security-drop') !== -1,
    'and the next new source is a violation');
}

console.log('\nConfigured and sticky addresses are two different kinds of "allowed":');
{
  const env = lab();
  env.secure(['switchport port-security', 'switchport port-security mac-address 0200.0000.0100']);
  const out = env.secure(['switchport port-security mac-address 0200.0000.0100']);
  match(/Secure address 02:00:00:00:01:00 is already configured on Fa0\/1/, out,
    'the same address twice is reported, not stored twice');
  const addr = env.a.run('show port-security address').output;
  match(/02:00:00:00:01:00\s+1\s+Fa0\/1\s+SecureConfigured/, addr, 'a configured address is SecureConfigured');
  match(/1 secure address: 1 configured, 0 sticky, 0 learned/, addr, 'and the count says so');
  // A configured address is allowed; anything else is not, even with the port otherwise empty.
  noMatch(/port-security-drop/, types(speak(env, env.mac1)).join(' '), 'the configured station is allowed');
  ok(types(speak(env, INTRUDER)).indexOf('port-security-drop') !== -1, 'and another station is refused');
  // Sticky: learned, and remembered.
  const env2 = lab();
  const sticky = env2.secure(['switchport port-security', 'switchport port-security mac-address sticky']);
  match(/Sticky learning enabled on Fa0\/1/, sticky, 'sticky learning is enabled');
  speak(env2, env2.mac1, '10.0.0.50');
  match(/02:00:00:00:01:00\s+1\s+Fa0\/1\s+SecureSticky/, env2.a.run('show port-security address').output,
    'a sticky address is SecureSticky');
  match(/Sticky MAC Addresses\s+: 1/, env2.a.run('show port-security interface Fa0/1').output,
    'and the detail counts it as sticky');
  match(/Sticky learning disabled on Fa0\/1/, env2.secure(['no switchport port-security mac-address sticky']),
    'sticky can be turned off again');
  match(/02:00:00:00:01:00\s+1\s+Fa0\/1\s+SecureSticky/, env2.a.run('show port-security address').output,
    'and the addresses it learned stay secure');
}

console.log('\nRecovery is the port\'s own word, and the evidence survives it:');
{
  const env = lab();
  env.secure(['switchport port-security']);
  speak(env, env.mac1, '10.0.0.50');
  speak(env, INTRUDER);
  const recovered = env.secure(['no shutdown']);
  match(/Fa0\/1 up/, recovered, '`no shutdown` brings the port up');
  match(/err-disable cleared: port security violation: 02:00:00:00:99:99 on a port that allows 1/, recovered,
    'and says what the port was refusing and why');
  match(/Security violation count kept at 1/, recovered,
    'the counter is kept: deleting it would delete the reason the port went down');
  match(/Port Status\s+: Secure-up/, env.a.run('show port-security interface Fa0/1').output,
    'the port is Secure-up again');
  match(/Fa0\/1\s+connected\s+1/, env.a.run('show interfaces status').output, 'and connected again');
  // Not recovered, the port stays down: `no shutdown` is the decision, not a side effect.
  const env2 = lab();
  env2.secure(['switchport port-security']);
  speak(env2, env2.mac1, '10.0.0.50');
  speak(env2, INTRUDER);
  match(/Fa0\/1\s+err-disabled\s+1/, env2.a.run('show interfaces status').output,
    'an err-disabled port stays err-disabled until somebody says otherwise');
  const blocked = speak(env2, env2.mac1, '10.0.0.50');
  ok(types(blocked).indexOf('port-security-drop') !== -1,
    'and even the allowed station is refused while it is down');
}

console.log('\nSecurity is configuration, so it dumps, pastes, and turns off cleanly:');
{
  const env = lab();
  env.secure(['switchport port-security', 'switchport port-security maximum 3',
    'switchport port-security mac-address 0200.0000.0100',
    'switchport port-security mac-address sticky',
    'switchport port-security violation restrict']);
  const dump = env.a.run('show running-config').output;
  match(/^\s+switchport port-security$/m, dump, 'the feature is dumped inside the interface block');
  match(/^\s+switchport port-security maximum 3$/m, dump, 'with its limit');
  match(/^\s+switchport port-security mac-address 0200\.0000\.0100$/m, dump,
    'its configured address, in the spelling the console takes');
  match(/^\s+switchport port-security mac-address sticky$/m, dump, 'its sticky setting');
  match(/^\s+switchport port-security violation restrict$/m, dump, 'and its violation mode');
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
  ok(!!st, 'the pasted config secures the same port');
  eq(st && st.maximum, 3, 'with the same limit');
  eq(st && st.violation, 'restrict', 'the same violation mode');
  ok(st && st.configured.indexOf(env.mac1) !== -1, 'and the same configured address');
  eq(st && st.sticky, true, 'and sticky learning on');
  // Off is one line, and says what it stops doing.
  const off = env.secure(['no switchport port-security']);
  match(/Port security disabled on Fa0\/1/, off, 'the feature can be turned off');
  match(/The port accepts any source again - secure addresses, counters and err-disable state are gone/, off,
    'and the answer says what that means');
  eq(env.sw.portSecurity.ports[env.port], undefined, 'nothing is left in the table for that port');
  noMatch(/switchport port-security/m, env.a.run('show running-config').output,
    'and nothing is left in the running-config');
}

console.log('\nA word this command does not use is refused where it is typed:');
{
  const env = lab();
  // A router has no port to secure, and the refusal says which feature it is missing.
  const r = new Topology();
  const r1 = r.addDevice(ROUTER);
  const rs = new CliSession(r1, r, new Simulator(r));
  rs.run('enable'); rs.run('configure terminal'); rs.run('interface Gi0/0');
  const routerOut = rs.run('switchport port-security').output;
  match(/does not switch, so it has no port to secure/, routerOut, 'a router is refused by what it lacks');
  match(/Port security is a bridge feature/, routerOut, 'and told what the feature is');
  // A trunk port is not an access port.
  const trunk = env.cfg(env.a, ['interface ' + env.port, 'switchport mode trunk', 'switchport port-security']);
  match(/is a trunk port: this model secures access ports/, trunk, 'a trunk port is refused with the reason');
  env.cfg(env.a, ['interface ' + env.port, 'switchport mode access', 'switchport port-security']);
  for (const [line, why] of [
    ['switchport port-security maximum abc', 'a limit is a number'],
    ['switchport port-security maximum 0', 'zero addresses is not a limit'],
    ['switchport port-security maximum 3073', 'IOS tops out at 3072'],
    ['switchport port-security violation drop', 'that is not one of the three modes'],
    ['switchport port-security mac-address 0011.2233', 'a MAC has twelve hex digits'],
    ['switchport port-security mac-address 0100.5e00.0001', 'a multicast address is not a station'],
    ['switchport port-security maximum', 'the limit is missing'],
    ['switchport port-security violation', 'the mode is missing'],
    ['switchport port-security mac-address', 'the address is missing'],
    ['switchport port-security maximum 2 3', 'a limit is one number']
  ]) {
    const out = env.cfg(env.a, ['interface ' + env.port, line]).join('\n');
    match(/%/, out, '"' + line + '" is refused (' + why + ')');
  }
  // An address is on one port, not two: pin it on Fa0/1, then ask for it on Fa0/2.
  env.cfg(env.a, ['interface ' + env.port, 'switchport port-security mac-address 0200.0000.0100']);
  const dup = env.cfg(env.a, ['interface ' + env.ports[1], 'switchport mode access',
    'switchport port-security', 'switchport port-security mac-address 0200.0000.0100']);
  match(/already a secure address on Fa0\/1/, dup, 'the same station cannot be secured on two ports');
  match(/One station is on one port: remove it there first/, dup, 'and the way to resolve it is named');
  eq(env.sw.portSecurity.ports[env.ports[1]].configured.length, 0, 'and the refusal stored nothing');
  // `show port-security` on a router, and a port that is not secured.
  const rs2 = new CliSession(r1, r, new Simulator(r));
  rs2.run('enable');
  match(/does not switch, so it has no secured ports/, rs2.run('show port-security').output,
    '`show port-security` on a router says why there is nothing to show');
  // Fa0/3 was never touched, so it is the port that is not secured.
  match(/Port security is not enabled on Fa0\/3/,
    env.a.run('show port-security interface ' + env.ports[2]).output,
    'an unsecured port answers for itself');
  match(/Enable it with "switchport port-security"/,
    env.a.run('show port-security interface ' + env.ports[2]).output, 'and names the command that would');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
