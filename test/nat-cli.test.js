'use strict';
// nat-cli.test.js - NAT was fully modelled and completely unconfigurable.
//
// Measured before this pass, on a router with two routed ports:
//   R1(config)#ip nat inside source static 10.0.0.50 203.0.113.50
//   % Unrecognized config command: ip nat inside source static 10.0.0.50 203.0.113.50
//   R1(config-if)#ip nat inside
//   % Unrecognized interface command: ip nat inside
//   R1#show ip nat translations
//   NAT translations on R1:
//     (none - no NAT rules; NAT is configured from the topology)
//
// engine/nat.js has modelled rules, translations, timeouts and both directions all along; only the
// topology could reach it. And even a lab built that way could never show a translation for the
// commonest test of all - an ICMP echo - because `_natOutbound` required a `frame.l4` and an echo
// carries `frame.icmp`, so ping crossed the NAT box untouched.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
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

// PC1 10.0.0.50/24 -- SW1 -- R1 Gi0/0 10.0.0.1/24 (inside)
//                          R1 Gi0/1 203.0.113.2/24 (outside) -- R2 -- 198.51.100.9/24
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
  const a = mk(r1), b = mk(r2), sp = mk(pc);
  const cfg = function (s, cmds) {
    s.run('configure terminal');
    const out = [];
    for (const c of cmds) out.push.apply(out, s.run(c).output);
    s.run('end');
    return out;
  };
  cfg(a, ['hostname R1', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 203.0.113.2 255.255.255.0', 'exit',
    'ip route 0.0.0.0 0.0.0.0 203.0.113.254']);
  cfg(b, ['hostname R2', 'interface Gi0/0', 'ip address 203.0.113.254 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 198.51.100.9 255.255.255.0', 'exit']);
  cfg(sp, ['hostname PC1', 'interface eth0', 'ip address 10.0.0.50 255.255.255.0',
    'ip default-gateway 10.0.0.1', 'exit']);
  return { t: t, sim: sim, r1: r1, r2: r2, a: a, b: b, sp: sp, cfg: cfg };
}
function patRules(env) {
  return env.cfg(env.a, ['access-list 1 permit 10.0.0.0 0.0.0.255',
    'interface Gi0/0', 'ip nat inside', 'exit',
    'interface Gi0/1', 'ip nat outside', 'exit',
    'ip nat inside source list 1 interface Gi0/1 overload']);
}

console.log('\nThe console writes the rule, and the port says which side it is on:');
{
  const env = lab();
  const out = patRules(env);
  noMatch(/^%/, out, 'no line of the configuration was refused');
  match(/Interface Gi0\/0 is NAT inside/, out, 'the inside port says so');
  match(/Interface Gi0\/1 is NAT outside/, out, 'and so does the outside one');
  match(/NAT rule added on R1: pat list 1 -> Gi0\/1 \(203\.0\.113\.2\) overload/, out,
    'the rule is confirmed in the words it was typed in');
  // Marking the inside port first warns that the outside one is missing - true at that moment -
  // and marking the outside port afterwards must stop it.
  const afterOutside = out.slice(out.findIndex(function (l) { return /is NAT outside/.test(l); }));
  noMatch(/no port is (inside|outside) yet/, afterOutside,
    'and no warning about a missing side once both are marked');
  eq(env.r1.config.nat.rules.length, 1, 'one rule is stored');
  eq(env.r1.config.nat.rules[0].insideGlobal, '203.0.113.2',
    'with the interface address as the global, not a guessed one');
}

console.log('\nA ping across the box now shows a translation - it never did:');
{
  const env = lab();
  patRules(env);
  const ping = env.sp.run('ping 198.51.100.9 count 1').output;
  match(/Success rate is 100 percent \(1\/1\)/, ping, 'the ping still succeeds');
  const tr = env.a.run('show ip nat translations').output;
  match(/^NAT translations on R1:/m, tr, 'the table is headed by the device');
  match(/icmp\s+203\.0\.113\.2:\d+\s+10\.0\.0\.50:4096\s+198\.51\.100\.9:4096\s+198\.51\.100\.9:4096\s+pat/,
    tr, 'and holds the ICMP flow, translated to the outside address');
  match(/Pro\s+Inside global\s+Inside local\s+Outside local\s+Outside global\s+Type/, tr,
    'in the columns an operator reads');
  const stats = env.a.run('show ip nat statistics').output.join('\n');
  match(/hits\s+[1-9]/, stats, 'the statistics counted the translation');
  noMatch(/configured from the topology/, stats, 'and no longer sends the operator to the topology');
}

