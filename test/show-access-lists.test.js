'use strict';
// `show access-lists` listed rules and said nothing about them (#1267).
//
// The simulator already knew which rule matched - `aclLib.evaluate()` returns `matchedIndex` - and threw it
// away. So the console could say that an ACL was denying (via the drop summary on `show interfaces`:
// "2 drops (ACL 101 denied (in) x2)") and never which line was doing it, which is the whole reason anyone
// opens this table.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];
const eth = function (d) {
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
};

// pc -- r1. `rules` are the access-list lines, `bind` the direction to apply them in.
function lab(rules, bind) {
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r1');
  const pc = t.addDevice(PC, 'pc');
  const port = eth(r)[0].name;
  t.connect('pc', 'eth0', 'r1', port);
  const sim = new Simulator(t);
  runCommands(r, t, sim, ['configure terminal', 'interface ' + port,
    'ip address 10.0.0.1 255.255.255.0', 'end']);
  runCommands(r, t, sim, ['configure terminal'].concat(rules).concat([
    'interface ' + port, 'ip access-group 101 ' + (bind || 'in'), 'end']));
  runCommands(pc, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'end']);
  return { t: t, sim: sim, r: r, pc: pc, port: port };
}

function table(env, cli) {
  const session = cli || new CliSession(env.r, env.t, env.sim);
  return ((session.run('show access-lists').output) || []).map(String);
}

// The count printed beside a rule, or null when the line carries no count at all. A rule that matched
// nothing must print nothing: "(0 matches)" on every line of a twenty-line ACL is noise, and absence is the
// same statement.
function countOf(lines, needle) {
  const line = lines.filter(function (l) { return l.indexOf(needle) !== -1; })[0];
  if (!line) return undefined;
  const m = /\((\d+) match(?:es)?\)/.exec(line);
  return m ? Number(m[1]) : null;
}

const DENY_ICMP = ['access-list 101 deny icmp any any', 'access-list 101 permit ip any any'];

