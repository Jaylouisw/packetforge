'use strict';
// stp-config.test.js - a spanning tree you could watch but not choose, and a root the table never named.
//
// Measured before this pass, on three switches cabled in a triangle (SW1-Fa0/1-SW2, SW2-Fa0/2-SW3,
// SW3-Fa0/2-SW1):
//   SW1#configure terminal
//   SW1(config)#spanning-tree vlan 1 root primary
//   % Unrecognized config command: spanning-tree vlan 1 root primary
//   SW1(config)#spanning-tree vlan 1 priority 4096
//   % Unrecognized config command: spanning-tree vlan 1 priority 4096
//   SW1(config-if)#spanning-tree cost 19
//   % Unrecognized interface command: spanning-tree cost 19
//
// ...so the tree was decided by device creation order and by cable speed alone, and could not be
// influenced at all. Meanwhile `show spanning-tree` printed roles and states with no root anywhere,
// while its own help row promised "root bridge, port roles and states".
//
// The election itself had a defect that only showed up once cost could be configured: the root path
// cost charged the port the BPDU *left* by, while the root-port choice charged the port it *arrived*
// on. The two disagreed, so a cost set on the port you care about moved nothing.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const stpLib = require('../engine/stp');

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
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 400)) + ')'));
}
function noMatch(re, haystack, msg) {
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(!re.test(text), msg + (re.test(text) ? ' (found ' + re + ')' : ''));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

// SW1 -- SW2 -- SW3 -- SW1 : one loop, one port must block.
function triangle() {
  const t = new Topology();
  const s1 = t.addDevice(SWITCH); s1.name = 'SW1';
  const s2 = t.addDevice(SWITCH); s2.name = 'SW2';
  const s3 = t.addDevice(SWITCH); s3.name = 'SW3';
  t.connect(s1.id, 'Fa0/1', s2.id, 'Fa0/1');
  t.connect(s2.id, 'Fa0/2', s3.id, 'Fa0/1');
  t.connect(s3.id, 'Fa0/2', s1.id, 'Fa0/2');
  const sim = new Simulator(t);
  const cli = function (d) {
    const s = new CliSession(d, t, sim);
    s.run('enable');
    return s;
  };
  const s1c = cli(s1), s2c = cli(s2), s3c = cli(s3);
  const cfg = function (s, cmds) {
    s.run('configure terminal');
    for (const c of cmds) s.run(c);
    s.run('end');
  };
  return { t: t, sim: sim, s1: s1, s2: s2, s3: s3, s1c: s1c, s2c: s2c, s3c: s3c, cfg: cfg };
}
function row(s, port) {
  const line = s.run('show spanning-tree').output.filter(function (l) {
    return new RegExp('^' + port.replace(/[/.]/g, '\\$&') + '\\s').test(l);
  })[0] || '';
  // The state column can carry a parenthetical ("blocking   (traffic dropped)"), so split on the
  // shape of the row rather than on runs of spaces.
  const m = /^(\S+)\s+(\S+)\s+(\S+)(.*?)\s+(\d+)$/.exec(line.trim());
  return m ? { port: m[1], role: m[2], state: m[3], cost: m[5] } : {};
}

console.log('\nThe table names the root, the bridge ID and the path cost:');
{
  const env = triangle();
  const out = env.s1c.run('show spanning-tree').output;
  match(/Root bridge: priority 32768, 02:00:00:00:00:00 \(SW1\)/, out,
    'the root is named, with the priority and bridge ID that won');
  match(/This bridge: SW1 priority 32768, 02:00:00:00:00:00\s+\(this bridge is the root\)/, out,
    'and the root says it is the root');
  match(/This bridge: SW2 priority 32768, .*root path cost 20000/,
    env.s2c.run('show spanning-tree').output, 'a non-root switch reports its root path cost');
  // One loop, one blocked port, and the table says whose port lost the segment and on what.
  const blocked = env.s3c.run('show spanning-tree').output;
  match(/Fa0\/1\s+alternate\s+blocking/, blocked, 'the blocked port is alternate/blocking');
  match(/Fa0\/1 is alternate: SW2 reaches the root for the same 20000, and the tie goes to the lower bridge ID/,
    blocked, 'and the reason names the winner and the tie-break');
  // The bridge ID is the device's own, not a constant shared by every switch.
  const ids = [env.s1, env.s2, env.s3].map(function (d) { return d.stp.bridgeId; });
  ok(new Set(ids).size === 3, 'every bridge has its own bridge ID (' + ids.join(', ') + ')');
}

console.log('\nThe root can be chosen by priority:');
{
  const env = triangle();
  env.cfg(env.s3c, ['spanning-tree vlan 1 priority 4096']);
  match(/this bridge is the root/, env.s3c.run('show spanning-tree').output,
    'the configured priority makes SW3 the root');
  match(/Root bridge: priority 4096, .*\(SW3\)/, env.s1c.run('show spanning-tree').output,
    'and every other switch names SW3 as root');
  // 8192 loses to 4096, so the root moves again.
  env.cfg(env.s2c, ['spanning-tree vlan 1 priority 8192']);
  match(/Root bridge: priority 4096, .*\(SW3\)/, env.s2c.run('show spanning-tree').output,
    'a higher priority does not take the root away');
  env.cfg(env.s2c, ['spanning-tree vlan 1 priority 0']);
  match(/Root bridge: priority 0, .*\(SW2\)/, env.s3c.run('show spanning-tree').output,
    'a lower one does');
}

console.log('\n...and by asking for it, in the words an operator uses:');
{
  const env = triangle();
  const said = env.s3c.run('configure terminal', 'spanning-tree vlan 1 root primary', 'end').output;
  match(/SW3 is set to be root primary \(bridge priority 24576\)/, said,
    'root primary answers with the priority it chose');
  eq(env.s3.priority, undefined, 'priority is stored under the config, not invented elsewhere');
  eq(env.s3.config.stpPriority, 24576, 'and it is the IOS default for root primary');
  match(/this bridge is the root/, env.s3c.run('show spanning-tree').output, 'SW3 is the root');
  env.cfg(env.s2c, ['spanning-tree vlan 1 priority 4096']);
  env.cfg(env.s1c, ['spanning-tree vlan 1 root secondary']);
  eq(env.s1.config.stpPriority, 8192, 'root secondary lands just below 4096, not at a fixed number');
  // `no spanning-tree vlan 1` puts the default back, and the root returns to the lower bridge ID.
  const back = env.s1c.run('configure terminal', 'no spanning-tree vlan 1', 'end').output;
  match(/reset to the default \(32768\) .*was 8192/, back, 'the no form reports what it undid');
  eq(env.s1.config.stpPriority, undefined, 'and the override is gone');
}

console.log('\nPort cost is what the tree charges, on the port you configured:');
{
  const env = triangle();
  eq(row(env.s3c, 'Fa0/1').cost, '20000', 'a fast port costs 20000 by default');
  match(/Spanning tree cost 100 on Fa0\/1/,
    env.s3c.run('configure terminal', 'interface Fa0/1', 'spanning-tree cost 100', 'exit', 'end').output,
    'the cost is accepted');
  eq(row(env.s3c, 'Fa0/1').cost, '100', 'and the table shows it');
  // The port the operator configured is the port the tree charges. SW3's Fa0/1 is its long way to
  // the root; Fa0/2 is the direct one, so configuring Fa0/2 is what moves SW3's own path cost.
  env.cfg(env.s3c, ['interface Fa0/2', 'spanning-tree cost 100', 'exit']);
  match(/This bridge: SW3 priority 32768, .*root path cost 100/,
    env.s3c.run('show spanning-tree').output,
    'and SW3\'s root path cost drops to what it configured - the port charged is the port arrived on');
  // Rasing Fa0/1 to the maximum leaves the tree on the cheap port, and Fa0/1 designated.
  env.cfg(env.s3c, ['interface Fa0/1', 'spanning-tree cost 200000000', 'exit']);
  match(/This bridge: SW3 priority 32768, .*root path cost 100/, env.s3c.run('show spanning-tree').output,
    'a port that costly is not on the root path at all');
  eq(row(env.s3c, 'Fa0/1').role, 'designated', 'and it is designated instead of alternate');
  eq(row(env.s3c, 'Fa0/2').role, 'root', 'while the cheap port is the root port');
  // ...and the no form returns it to the speed-derived value.
  match(/back to the speed-derived default \(was 200000000\)/,
    env.s3c.run('configure terminal', 'interface Fa0/1', 'no spanning-tree cost', 'exit', 'end').output,
    'the no form reports the value it replaced');
  eq(row(env.s3c, 'Fa0/1').cost, '20000', 'and the cost is the speed-derived one again');
  match(/is already the speed-derived default/,
    env.s3c.run('configure terminal', 'interface Fa0/1', 'no spanning-tree cost', 'exit', 'end').output,
    'doing it twice says there was nothing to undo');
}

console.log('\nEverything it refuses, it refuses by name:');
{
  const env = triangle();
  const said = function (cmds) { return env.s2c.run('configure terminal', ...cmds, 'end').output; };
  match(/% Invalid bridge priority "4000" - it must be 0-61440 in steps of 4096/,
    said(['spanning-tree vlan 1 priority 4000']), 'a priority off the 4096 grid is refused with the rule');
  match(/% Invalid bridge priority "70000"/, said(['spanning-tree vlan 1 priority 70000']),
    'and so is one above the range');
  match(/% Incomplete command: spanning-tree vlan 1 priority <n>/,
    said(['spanning-tree vlan 1 priority']), 'a missing value is incomplete, not a default');
  match(/% Unexpected argument "7"/, said(['spanning-tree vlan 1 priority 4096 7']),
    'a trailing word is refused, with the synopsis');
  match(/% VLAN id must be a number 1-4094, not "9999"/, said(['spanning-tree vlan 9999 priority 4096']),
    'a VLAN that cannot exist is named');
  match(/% VLAN id must be a number 1-4094, not "abc"/, said(['spanning-tree vlan abc priority 4096']),
    'and so is a word where a number belongs');
  match(/% Unknown spanning-tree root role "tertiary"/, said(['spanning-tree vlan 1 root tertiary']),
    'the root role must be primary or secondary');
  match(/% Usage: no spanning-tree vlan <id>/, said(['no spanning-tree']),
    'a bare `no spanning-tree` says what it would take, not that it worked');
  match(/cannot be turned off in this model/, said(['no spanning-tree']),
    'and says why this model will not do it');
  // Interface half.
  const ifc = function (cmds) {
    return env.s2c.run('configure terminal', 'interface Fa0/1', ...cmds, 'exit', 'end').output;
  };
  match(/% Invalid path cost "0" - it must be 1-200000000/, ifc(['spanning-tree cost 0']),
    'cost 0 is refused with the range');
  match(/% Incomplete command: spanning-tree cost <n>/, ifc(['spanning-tree cost']),
    'a missing cost is incomplete');
  // The two knobs this model has nothing to do with are refused by naming that, not stored.
  match(/portfast is not modelled/, ifc(['spanning-tree portfast']), 'portfast is refused by name');
  match(/port-priority is not modelled/, ifc(['spanning-tree port-priority 16']),
    'port-priority is refused by name');
  match(/bpduguard is not modelled/, ifc(['spanning-tree bpduguard enable']),
    'bpduguard is refused by name');
  eq(env.s2.interfaces.get('Fa0/1').stpCost, undefined, 'and none of them is stored on the port');
  // A device that does not bridge cannot run any of it.
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const rs = new CliSession(r1, t, new Simulator(t));
  rs.run('enable');
  const rOut = rs.run('configure terminal', 'spanning-tree vlan 1 root primary', 'end').output;
  match(/R1 does not bridge - spanning tree runs on switches/, rOut,
    'a router is refused, and told what does bridge');
  const rIfc = rs.run('configure terminal', 'interface Gi0/0', 'spanning-tree cost 10', 'exit', 'end').output;
  match(/does not bridge/, rIfc, 'including in an interface block');
}

console.log('\nThe library charges the port the BPDU arrives on:');
{
  // The unit-level statement of the same rule, so the fix is pinned where it lives.
  const res = stpLib.runStp({
    bridges: [
      { key: 'A', priority: 4096, mac: '00:00:00:00:00:01',
        ports: [{ name: 'q1', cost: 100, to: { bridge: 'B', port: 'p1' } }] },
      { key: 'B', priority: 32768, mac: '00:00:00:00:00:02',
        ports: [{ name: 'p1', cost: 4, to: { bridge: 'A', port: 'q1' } },
          { name: 'p2', cost: 100, to: { bridge: 'C', port: 'p1' } }] },
      { key: 'C', priority: 32768, mac: '00:00:00:00:00:03',
        ports: [{ name: 'p1', cost: 19, to: { bridge: 'B', port: 'p2' } }] }
    ]
  });
  // A is root. B reaches it for 4. C reaches it through B: 4 + the cost of C's own port (19) = 23.
  eq(res.pathCost.B, 4, 'the neighbour\'s path costs its own port');
  eq(res.pathCost.C, 23, 'and the far bridge costs the port it arrives on');
  eq(res.ports.C.p1.role, 'root', 'which is the port it then uses');
}

console.log('\nThe dump carries what it took to build the tree:');
{
  const env = triangle();
  env.cfg(env.s3c, ['spanning-tree vlan 1 priority 4096', 'interface Fa0/1', 'spanning-tree cost 100', 'exit']);
  const dump = env.s3c.run('show running-config').output;
  match(/^spanning-tree vlan 1 priority 4096$/m, dump, 'the bridge priority is in the dump');
  match(/^ {2}spanning-tree cost 100$/m, dump, 'and so is the port cost');
  // Paste it into an identical topology: same root, same cost, same roles.
  const fresh = triangle();
  fresh.s3c.run('configure terminal');
  // The banner and the hostname are not configuration of the tree; everything else is pasted as-is,
  // line for line, which is the only way this check proves the dump round-trips.
  dump.filter(function (line) { return !/^!/.test(line) && !/^hostname /.test(line); })
    .forEach(function (line) { fresh.s3c.run(line); });
  fresh.s3c.run('end');
  eq(fresh.s3.config.stpPriority, 4096, 'the pasted dump sets the same priority');
  eq(row(fresh.s3c, 'Fa0/1').cost, '100', 'and the same port cost');
  match(/this bridge is the root/, fresh.s3c.run('show spanning-tree').output,
    'so the pasted topology elects the same root');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