console.log('\nA rule written after traffic still takes effect:');
{
  const env = lab();
  // First a ping with no rule at all, so the translation table has been built once and cached.
  env.sp.run('ping 198.51.100.9 count 1');
  eq(env.r1.natTable ? (env.r1.natTable.translations || []).length : 0, 0,
    'nothing was translated before the rule existed');
  patRules(env);
  env.sp.run('ping 198.51.100.9 count 1');
  match(/pat/, env.a.run('show ip nat translations').output,
    'the rule written afterwards is honoured (the cached table was dropped, not kept)');
}

console.log('\nStatic translation, both directions:');
{
  const env = lab();
  const out = env.cfg(env.a, ['ip nat inside source static 10.0.0.50 203.0.113.50',
    'interface Gi0/0', 'ip nat inside', 'exit', 'interface Gi0/1', 'ip nat outside', 'exit']);
  match(/NAT rule added on R1: static 10\.0\.0\.50 -> 203\.0\.113\.50/, out,
    'a static rule is accepted');
  eq(env.r1.config.nat.rules[0].type, 'static', 'and stored as a static rule');
  const ping = env.sp.run('ping 198.51.100.9 count 1').output;
  match(/100 percent \(1\/1\)/, ping, 'traffic from the mapped host still crosses');
  match(/203\.0\.113\.50/, env.a.run('show ip nat translations').output,
    'and it leaves as the static global address, not the interface address');
}

console.log('\nEvery wrong word is refused where it is typed:');
{
  const env = lab();
  const before = env.r1.config.nat ? (env.r1.config.nat.rules || []).length : 0;
  const r = function (cmds) { return env.cfg(env.a, cmds); };
  match(/% Access list 99 does not exist/, r(['ip nat inside source list 99 interface Gi0/1 overload']),
    'a list that does not exist is named');
  match(/% Configured lists: \(none\)/, r(['ip nat inside source list 99 interface Gi0/1 overload']),
    'with the lists that do');
  match(/% No interface Gi0\/9 on R1/, r(['access-list 1 permit 10.0.0.0 0.0.0.255',
    'ip nat inside source list 1 interface Gi0/9 overload']), 'an interface that does not exist is named');
  match(/% Ports here: Gi0\/0, Gi0\/1/, r(['ip nat inside source list 1 interface Gi0/9 overload']),
    'with the ports that do');
  match(/% Incomplete command: ip nat inside source static <local> <global>/,
    r(['ip nat inside source static 10.0.0.50']), 'a half-typed static rule quotes the shape');
  match(/% Unexpected argument "extra"/, r(['ip nat inside source static 10.0.0.50 203.0.113.50 extra']),
    'a word after the global address is refused');
  match(/% This model translates inside source addresses/, r(['ip nat outside source static 1.1.1.1 2.2.2.2']),
    'an outside-source rule is refused by naming what the model has');
  match(/% ip nat inside source takes static or list, not "pool"/, r(['ip nat inside source pool 1']),
    'nor a pool form it does not have');
  // The inside port is not where "overload" points, and a rule pointing at it would be silently useless.
  match(/% Gi0\/0 is the inside port/, r(['access-list 1 permit 10.0.0.0 0.0.0.255',
    'interface Gi0/0', 'ip nat inside', 'exit',
    'ip nat inside source list 1 interface Gi0/0 overload']),
    'overloading onto the inside port is refused, with why');
  // An address keeps a rule from being written against an interface that has none.
  match(/% Gi0\/2 has no address/, r(['access-list 1 permit 10.0.0.0 0.0.0.255',
    'ip nat inside source list 1 interface Gi0/2 overload']),
    'a port with no address cannot be the overload target');
  // Duplicates are reported, not stacked.
  r(['ip nat inside source static 10.0.0.50 203.0.113.50']);
  match(/This rule is already configured/, r(['ip nat inside source static 10.0.0.50 203.0.113.50']),
    'the same rule twice is reported, not added twice');
  // And a rule with no sides is accepted but flagged, because it will match nothing.
  const lone = (function () {
    const e2 = lab();
    return e2.cfg(e2.a, ['ip nat inside source static 10.0.0.50 203.0.113.50']);
  })();
  match(/a rule needs one interface inside and one outside/, lone,
    'a rule with no sides says it will match nothing');
  eq(env.r1.config.nat.rules.length, before + 1, 'only the one good rule was stored');
}