console.log('');
console.log('Before anything has run, and before anything has matched:');
{
  const env = lab(DENY_ICMP);
  const noSim = table(env, new CliSession(env.r, env.t, null));
  ok(/not measured \(no simulation run\)/.test(noSim.join('\n')),
    'with no simulator, the table says counters were not measured', noSim.join(' | '));
  ok(!/\(0 match/.test(noSim.join('\n')), 'and invents no zero counts', noSim.join(' | '));

  const env2 = lab(DENY_ICMP);
  const cold = table(env2);
  ok(/no packet has been tested against this list/.test(cold.join('\n')),
    'with a simulator but no traffic, it says so - which is not the same as "nothing matched"',
    cold.join(' | '));
}

console.log('');
console.log('A denied flow names the rule that denied it:');
{
  const env = lab(DENY_ICMP);
  const r = env.sim.ping('pc', '10.0.0.1', { count: 5 });
  ok(r.replies.every(function (x) { return !x.success; }), 'all five pings are denied',
    r.replies.map(function (x) { return x.success; }).join(','));

  const lines = table(env);
  ok(countOf(lines, 'deny icmp any any') === 5, 'the deny rule shows 5 matches', lines.join(' | '));
  ok(countOf(lines, 'permit ip any any') === null,
    'the rule that matched nothing shows no count at all', lines.join(' | '));

  // The two tables must agree about the same five packets: `show interfaces` and `show access-lists` are
  // read together when someone asks "why is this not getting through".
  const iface = ((new CliSession(env.r, env.t, env.sim).run('show interfaces ' + env.port).output) || [])
    .map(String).join('\n');
  ok(/5 drops \(ACL 101 denied \(in\) x5\)/.test(iface),
    'and show interfaces reports the same five, over the same ACL', iface);

  const again = env.sim.ping('pc', '10.0.0.1', { count: 2 });
  ok(again.replies.every(function (x) { return !x.success; }), 'two more are denied');
  ok(countOf(table(env), 'deny icmp any any') === 7,
    'and the count accumulates across runs, like a real counter', table(env).join(' | '));
}

console.log('');
console.log('A permitted flow names the rule that permitted it:');
{
  const env = lab(['access-list 101 permit icmp any any', 'access-list 101 deny ip any any']);
  const r = env.sim.ping('pc', '10.0.0.1', { count: 3 });
  ok(r.replies.every(function (x) { return x.success; }), 'the pings get through',
    r.replies.map(function (x) { return x.success; }).join(','));

  const lines = table(env);
  ok(countOf(lines, 'permit icmp any any') >= 3,
    'the permit rule is counted too, not just the denies', lines.join(' | '));
  ok(countOf(lines, 'deny ip any any') === null,
    'and the rule that never matched stays uncounted', lines.join(' | '));
}

console.log('');
console.log('The implicit deny is a real rule and is reported when it fires:');
{
  // Only ICMP is permitted; a ping to an address that is not on the wire still matches it, so use TCP-ish
  // traffic: an HTTP get to a port with no server. Simpler and more direct - permit only a host that is not
  // involved, so the ping matches nothing in the list.
  const env = lab(['access-list 101 permit icmp host 10.0.0.77 any']);
  const r = env.sim.ping('pc', '10.0.0.1', { count: 2 });
  ok(r.replies.every(function (x) { return !x.success; }), 'the pings are dropped',
    r.replies.map(function (x) { return x.success; }).join(','));
  const lines = table(env);
  ok(/\(implicit deny all: 2 matches\)/.test(lines.join('\n')),
    'and the implicit deny is reported with its own count, not folded into a rule that did not match',
    lines.join(' | '));
  ok(countOf(lines, 'permit icmp host 10.0.0.77 any') === null,
    'while the rule that matched nothing stays uncounted', lines.join(' | '));
}

console.log('');
console.log('One match reads as one match:');
{
  const env = lab(DENY_ICMP);
  env.sim.ping('pc', '10.0.0.1', { count: 1 });
  const line = table(env).filter(function (l) { return /deny icmp/.test(l); })[0];
  ok(/\(1 match\)/.test(line), 'singular, not "1 matches"', line);
}

console.log('');
console.log('The outbound direction is counted too:');
{
  const env = lab(['access-list 101 deny icmp any any', 'access-list 101 permit ip any any'], 'out');
  const r = env.sim.ping('pc', '10.0.0.1', { count: 3 });
  ok(r.replies.every(function (x) { return !x.success; }), 'an outbound deny blocks the reply path',
    r.replies.map(function (x) { return x.success; }).join(','));
  ok(countOf(table(env), 'deny icmp any any') >= 3,
    'and the rule is counted on the way out', table(env).join(' | '));
}

console.log('');
console.log('Nothing is invented for an ACL that was never applied:');
{
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r1');
  const sim = new Simulator(t);
  runCommands(r, t, sim, ['configure terminal', 'access-list 102 deny ip any any', 'end']);
  const lines = table({ t: t, sim: sim, r: r });
  ok(/Extended IP access list 102/.test(lines.join('\n')), 'the list is printed', lines.join(' | '));
  ok(/no packet has been tested against this list/.test(lines.join('\n')),
    'and says no packet was tested against it, because it was bound to nothing', lines.join(' | '));
  ok(!/applied IN|applied OUT/.test(lines.join('\n')), 'with no invented binding', lines.join(' | '));
}

console.log('');
console.log('A rule keeps its own history when the list is rewritten around it:');
{
  const env = lab(['access-list 101 permit ip any any']);
  env.sim.ping('pc', '10.0.0.1', { count: 2 });
  // Rewrite the list with a deny in front of it. Counters are keyed by the rule's text, so the two packets
  // the permit carried must not be re-attributed to the new deny that now sits at index 0 - which is what an
  // index key did, reporting that a rule which had never seen a packet had denied forty of them.
  runCommands(env.r, env.t, env.sim, ['configure terminal',
    'no access-list 101', 'access-list 101 deny tcp any any', 'access-list 101 permit ip any any', 'end']);
  const lines = table(env);
  ok(/deny tcp any any/.test(lines.join('\n')), 'the new list is printed', lines.join(' | '));
  ok(!/deny tcp any any \(\d+ match/.test(lines.join('\n')),
    'and a rule that has never matched is not credited with the old rule\'s traffic', lines.join(' | '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
