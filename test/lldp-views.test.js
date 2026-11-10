'use strict';
// lldp-views.test.js - the LLDP state that was modelled and could not be asked about.
//
// Measured before this pass, on the LLDP admin work committed two iterations earlier:
//   SW1#show lldp neighbors detail
//   % No interface named detail on SW1
//   SW1#show lldp traffic
//   LLDP neighbours on SW1:  ...the neighbour table, answering a different question
//   SW1#show lldp interface
//   LLDP neighbours on SW1:  ...the same table again
//   SW1#show vlan name users
//   % Invalid VLAN id "name"
//
// Three sub-words of one command: one read as a port name, two silently answered with a different
// view. A wrong answer is worse than a refusal, because nothing in it looks wrong.
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
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 900)) + ')'));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });

// SW1 cabled to SW2 on one port and to R1 on another, so there are two neighbours of different kinds.
function lab() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  const sw2 = t.addDevice(SWITCH); sw2.name = 'SW2';
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const ports = Array.from(sw.interfaces.keys()).filter(function (n) {
    const i = sw.interfaces.get(n);
    return !i.svi && !i.parent;
  });
  t.connect(sw.id, ports[0], sw2.id, ports[0]);
  t.connect(sw.id, ports[1], r1.id, 'Gi0/0');
  const sim = new Simulator(t);
  const a = new CliSession(sw, t, sim); a.run('enable');
  const cfg = function (cmds) {
    a.run('configure terminal');
    const out = [];
    for (const c of cmds) out.push.apply(out, a.run(c).output);
    a.run('end');
    return out;
  };
  return { t: t, sim: sim, sw: sw, sw2: sw2, r1: r1, a: a, cfg: cfg, ports: ports,
    p1: ports[0], p2: ports[1] };
}

console.log('\n`show lldp` answers for the device, not the neighbour table:');
{
  const env = lab();
  const out = env.a.run('show lldp');
  match(/Global LLDP Information:/, out, 'there is a device view');
  match(/Status: ACTIVE/, out, 'it says whether LLDP runs');
  match(/sent every 30 seconds/, out, 'the advertisement interval is the library\'s number');
  match(/hold time .*: 120 seconds/, out, 'and the hold time');
  match(/Announcements on: Fa0\/1, Fa0\/2/, out, 'and which ports actually announce - cabled ones');
  match(/Neighbours learned: 2/, out, 'and how many it has heard from');
  match(/show lldp neighbors detail.*show lldp interface.*show lldp traffic/s, out,
    'with a pointer at the three views underneath');
  // A port with nothing plugged in cannot announce anything, and the list must not claim otherwise.
  ok(!/Fa0\/8/.test(out.output.filter(function (l) { return /Announcements on/.test(l); }).join('')),
    'an uncabled port is not listed as announcing');
}

console.log('\n`show lldp neighbors detail` describes each neighbour from the DU that arrived:');
{
  const env = lab();
  const out = env.a.run('show lldp neighbors detail');
  ok(!/No interface named/.test(out.output.join('\n')), 'the word `detail` is not read as a port name');
  match(/Local Intf: Fa0\/1/, out, 'each block names the local port');
  match(/System Name: SW2/, out, 'and who is on the other end');
  match(/System Name: R1/, out, 'for every neighbour, not just the first');
  match(/System Description:\s+generic-switch/, out, 'with the neighbour\'s description, indented under it');
  match(/System Description:\s+generic-router/, out, 'one per neighbour');
  match(/Time To Live: 120 seconds/, out, 'the TTL the announcement carried');
  match(/Port id: Fa0\/1/, out, 'the neighbour\'s port id, which is how a cabling record is written');
  match(/Chassis id: 02:00:00:00:01:00/, out, 'and its chassis id');
  match(/Cage\/medium: rj45 \(1000 Mbps\)/, out, 'the medium and speed it advertised');
  match(/2 neighbours learned by LLDPDUs that crossed the link/, out,
    'the count is of frames that arrived, not of configuration');
  // The whole page is one answer, so a trailing word must not be dropped.
  match(/detail takes no argument, not "extra"/, env.a.run('show lldp neighbors detail extra'),
    'a trailing word is refused by name');
}

console.log('\n`show lldp interface` prints the per-port decision that is modelled:');
{
  const env = lab();
  const before = env.a.run('show lldp interface');
  match(/LLDP interface state on SW1/, before, 'it is a state view');
  match(/Device state: ACTIVE/, before, 'the device decision leads');
  match(/Port\s+Tx\s+Rx\s+Cabled\s+Neighbour/, before, 'the columns are the ones that answer "who may speak"');
  match(/Fa0\/1\s+enabled\s+enabled\s+yes\s+SW2/, before,
    'a cabled port names its neighbour in the same row');
  match(/Fa0\/8\s+enabled\s+enabled\s+no\s+-/, before, 'and an uncabled port says so plainly');
  // `no lldp transmit` must move exactly one column on exactly one port.
  env.cfg(['interface ' + env.p1, 'no lldp transmit']);
  const after = env.a.run('show lldp interface');
  match(/Fa0\/1\s+disabled\s+enabled\s+yes\s+SW2/, after,
    'no lldp transmit disables Tx and leaves Rx alone');
  match(/Fa0\/2\s+enabled\s+enabled/, after, 'and no other port is touched');
  // The neighbour is still known: SW2 keeps announcing, we simply stopped answering.
  match(/LLDP neighbours on SW1/, env.a.run('show lldp neighbors'), 'the neighbour is still learned');
  // And the whole device can be stopped, which the per-port view must report.
  env.cfg(['no lldp run']);
  match(/Device state: DISABLED \(no lldp run\) - neither transmits nor receives/,
    env.a.run('show lldp interface'), 'no lldp run is visible as the device state');
  match(/Fa0\/1\s+disabled\s+disabled/, env.a.run('show lldp interface'),
    'and every port reads disabled while it is off');
  // The per-port form exists too.
  match(/LLDP interface state on SW1/, env.a.run('show lldp interface ' + env.p1), 'one port can be asked about');
  match(/% No interface named bogus/, env.a.run('show lldp interface bogus'),
    'and a word that is neither takes the honest refusal');
}

