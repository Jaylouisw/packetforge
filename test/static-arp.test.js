'use strict';
// static-arp.test.js - an entry in the cache that the lab cannot relearn.
//
// Measured before this pass, on a router whose cache is real and read by every routed packet:
//   R1(config)#arp 10.0.0.50 0200.0000.0100 arpa
//   % Unrecognized config command: arp 10.0.0.50 0200.0000.0100 arpa
//
// The cache could only ever be filled by learning (the commit before this one added `clear arp` to
// empty it), so there was no way to say "this address is at that MAC, and that is the end of it" -
// which is both the shortcut every operator uses and the only ARP defence a device has.
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
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 700)) + ')'));
}
function noMatch(re, haystack, msg) {
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(!re.test(text), msg + (re.test(text) ? ' (found ' + re + ')' : ''));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

// PC1 10.0.0.50 on Gi0/0, PC2 10.0.0.60 on Gi0/1 - two hosts so a reply can come from the wrong one.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const pc1 = t.addDevice(PC); pc1.name = 'PC1';
  const pc2 = t.addDevice(PC); pc2.name = 'PC2';
  t.connect(pc1.id, 'eth0', r1.id, 'Gi0/0');
  t.connect(pc2.id, 'eth0', r1.id, 'Gi0/1');
  const sim = new Simulator(t);
  const mk = function (d) { const s = new CliSession(d, t, sim); s.run('enable'); return s; };
  const a = mk(r1), s1 = mk(pc1), s2 = mk(pc2);
  const cfg = function (s, cmds) {
    s.run('configure terminal');
    const out = [];
    for (const c of cmds) out.push.apply(out, s.run(c).output);
    s.run('end');
    return out;
  };
  cfg(s1, ['hostname PC1', 'interface eth0', 'ip address 10.0.0.50 255.255.255.0', 'exit']);
  // PC2 sits in Gi0/1's subnet (10.0.1.0/24), so a ping to it really is answered by it: a host in
  // the other subnet would answer no ARP and teach nothing.
  cfg(s2, ['hostname PC2', 'interface eth0', 'ip address 10.0.1.60 255.255.255.0', 'exit']);
  cfg(a, ['hostname R1',
    'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.1.1 255.255.255.0', 'exit']);
  const mac1 = pc1.interfaces.get('eth0').mac;
  const mac2 = pc2.interfaces.get('eth0').mac;
  return { t: t, sim: sim, r1: r1, pc1: pc1, pc2: pc2, a: a, s1: s1, s2: s2, cfg: cfg,
    mac1: mac1, mac2: mac2 };
}
// 02:00:00:00:01:00 -> 0200.0000.0100, the spelling IOS takes on the command line.
function dotted(mac) { return mac.replace(/:/g, '').replace(/(.{4})(?!$)/g, '$1.'); }
function types(sim, from) {
  return (sim.events || []).slice(from).map(function (e) { return e.type; });
}

console.log('\nA static entry is written, normalised and reported:');
{
  const env = lab();
  const out = env.cfg(env.a, ['arp 10.0.0.50 ' + dotted(env.mac1) + ' arpa']);
  match(/Static ARP entry on R1: 10\.0\.0\.50 is at 02:00:00:00:01:00/, out,
    'the confirmation says the address and the MAC it will reach');
  match(/never ages out and a reply cannot overwrite it/, out, 'and what makes it static');
  match(/"no arp 10\.0\.0\.50" removes it/, out, 'and how to undo it');
  eq(env.r1.arpStatic.get('10.0.0.50'), env.mac1, 'the entry is stored');
  // Both spellings are the same address, and the third word is optional.
  const colon = env.cfg(env.a, ['arp 10.0.0.60 ' + env.mac2]);
  match(/10\.0\.0\.60 is at 02:00:00:00:02:00/, colon, 'a colon-separated MAC is accepted without "arpa"');
  eq(env.r1.arpStatic.get('10.0.0.60'), env.mac2, 'and stored in one form');
  match(/is already 02:00:00:00:02:00 on R1/, env.cfg(env.a, ['arp 10.0.0.60 ' + env.mac2]),
    'writing the same entry twice says it is already there');
}

console.log('\nThe entry is used: no ARP request is sent, and the frame goes to that MAC:');
{
  const env = lab();
  env.cfg(env.a, ['arp 10.0.0.50 ' + dotted(env.mac1)]);
  const from = (env.sim.events || []).length;
  const out = env.a.run('ping 10.0.0.50 count 1').output;
  const seen = types(env.sim, from);
  match(/Success rate is 100 percent \(1\/1\)/, out, 'the ping is answered');
  ok(seen.indexOf('arp-request') === -1, 'and no ARP request was ever sent');
  ok(seen.indexOf('arp-cache') === -1, 'and nothing was learned');
  const fwd = (env.sim.events || []).slice(from).filter(function (e) { return e.type === 'forward'; })[0];
  ok(!!fwd, 'the frame is forwarded');
  eq(fwd && fwd.via, 'arp-static', 'the timeline says the static table answered, not the cache');
  eq(env.r1.arp.size, 0, 'the learned table is still empty');
  // A wrong entry is used as written - which is the whole reason it must be right.
  const env2 = lab();
  env2.cfg(env2.a, ['arp 10.0.0.50 ' + dotted(env2.mac2)]);
  match(/Success rate is 0 percent \(0\/1\)/, env2.a.run('ping 10.0.0.50 count 1').output,
    'a static entry pointing at the wrong MAC sends the traffic there and nowhere else');
}

