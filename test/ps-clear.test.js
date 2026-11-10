'use strict';
// ps-clear.test.js - the three things a secured port can forget, and the word that does it.
//
// Measured before this pass, on the port-security model committed one iteration earlier:
//   SW1#clear port-security counters
//   % Unrecognized command: clear port-security counters
//
// The recovery message printed by `no shutdown` sent the operator to exactly that command, so the
// console was pointing at a command it did not have. Three things can be cleared and they are three
// different things - the evidence, what was learned, what was pinned - and clearing one must not clear
// another, or "clear the counters" would silently unsecure the port.
//
// Two smaller defects found in the same sweep and fixed here: `show port-security address` printed a
// constant VLAN of 1 for every row, and `vlan 20 name users` created a VLAN called "name users".
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
// A session's answer is { output: [...] }; unwrap it here so every assertion reads the same whether
// it was handed the result of run() or the lines themselves.
function match(re, haystack, msg) {
  if (haystack && Array.isArray(haystack.output)) haystack = haystack.output;
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 800)) + ')'));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });
const INTRUDER = '02:00:00:00:99:99';

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
    return cfg(a, ['interface ' + ports[0], 'switchport mode access'].concat(cmds));
  };
  const speak = function (port, mac) {
    const frame = { etherType: 0x0806, srcMac: mac, dstMac: 'ff:ff:ff:ff:ff:ff',
      arp: { op: 'request', senderMac: mac, senderIp: '10.0.0.9',
        targetMac: '00:00:00:00:00:00', targetIp: '10.0.0.254' } };
    const from = (sim.events || []).length;
    sim._processFrame(sw, frame, port);
    return (sim.events || []).slice(from).map(function (e) { return e.type; });
  };
  return { t: t, sim: sim, sw: sw, pc: pc, a: a, s1: s1, cfg: cfg, secure: secure, speak: speak,
    port: ports[0], ports: ports, mac1: pc.interfaces.get('eth0').mac };
}

console.log('\nThe command the console itself recommends exists, and clears only the evidence:');
{
  const env = lab();
  env.secure(['switchport port-security']);
  env.speak(env.port, env.mac1);
  env.speak(env.port, INTRUDER);
  // The port is err-disabled; recovering it prints the recommendation under test.
  const recovered = env.secure(['no shutdown']);
  match(/Security violation count kept at 1 - "clear port-security counters" resets it/, recovered,
    'recovering the port recommends `clear port-security counters`');
  const out = env.a.run('clear port-security counters');
  match(/Security violation counters cleared on SW1 \(1\)/, out, 'and that command answers');
  match(/was Fa0\/1 \(1\)/, out, 'naming the port and the count it cleared');
  match(/The ports stay as they are: a count of what happened, not the state it left behind/, out,
    'and saying what it did not touch');
  match(/Security Violation Count\s+: 0/, env.a.run('show port-security interface Fa0/1').output,
    'the count is zero');
  // The address the port holds is still there: a counter is not a table.
  eq(env.sw.portSecurity.ports[env.port].allowed, undefined, 'the port object keeps its shape');
  eq(env.sw.portSecurity.ports[env.port].dynamic.length, 1, 'the learned address survives a counter clear');
  match(/Security violation counters on SW1 were already zero - nothing to clear/,
    env.a.run('clear port-security counters').output, 'clearing twice says there is nothing to clear');
  // Clearing counters must not recover an err-disabled port: the two are different decisions.
  const env2 = lab();
  env2.secure(['switchport port-security']);
  env2.speak(env2.port, env2.mac1);
  env2.speak(env2.port, INTRUDER);
  env2.a.run('clear port-security counters');
  match(/Port Status\s+: Secure-shutdown/, env2.a.run('show port-security interface Fa0/1').output,
    'clearing counters does not bring an err-disabled port back');
}