console.log('\n`show lldp traffic` prints counters, not the neighbour table:');
{
  const env = lab();
  const out = env.a.run('show lldp traffic');
  match(/LLDP traffic on SW1/, out, 'it is a counter view');
  match(/Port\s+Tx frames\s+Rx frames\s+Discarded\s+Errors/, out, 'with the columns a counter view has');
  match(/Fa0\/1\s+1\s+1\s+0\s+0/, out, 'one DU sent and one heard on the cabled port');
  match(/Fa0\/8\s+0\s+0\s+0\s+0/, out, 'and nothing on a port with no cable');
  match(/Totals: 2 sent, 2 received/, out, 'with totals');
  ok(!/Neighbour/.test(out.output.join('\n')), 'and no neighbour table anywhere in it');
  // A discarded DU is counted as discarded, because `no lldp receive` is a decision.
  const env2 = lab();
  env2.cfg(['interface ' + env2.p1, 'no lldp receive']);
  const after = env2.a.run('show lldp traffic');
  match(/Fa0\/1\s+1\s+0\s+1\s+0/, after,
    'a DU heard while the port is told not to listen is counted as discarded');
  match(/1 discarded by "no lldp receive"/, after, 'and the total names the reason');
  // The counters survive an unrelated control-plane reset, because they are port state.
  match(/Fa0\/1/, env2.a.run('clear mac address-table') && env2.a.run('show lldp traffic'),
    'the counters are state on the port, not a walk of the event log');
  match(/LLDP traffic on SW1/, env2.a.run('show lldp traffic ' + env2.p1), 'one port can be asked about');
}

console.log('\nThe four sub-words are words, so a port name still works:');
{
  const env = lab();
  match(/LLDP neighbours on SW1:\s+Neighbour\s+Local port/, env.a.run('show lldp neighbors'), 'the table');
  match(/Fa0\/1/, env.a.run('show lldp neighbors ' + env.p1), 'by port');
  match(/% No interface named bogus/, env.a.run('show lldp neighbors bogus'), 'and a wrong name is refused');
  match(/takes no argument/, env.a.run('show lldp detail extra'), '`show lldp detail` takes nothing after it');
  // `show lldp` alone must not be a refusal on a device with no cabling at all.
  const t = new Topology();
  const lone = t.addDevice(SWITCH); lone.name = 'SW9';
  const s = new CliSession(lone, t, new Simulator(t)); s.run('enable');
  const out = s.run('show lldp');
  match(/Announcements on: \(no port - nothing is cabled/, out,
    'a device with nothing plugged in says why the list is empty');
  match(/Neighbours learned: 0/, out, 'and that it has heard nothing');
  match(/% No neighbours/, s.run('show lldp neighbors detail'), 'the detail view says so too');
  // `detail` is a word of the neighbour table, not of this view: the refusal says where it belongs.
  match(/"show lldp interface" takes a port, not "detail"/, s.run('show lldp interface detail'),
    'detail is answered by name, not read as a port');
}

console.log('\n`show vlan name <name>` narrows by the name the VLAN was given:');
{
  const env = lab();
  env.cfg(['vlan 20 name users', 'vlan 30 name voice']);
  const out = env.a.run('show vlan name users');
  match(/20\s+users/, out, 'a name resolves to its VLAN');
  ok(!/30\s+voice/.test(out.output.join('\n')), 'and the table is narrowed, not annotated');
  match(/20\s+users/, env.a.run('show vlan name USERS'), 'the name is matched without regard to case');
  match(/No VLAN named "bogus"/, env.a.run('show vlan name bogus'), 'an unknown name is refused');
  match(/Names here: users, voice/, env.a.run('show vlan name bogus'),
    'and the refusal lists the names that do exist');
  match(/Incomplete command: show vlan name <name>/, env.a.run('show vlan name'),
    'a missing name is an incomplete command');
  const extra = env.a.run('show vlan name users extra');
  match(/Unexpected argument "extra"/, extra, 'and an extra word is refused');
  match(/Usage: show vlan name <name>/, extra, 'quoting the form that was used, not another one');
  // A device with no names yet gets a pointer at the way to make one.
  const t = new Topology();
  const bare = t.addDevice(SWITCH); bare.name = 'SW8';
  const s = new CliSession(bare, t, new Simulator(t)); s.run('enable');
  match(/No VLAN has a name yet: vlan <id> name <name>/, s.run('show vlan name x'),
    'with no names at all, the refusal names the command that makes one');
  // The other spellings still work.
  match(/20\s+users/, env.a.run('show vlan id 20'), 'show vlan id <n> still works');
  match(/20\s+users/, env.a.run('show vlan 20'), 'so does show vlan <n>');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