console.log('\nA reply cannot overwrite it - this is the defence, not a preference:');
{
  const env = lab();
  env.cfg(env.a, ['arp 10.0.0.50 ' + dotted(env.mac1)]);
  const from = (env.sim.events || []).length;
  // PC2 answers for PC1's address: the same frame a spoofed reply arrives in, on the same door the
  // data path uses.
  env.sim._handleArp(env.r1, {
    etherType: 0x0806, srcMac: env.mac2, dstMac: env.r1.interfaces.get('Gi0/1').mac, vid: 1,
    arp: { op: 'reply', senderMac: env.mac2, senderIp: '10.0.0.50',
      targetMac: env.r1.interfaces.get('Gi0/1').mac, targetIp: '10.0.1.1' }
  }, 'Gi0/1');
  eq(env.r1.arpStatic.get('10.0.0.50'), env.mac1, 'the static entry is unchanged');
  eq(env.r1.arp.size, 0, 'and the impostor was not learned as well');
  const ev = (env.sim.events || []).slice(from);
  const hold = ev.filter(function (e) { return e.type === 'arp-static-hold'; })[0];
  ok(!!hold, 'the refused reply is on the timeline');
  eq(hold && hold.offered, env.mac2, 'naming the MAC that offered itself');
  eq(hold && hold.kept, env.mac1, 'and the MAC that was kept');
  match(/Success rate is 100 percent \(1\/1\)/, env.a.run('ping 10.0.0.50 count 1').output,
    'and traffic still goes to the configured host');
  // Without a static entry the same reply is learned, so the test above is about the entry.
  const env2 = lab();
  env2.sim._handleArp(env2.r1, {
    etherType: 0x0806, srcMac: env2.mac2, dstMac: env2.r1.interfaces.get('Gi0/1').mac, vid: 1,
    arp: { op: 'reply', senderMac: env2.mac2, senderIp: '10.0.0.50',
      targetMac: env2.r1.interfaces.get('Gi0/1').mac, targetIp: '10.0.1.1' }
  }, 'Gi0/1');
  eq(env2.r1.arp.get('10.0.0.50'), env2.mac2, 'without the entry, the same reply is believed');
}

console.log('\nThe table says which rows cannot be emptied:');
{
  const env = lab();
  env.cfg(env.a, ['arp 10.0.0.50 ' + dotted(env.mac1)]);
  env.a.run('ping 10.0.1.60 count 1');
  const table = env.a.run('show arp').output;
  match(/Internet\s+10\.0\.0\.50\s+-\s+02:00:00:00:01:00\s+Gi0\/0\s+STATIC/, table,
    'the static row is marked and its age is "-"');
  match(/Internet\s+10\.0\.1\.60\s+-\s+02:00:00:00:02:00\s+Gi0\/1/, table, 'the learned row is not');
  noMatch(/10\.0\.1\.60.*STATIC/, table, 'and carries no marker');
  match(/1 static entry is hand-written: they never age out, a reply cannot overwrite them, and "clear arp" leaves them/,
    table, 'and the table explains the word below it');
  match(/Type\s*$|Type/, env.a.run('show ip arp 10.0.0.50').output,
    'one address is answered with a Type column');
  match(/STATIC/, env.a.run('show ip arp 10.0.0.50').output, 'that says STATIC');
}

console.log('\n`clear arp` empties what was learned and leaves what was written:');
{
  const env = lab();
  env.cfg(env.a, ['arp 10.0.0.50 ' + dotted(env.mac1)]);
  env.a.run('ping 10.0.1.60 count 1');
  const out = env.a.run('clear arp').output;
  match(/ARP cache cleared on R1 \(1 entry\)/, out, 'the learned entry is reported cleared');
  match(/1 static entry kept - they are configured, not learned \(remove with "no arp <ip>"\)/, out,
    'and the static entry is reported kept, with the command that removes it');
  eq(env.r1.arp.size, 0, 'the learned table is empty');
  eq(env.r1.arpStatic.get('10.0.0.50'), env.mac1, 'the static entry is still there');
  match(/STATIC/, env.a.run('show arp').output, 'and still in the table');
  // With only a static entry the cache is "already empty", which is the honest answer.
  match(/was already empty - nothing to clear/, env.a.run('clear arp').output,
    'clearing again says the cache was already empty');
  match(/1 static entry kept/, env.a.run('clear arp').output, 'and still reports what it kept');
}

