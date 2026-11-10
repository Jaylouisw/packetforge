'use strict';
// port-physical.test.js - three commands every operator reaches for, and none of them existed.
//
// Measured before this pass, on a router port and on a switch port:
//   R1(config-if)#mtu 1400
//   % Unrecognized interface command: mtu 1400
//   % Unrecognized config command: mtu 1400
//   R1(config-if)#speed 100       -> the same two lines
//   R1(config-if)#duplex full     -> the same two lines
//
// While the model already carried `iface.mtu`, `iface.speed` and `iface.duplex`, already derived a
// path MTU from the MTU (`pathMtu()` takes the minimum over the path) and already derived a
// spanning-tree path cost from the speed (`speedToCost()`). So the three settings were used by the
// engine and unreachable from the console: an operator could see a 1500-byte MTU in a flow's MSS and
// had no way to change it.
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
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 500)) + ')'));
}
function noMatch(re, haystack, msg) {
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(!re.test(text), msg + (re.test(text) ? ' (found ' + re + ')' : ''));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

// PC1 10.0.0.50/24 -- SW1 -- R1 10.0.0.1/24 (Gi0/0), 10.9.0.1/24 (Gi0/1) -- R2 -- 198.51.100.9/24
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const r2 = t.addDevice(ROUTER); r2.name = 'R2';
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  const pc = t.addDevice(PC); pc.name = 'PC1';
  t.connect(pc.id, 'eth0', sw.id, 'Fa0/1');
  t.connect(sw.id, 'Fa0/2', r1.id, 'Gi0/0');
  t.connect(r1.id, 'Gi0/1', r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  const mk = function (d) { const s = new CliSession(d, t, sim); s.run('enable'); return s; };
  const a = mk(r1), b = mk(r2), sp = mk(pc), s1 = mk(sw);
  const cfg = function (s, cmds) {
    s.run('configure terminal');
    const out = [];
    for (const c of cmds) out.push.apply(out, s.run(c).output);
    s.run('end');
    return out;
  };
  cfg(a, ['hostname R1', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.9.0.1 255.255.255.0', 'exit',
    'ip route 198.51.100.0 255.255.255.0 10.9.0.2']);
  cfg(b, ['hostname R2', 'interface Gi0/0', 'ip address 10.9.0.2 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 198.51.100.9 255.255.255.0', 'exit',
    'ip route 10.0.0.0 255.255.255.0 10.9.0.1']);
  cfg(sp, ['hostname PC1', 'interface eth0', 'ip address 10.0.0.50 255.255.255.0',
    'ip default-gateway 10.0.0.1', 'exit']);
  return { t: t, sim: sim, r1: r1, r2: r2, sw: sw, a: a, b: b, sp: sp, s1: s1, cfg: cfg };
}
function ifaceCfg(s, port, lines) {
  s.run('configure terminal');
  s.run('interface ' + port);
  const out = [];
  for (const l of lines) out.push.apply(out, s.run(l).output);
  s.run('end');
  return out;
}

console.log('\nThe MTU is a number this port will put on the wire, and it is enforced:');
{
  const env = lab();
  match(/100 percent \(1\/1\)/, env.sp.run('ping 198.51.100.9 count 1').output,
    'the ping works at the default MTU');
  const out = ifaceCfg(env.a, 'Gi0/0', ['mtu 100']);
  match(/MTU on Gi0\/0 set to 100 \(was 1500\)/, out, 'the MTU can be set, and the change is reported');
  match(/Frames larger than 100 bytes on this port will be dropped/, out,
    'and the consequence is stated, not left to be discovered');
  const ping = env.sp.run('ping 198.51.100.9 count 1').output;
  match(/0 percent \(0\/1\)/, ping, 'a 134-byte echo no longer crosses a 100-byte port');
  match(/1 frame of 134 bytes exceeds the 100-byte MTU on Gi0\/0/,
    env.a.run('show interfaces Gi0/0').output,
    'and the port accounts for the drop, with both sizes');
  const restored = ifaceCfg(env.a, 'Gi0/0', ['no mtu']);
  match(/MTU on Gi0\/0 back to 1500 \(was 100\)/, restored, '`no mtu` restores the default');
  match(/100 percent \(1\/1\)/, env.sp.run('ping 198.51.100.9 count 1').output,
    'and traffic flows again');
  match(/already the default 1500/, ifaceCfg(env.a, 'Gi0/0', ['no mtu']),
    'removing it twice says there is nothing to remove');
  // The limit is the number the operator typed, not a fixed size: lowering it to 120 refuses the
  // same 134-byte frame under a different reason, and each drop names its own number.
  ifaceCfg(env.a, 'Gi0/0', ['mtu 120']);
  env.sp.run('ping 198.51.100.9 count 1');
  match(/frame of 134 bytes exceeds the 120-byte MTU on Gi0\/0/,
    env.a.run('show interfaces Gi0/0').output, 'a second MTU names itself in the drop it causes');
  // ...and a jumbo MTU carries the very same frames.
  ifaceCfg(env.a, 'Gi0/0', ['mtu 9000']);
  match(/100 percent \(1\/1\)/, env.sp.run('ping 198.51.100.9 count 1').output,
    'a jumbo MTU carries the same frames without a drop');
}

console.log('\nThe speed feeds the spanning-tree cost, so it is not a label:');
{
  const env = lab();
  const before = env.s1.run('show spanning-tree').output;
  match(/Fa0\/2\s+designated\s+forwarding\s+20000/, before, 'a 1G port costs 20000');
  const out = ifaceCfg(env.s1, 'Fa0/2', ['speed 100']);
  match(/Speed on Fa0\/2 set to 100M \(was 1G\)/, out, 'the speed can be set');
  match(/Spanning-tree path cost from this port is now 200000/, out,
    'and the message says what the tree will do about it');
  match(/Fa0\/2\s+designated\s+forwarding\s+200000/, env.s1.run('show spanning-tree').output,
    'the tree cost follows the configured speed');
  eq(env.sw.interfaces.get('Fa0/2').speed, '100M', 'the port reports the new speed');
  const back = ifaceCfg(env.s1, 'Fa0/2', ['no speed']);
  match(/back to negotiation \(was 100M\)/, back, '`no speed` goes back to negotiation');
  match(/Fa0\/2\s+designated\s+forwarding\s+20000/, env.s1.run('show spanning-tree').output,
    'and the cost returns with it');
  match(/is already negotiated \(not configured\)/, ifaceCfg(env.s1, 'Fa0/2', ['no speed']),
    'removing it twice says it is already negotiating');
  // The port's own caps decide what it can be asked for, and the refusal lists them.
  match(/Gi0\/0 cannot run at 10000 Mbps - it supports 10, 100, 1000 Mbps/,
    ifaceCfg(env.a, 'Gi0/0', ['speed 10000']), 'a speed the hardware does not offer is refused, with the caps');
  match(/Speed must be a number of Mbps or "auto", not "fast"/,
    ifaceCfg(env.a, 'Gi0/0', ['speed fast']), 'a word that is not a speed is refused by name');
}

console.log('\nDuplex is stored, printed, and `half` is refused rather than faked:');
{
  const env = lab();
  const out = ifaceCfg(env.a, 'Gi0/0', ['duplex full']);
  match(/Duplex on Gi0\/0 set to full \(was full \(default\)\)/, out,
    'setting the value it already has by default still reports what happened');
  const half = ifaceCfg(env.a, 'Gi0/0', ['duplex half']);
  match(/% Half duplex is not modelled/, half, 'half duplex is refused');
  match(/no collision domain, no backoff/, half, 'and the refusal says what the model lacks');
  match(/would behave exactly like a full one while claiming/, half,
    'and why accepting the word would be a lie');
  match(/Duplex is full or auto, not "sideways"/, ifaceCfg(env.a, 'Gi0/0', ['duplex sideways']),
    'a word that is not a duplex is refused by name');
  // `auto` is a real value, and `no duplex` returns to the port's own default.
  ifaceCfg(env.a, 'Gi0/0', ['duplex auto']);
  eq(env.r1.interfaces.get('Gi0/0').duplex, 'auto', 'auto is stored as auto');
  const cleared = ifaceCfg(env.a, 'Gi0/0', ['no duplex']);
  match(/Duplex on Gi0\/0 back to full \(was auto\)/, cleared, 'and `no duplex` goes back to the default');
}

console.log('\nThe three settings are shown, and only the ones that were configured are dumped:');
{
  const env = lab();
  const plain = env.a.run('show interfaces Gi0/0').output;
  match(/MTU 1500 bytes \(default\), duplex full \(default\), speed 1G \(negotiated\)/, plain,
    'an untouched port says which values are defaults');
  ifaceCfg(env.a, 'Gi0/0', ['mtu 1400', 'speed 100', 'duplex auto']);
  const set = env.a.run('show interfaces Gi0/0').output;
  match(/MTU 1400 bytes \(configured\), duplex auto \(configured\), speed 100M \(configured\)/, set,
    'a configured port says so about each of the three');
  const dump = env.a.run('show running-config').output;
  match(/^ {2}mtu 1400$/m, dump, 'the dump carries the MTU it was given');
  match(/^ {2}speed 100$/m, dump, 'the speed in Mbps, the form the command takes');
  match(/^ {2}duplex auto$/m, dump, 'and the duplex');
  // Nothing is dumped for ports that were never touched.
  const otherPort = dump.join('\n').split('interface Gi0/1')[1] || '';
  noMatch(/mtu 1500|duplex full|speed 1G/, otherPort,
    'a port nobody configured contributes no lines');
  // Paste the dump into a twin and check the three values survive.
  const t2 = new Topology();
  const r9 = t2.addDevice(ROUTER); r9.name = 'R9';
  const s9 = new CliSession(r9, t2, new Simulator(t2));
  s9.run('enable'); s9.run('configure terminal');
  for (const line of dump.slice(1)) {
    // Ordinary control flow: the banner and the terminator are not commands to paste.
    if (/^!/.test(line) || /^end$/.test(line)) continue;
    s9.run(line);
  }
  s9.run('end');
  eq(r9.interfaces.get('Gi0/0').mtu, 1400, 'the MTU survives a paste');
  eq(r9.interfaces.get('Gi0/0').speedMbps, 100, 'the speed survives a paste');
  eq(r9.interfaces.get('Gi0/0').duplex, 'auto', 'and so does the duplex');
}

console.log('\n`?` offers all three, and the `no` forms too:');
{
  const env = lab();
  env.a.run('configure terminal');
  env.a.run('interface Gi0/0');
  for (const q of ['mtu ?', 'speed ?', 'duplex ?', 'no mtu ?', 'no speed ?', 'no duplex ?']) {
    const out = env.a.run(q).output;
    ok(!out.some(function (l) { return /% No completions/.test(l); }), '`' + q + '` answers');
  }
  match(/Next: <68-9216>/, env.a.run('mtu ?').output, '`mtu ?` names its range');
  match(/Next: auto, <mbps>/, env.a.run('speed ?').output, '`speed ?` names both its spellings');
  env.a.run('end');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