console.log('\n`dynamic` forgets what was learned and keeps what was written:');
{
  const env = lab();
  env.secure(['switchport port-security', 'switchport port-security maximum 3',
    'switchport port-security mac-address 0200.0000.0abc']);
  env.speak(env.port, env.mac1);
  let counts = env.a.run('show port-security interface Fa0/1').output;
  match(/Configured MAC Addresses\s+: 1/, counts, 'one configured address');
  match(/Total MAC Addresses\s+: 2/, counts, 'plus one learned');
  const out = env.a.run('clear port-security dynamic');
  match(/Learned secure addresses cleared on SW1 \(1\)/, out, 'the learned address is cleared');
  match(/Configured and sticky addresses are kept: they were not learned/, out, 'and the answer says why');
  counts = env.a.run('show port-security interface Fa0/1').output;
  match(/Configured MAC Addresses\s+: 1/, counts, 'the configured address is still there');
  match(/Total MAC Addresses\s+: 1/, counts, 'and the learned one is not');
  // The station now has to be learned again, and learning it is visible.
  const again = env.speak(env.port, env.mac1);
  ok(again.indexOf('port-security-learn') !== -1, 'the same station is learned again after the clear');
  match(/Total MAC Addresses\s+: 2/, env.a.run('show port-security interface Fa0/1').output,
    'and the port is back to two addresses');
}

console.log('\n`sticky` unpins what was pinned, and the next station may be a different one:');
{
  const env = lab();
  env.secure(['switchport port-security', 'switchport port-security mac-address sticky']);
  env.speak(env.port, env.mac1);
  match(/Sticky MAC Addresses\s+: 1/, env.a.run('show port-security interface Fa0/1').output,
    'the station is pinned as it is learned');
  const out = env.a.run('clear port-security sticky');
  match(/Sticky secure addresses cleared on SW1 \(1\)/, out, 'the sticky addresses are cleared');
  match(/The stations must be learned again, and the next one may be a different station/, out,
    'and the consequence is stated - that is what unpinning means');
  match(/Sticky MAC Addresses\s+: 0/, env.a.run('show port-security interface Fa0/1').output,
    'the sticky count is zero');
  // With nothing pinned, a different station takes the free slot - the port is not stuck on the old MAC.
  const intr = env.speak(env.port, INTRUDER);
  ok(intr.indexOf('port-security-learn') !== -1, 'a different station can now be learned');
  match(/02:00:00:00:99:99\s+1\s+Fa0\/1\s+SecureSticky/, env.a.run('show port-security address').output,
    'and it is sticky in turn');
  match(/No sticky secure addresses on SW1 - nothing to clear/, (function () {
    env.a.run('clear port-security sticky');
    return env.a.run('clear port-security sticky').output;
  })(), 'clearing twice says there is nothing to clear');
}

console.log('\nOne port at a time, and a port with nothing secured is refused:');
{
  const env = lab();
  env.secure(['switchport port-security']);
  env.cfg(env.a, ['interface ' + env.ports[1], 'switchport mode access',
    'switchport port-security', 'switchport port-security maximum 2']);
  env.speak(env.port, env.mac1);
  env.speak(env.ports[1], INTRUDER);
  const out = env.a.run('clear port-security dynamic interface ' + env.port);
  match(/Learned secure addresses cleared on Fa0\/1 \(1\)/, out, 'the named port is cleared');
  match(/Fa0\/2\s+2\s+1\s+0/, env.a.run('show port-security').output,
    'and the other port still holds its address');
  const refused = env.a.run('clear port-security counters interface ' + env.ports[2]);
  match(/Port security is not enabled on Fa0\/3/, refused, 'a port that is not secured is refused');
  match(/% Secured ports: Fa0\/1, Fa0\/2/, refused, 'and the answer lists the ports that are');
  // Two ports is a typo, not a filter.
  match(/takes one port, not "Fa0\/1 Fa0\/2"/,
    env.a.run('clear port-security counters Fa0/1 Fa0/2').output, 'two ports are refused');
}