console.log('\n`no arp` removes one entry and says what it was:');
{
  const env = lab();
  env.cfg(env.a, ['arp 10.0.0.50 ' + dotted(env.mac1)]);
  const out = env.cfg(env.a, ['no arp 10.0.0.50']);
  match(/ARP entry for 10\.0\.0\.50 removed from R1 \(it was static: 02:00:00:00:01:00\)/, out,
    'a static entry is named as static when removed');
  match(/The next packet to 10\.0\.0\.50 asks for it again/, out, 'and the consequence is stated');
  eq(env.r1.arpStatic.size, 0, 'and it is gone');
  env.a.run('ping 10.0.1.60 count 1');
  match(/\(it was learned: 02:00:00:00:02:00\)/, env.cfg(env.a, ['no arp 10.0.1.60']),
    'a learned entry can be removed by the same command');
  match(/% No ARP entry for 10\.0\.0\.77 on R1/, env.cfg(env.a, ['no arp 10.0.0.77']),
    'removing an entry that is not there says so');
  match(/The cache holds 0 addresses/, env.cfg(env.a, ['no arp 10.0.0.77']),
    'and how many there are');
}

console.log('\nWrong words are refused where they are typed:');
{
  const env = lab();
  for (const [line, why] of [
    ['arp 10.0.0.9 0011.2233', 'a MAC needs twelve hex digits'],
    ['arp 10.0.0.9 zz:11:22:33:44:55', 'a MAC is hex'],
    ['arp abc ' + dotted(env.mac1), 'the address is not an address'],
    ['arp 10.0.0.9', 'the MAC is required'],
    ['arp', 'the address is required'],
    ['no arp', 'the address is required'],
    ['no arp abc', 'the address is not an address']
  ]) {
    const out = env.cfg(env.a, [line]).join('\n');
    ok(/^(\%|Static ARP entry)/.test(out) && /%/.test(out),
      '"' + line + '" is refused (' + why + ')');
  }
  // Two MACs nothing can be reached at.
  match(/The all-zero MAC is not an address anything can be reached at/,
    env.cfg(env.a, ['arp 10.0.0.9 0000.0000.0000']), 'the all-zero MAC is refused');
  match(/01:00:5e:00:00:01 is a multicast or broadcast MAC, so no single host owns it/,
    env.cfg(env.a, ['arp 10.0.0.9 0100.5e00.0001']), 'a multicast MAC is refused by name');
  match(/A static ARP entry points at one device: use its unicast address/,
    env.cfg(env.a, ['arp 10.0.0.9 0100.5e00.0001']), 'and the reason is the one that applies');
  match(/0\.0\.0\.0 is not a host address/,
    env.cfg(env.a, ['arp 0.0.0.0 ' + dotted(env.mac1)]), 'the unspecified address is refused');
  // The optional word is optional, not a slot for anything.
  match(/Unexpected argument "extra" - arp <ip> <mac> \[arpa\] takes no more/,
    env.cfg(env.a, ['arp 10.0.0.9 ' + dotted(env.mac1) + ' arpa extra']), 'a fourth word is refused');
  match(/The only word that can follow the MAC is "arpa"/,
    env.cfg(env.a, ['arp 10.0.0.9 ' + dotted(env.mac1) + ' ether']), 'a different encapsulation is refused');
  eq(env.r1.arpStatic.size, 0, 'and nothing was stored by any of them');
}

console.log('\nThe entry is configuration, so it dumps and pastes:');
{
  const env = lab();
  env.cfg(env.a, ['arp 10.0.0.50 ' + dotted(env.mac1) + ' arpa']);
  env.a.run('ping 10.0.1.60 count 1');
  const dump = env.a.run('show running-config').output;
  match(/^arp 10\.0\.0\.50 0200\.0000\.0100 arpa$/m, dump,
    'the static entry is dumped in the spelling the console accepts');
  noMatch(/^arp 10\.0\.1\.60/m, dump, 'a learned entry is not configuration and is not dumped');
  const t2 = new Topology();
  const twin = t2.addDevice(ROUTER);
  const s2 = new CliSession(twin, t2, new Simulator(t2));
  s2.run('enable'); s2.run('configure terminal');
  for (const line of dump.slice(1)) {
    // Ordinary control flow, not an exemption: the banner and the terminator are not commands.
    if (/^!/.test(line) || /^end$/.test(line)) continue;
    s2.run(line);
  }
  s2.run('end');
  eq(twin.arpStatic.get('10.0.0.50'), env.mac1, 'and the pasted config restores the same entry');
  eq(twin.arp.size, 0, 'while the learned entry stays unlearned');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