console.log('\nInterface roles are per port, movable, and removable:');
{
  const env = lab();
  const out = env.cfg(env.a, ['interface Gi0/0', 'ip nat inside', 'exit']);
  match(/interface Gi0\/1 is outside yet/.source ? /no port is outside yet/ : /no port is outside yet/, out,
    'marking only the inside port says the outside one is missing');
  match(/Interface Gi0\/0 is already NAT inside/,
    env.cfg(env.a, ['interface Gi0/0', 'ip nat inside', 'exit']),
    're-marking the same side says so instead of pretending');
  const moved = env.cfg(env.a, ['interface Gi0/0', 'ip nat outside', 'exit']);
  match(/Interface Gi0\/0 is NAT outside/, moved, 'a port can move sides');
  match(/was inside - a port is on one side at a time/, moved, 'and the change is reported with what it was');
  const wrong = env.cfg(env.a, ['interface Gi0/0', 'no ip nat inside', 'exit']);
  match(/Interface Gi0\/0 is NAT outside, not inside/, wrong,
    'removing a side it does not have says which it does have');
  const removed = env.cfg(env.a, ['interface Gi0/0', 'no ip nat outside', 'exit']);
  match(/Interface Gi0\/0 is no longer NAT outside/, removed, 'and the side it has can be removed');
  eq(env.r1.interfaces.get('Gi0/0').natRole, undefined, 'the flag is gone from the port');
  match(/% Unexpected argument "inside" - ip nat inside\|outside takes no more/,
    env.cfg(env.a, ['interface Gi0/1', 'ip nat outside inside', 'exit']),
    'a port cannot be put on both sides at once');
  match(/% A NAT interface is inside or outside, not "sideways"/,
    env.cfg(env.a, ['interface Gi0/1', 'ip nat sideways', 'exit']),
    'and neither can a word that is not a side');
  // A switch has no routed interfaces to translate between.
  match(/does not route - NAT rewrites addresses between two/,
    (function () {
      const t = new Topology();
      const sw = t.addDevice(SWITCH); sw.name = 'SW9';
      const s = new CliSession(sw, t, new Simulator(t));
      s.run('enable'); s.run('configure terminal'); s.run('interface Fa0/1');
      return s.run('ip nat inside').output;
    })(), 'a switch is refused, with why');
}