console.log('\nThe word is checked, and the command is not available where it does not belong:');
{
  const env = lab();
  env.secure(['switchport port-security']);
  match(/% Incomplete command: clear port-security \{counters\|dynamic\|sticky\} \[interface <port>\]/,
    env.a.run('clear port-security').output, 'a bare command quotes the synopsis');
  match(/% counters reset the violation evidence, dynamic forgets what was learned, sticky unpins what was pinned/,
    env.a.run('clear port-security').output, 'and says what the three words do');
  match(/% "bogus" is not something clear port-security can clear/, env.a.run('clear port-security bogus').output,
    'a word that is not one of the three is refused by name');
  // From exec, before `enable`, the refusal names the mode it needs - and it says the same thing
  // `clear arp` says, because they are the same kind of command.
  const fresh = new Topology();
  const sw2 = fresh.addDevice(SWITCH); sw2.name = 'SW1';
  const exec = new CliSession(sw2, fresh, new Simulator(fresh));
  match(/clear port-security needs enable mode - type "enable" first/,
    exec.run('clear port-security counters').output, 'from exec it asks for enable mode');
  match(/clear arp needs enable mode/, exec.run('clear arp').output, 'exactly as `clear arp` does');
  // In config mode it is not a config command at all, which is also what `clear arp` says there.
  // The wording moved when configuration mode stopped calling real exec verbs "unrecognized": the
  // assertion follows the message, and checks the pair still answer *identically*.
  exec.run('enable'); exec.run('configure terminal');
  match(/is an exec command, not a configuration command/,
    exec.run('clear port-security counters').output,
    'config mode names an exec command instead of calling it a typo');
  match(/is an exec command, not a configuration command/, exec.run('clear arp').output,
    'and the two clear commands behave identically in the wrong mode');
}

console.log('\nA secure address is in the port\'s VLAN, not in VLAN 1:');
{
  const env = lab();
  env.cfg(env.a, ['vlan 20 name users']);
  env.secure(['switchport port-security']);
  env.cfg(env.a, ['interface ' + env.port, 'switchport access vlan 20']);
  env.speak(env.port, env.mac1);
  const addr = env.a.run('show port-security address').output.join('\n');
  match(/02:00:00:00:01:00\s+20\s+Fa0\/1\s+SecureDynamic/, addr,
    'the VLAN column is the port\'s own VLAN, not a constant');
  // VLAN 1 still prints 1, so the fix is a fact read from the port and not a different constant.
  const env2 = lab();
  env2.secure(['switchport port-security']);
  env2.speak(env2.port, env2.mac1);
  match(/02:00:00:00:01:00\s+1\s+Fa0\/1\s+SecureDynamic/, env2.a.run('show port-security address').output,
    'a port in VLAN 1 prints 1');
}

console.log('\n`vlan 20 name users` names the VLAN `users`, and the table lists it:');
{
  const env = lab();
  match(/VLAN 20 created \(name: users\)/, env.cfg(env.a, ['vlan 20 name users']),
    'the IOS spelling is understood: `name` is a keyword, not part of the name');
  eq(env.sw.config.vlans[20].name, 'users', 'and the VLAN is called users');
  match(/VLAN 21 created \(name: sales\)/, env.cfg(env.a, ['vlan 21 sales']),
    'the short spelling still works');
  match(/VLAN 22 created \(name: VLAN0022\)/, env.cfg(env.a, ['vlan 22']),
    'and a VLAN with no name gets the default one');
  // A declared VLAN with no ports is a VLAN the switch holds.
  const table = env.a.run('show vlan').output;
  match(/^20\s+users\s+active\s+\(no ports\)$/m, table,
    'a declared VLAN with no ports is listed, not hidden');
  match(/^21\s+sales\s+active\s+\(no ports\)$/m, table, 'and so is the next one');
  // The table and the single-VLAN view agree about it, which they did not before.
  match(/^20\s+users\s+active\s+\(no ports\)$/m, env.a.run('show vlan 20').output,
    'and `show vlan 20` agrees with the table');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