console.log('\nThe roles are enforced, not decoration:');
{
  const env = lab();
  // Rules only, no roles: the topology-built lab keeps working (this is how every NAT lab in the
  // suite is built), so nothing is required that a lab did not already provide.
  env.r1.config.nat = { rules: [{ type: 'pat', insideLocal: 'any', insideGlobal: '203.0.113.2', acl: ['10.0.0.0/24'] }] };
  env.r1.natTable = null;
  env.sp.run('ping 198.51.100.9 count 1');
  match(/pat/, env.a.run('show ip nat translations').output,
    'with no port marked, rules alone still translate (topology-built labs)');
  // Now mark the far port inside-only: nothing may leave translated by it.
  const env2 = lab();
  patRules(env2);
  env2.cfg(env2.a, ['interface Gi0/1', 'no ip nat outside', 'ip nat inside', 'exit']);
  env2.sp.run('ping 198.51.100.9 count 1');
  match(/\(none/, env2.a.run('show ip nat translations').output,
    'with the outside port unmarked, traffic is routed but not translated');
  // ...and put it back: the same ping translates again, so the role is what changed.
  env2.cfg(env2.a, ['interface Gi0/1', 'no ip nat inside', 'ip nat outside', 'exit']);
  env2.sp.run('ping 198.51.100.9 count 1');
  match(/pat/, env2.a.run('show ip nat translations').output,
    'marking it outside again restores the translation');
}

console.log('\nRemoval undoes exactly the rule it names:');
{
  const env = lab();
  patRules(env);
  env.cfg(env.a, ['ip nat inside source static 10.0.0.50 203.0.113.50']);
  eq(env.r1.config.nat.rules.length, 2, 'two rules to start with');
  const listing = env.cfg(env.a, ['no ip nat inside source']);
  match(/No NAT rule named - the rules on R1:/, listing, 'the bare form lists what is there');
  match(/1\) ip nat inside source list 1 interface Gi0\/1 overload/, listing,
    'printing each in the shape it was typed');
  match(/2\) ip nat inside source static 10\.0\.0\.50 203\.0\.113\.50/, listing, 'including the static one');
  const gone = env.cfg(env.a, ['no ip nat inside source static 10.0.0.50 203.0.113.50']);
  match(/Removed NAT rule: ip nat inside source static 10\.0\.0\.50 203\.0\.113\.50/, gone,
    'removing by the words typed reports what it removed');
  eq(env.r1.config.nat.rules.length, 1, 'and removed exactly one');
  eq(env.r1.config.nat.rules[0].type, 'pat', 'leaving the other alone');
  match(/No NAT rule matching/, env.cfg(env.a, ['no ip nat inside source static 10.0.0.50 203.0.113.50']),
    'removing it again says nothing matches');
  match(/1\) ip nat inside source list 1 interface Gi0\/1 overload/,
    env.cfg(env.a, ['no ip nat inside source static 10.0.0.50 203.0.113.50']),
    'and lists what is left');
  const patGone = env.cfg(env.a, ['no ip nat inside source list 1 interface Gi0/1 overload']);
  match(/Removed NAT rule: ip nat inside source list 1 interface Gi0\/1 overload/, patGone,
    'the list form can be removed by its own words too');
  eq(env.r1.config.nat.rules.length, 0, 'and the table is empty');
  match(/% No NAT rules on R1/, env.cfg(env.a, ['no ip nat inside source']),
    'with nothing left, the removal says so plainly');
  // The removal must also reach the data path.
  env.sp.run('ping 198.51.100.9 count 1');
  match(/\(none/, env.a.run('show ip nat translations').output,
    'and no translation happens after the last rule is gone');
}

console.log('\nThe dump carries the roles and the rules, and pastes back:');
{
  const env = lab();
  patRules(env);
  env.cfg(env.a, ['ip nat inside source static 10.0.0.50 203.0.113.50']);
  const dump = env.a.run('show running-config').output;
  match(/^ interface Gi0\/0\n\s+ip address 10\.0\.0\.1 255\.255\.255\.0\n\s+ip nat inside/m,
    dump.join('\n').replace(/^/gm, ' '), 'the inside port carries its side in the dump');
  match(/ip nat outside/, dump, 'and so does the outside port');
  match(/ip nat inside source list 1 interface Gi0\/1 overload/, dump,
    'the PAT rule is printed as the line that created it, not a compiled form');
  match(/ip nat inside source static 10\.0\.0\.50 203\.0\.113\.50/, dump, 'and the static rule too');
  // Paste the dump into a fresh router of the same shape and compare the NAT state.
  const t2 = new Topology();
  const r9 = t2.addDevice(ROUTER); r9.name = 'R9';
  const sim2 = new Simulator(t2);
  const s9 = new CliSession(r9, t2, sim2);
  s9.run('enable');
  s9.run('configure terminal');
  const echoed = [];
  for (const line of dump.slice(1)) {
    // Ordinary control flow: the banner and the terminator are not commands to paste.
    if (/^!/.test(line) || /^end$/.test(line)) continue;
    const r = s9.run(line).output;
    if (r.some(function (l) { return /^%/.test(l); })) echoed.push(line + ' => ' + r.join(' / '));
  }
  if (echoed.length) console.log('    refused on paste: ' + echoed.join('; '));
  s9.run('end');
  eq((r9.config.nat.rules || []).length, (env.r1.config.nat.rules || []).length,
    'the same number of rules comes back');
  const pat = r9.config.nat.rules.find(function (r) { return r.type === 'pat'; });
  ok(!!pat, 'the pasted PAT rule is there');
  eq(pat && pat.fromList, '1', 'including which list the PAT rule came from');
  eq(pat && pat.fromIface, 'Gi0/1', 'and which interface it overloads onto');
  eq(r9.interfaces.get('Gi0/0').natRole, 'inside', 'and the inside role survives the paste');
  eq(r9.interfaces.get('Gi0/1').natRole, 'outside', 'as does the outside one');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
