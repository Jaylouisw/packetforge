'use strict';
// The numbers down the left of `show access-lists` (#1724).
//
// The table printed "  1", "  2", "  3" - an array index - two spaces in from the margin. No IOS prints
// either: "if entries with no sequence numbers are applied, the first entry is assigned a sequence number
// of 10, and successive entries are incremented by 10" (Cisco IOS XE, IP Access List Entry Sequence
// Numbering), and the line is indented four columns under the header. A reader comparing this table with a
// box therefore saw a column of numbers the box cannot produce, and could not name the line to change.
//
// The last section is the load-bearing one: the numbers read out are the order the box tests packets in, so
// a line numbered 5 is consulted before a line numbered 10, and the display cannot disagree with the match.
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

// pc -- r1, with the given ACL lines typed in this order.
function lab(rules) {
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r1');
  const pc = t.addDevice(PC, 'pc');
  const port = eth(r)[0].name;
  t.connect('pc', 'eth0', 'r1', port);
  const sim = new Simulator(t);
  runCommands(r, t, sim, ['configure terminal', 'interface ' + port,
    'ip address 10.0.0.1 255.255.255.0', 'end']);
  runCommands(r, t, sim, ['configure terminal'].concat(rules)
    .concat(['interface ' + port, 'ip access-group 101 in', 'end']));
  runCommands(pc, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'end']);
  return { t: t, sim: sim, r: r, pc: pc, port: port };
}

function table(env) {
  return ((new CliSession(env.r, env.t, env.sim).run('show access-lists').output) || []).map(String);
}

// The rule lines: the ones that start with a sequence number.
function rows(lines) {
  return lines.filter(function (l) { return /^\s+\d+\s+(?:permit|deny)\b/.test(l); });
}

function seqOf(line) {
  const m = /^(\s*)(\d+)\s+/.exec(line || '');
  return m ? { indent: m[1].length, seq: Number(m[2]) } : null;
}

console.log('');
console.log('A list typed without sequence numbers is numbered 10, 20, 30 - four columns in:');
{
  const env = lab(['access-list 101 deny icmp any any', 'access-list 101 permit ip any any']);
  const r = rows(table(env));
  ok(r.length === 2, 'both rules are listed', r.join(' | '));
  ok(seqOf(r[0]).seq === 10, 'the first entry is 10', r[0]);
  ok(seqOf(r[1]).seq === 20, 'and the next steps by ten, not by one', r[1]);
  ok(seqOf(r[0]).indent === 4, 'the number sits four columns in from the margin', r[0]);
  ok(!/^\s+1\s/.test(table(env).join('\n')), 'no line is numbered 1', table(env).join(' | '));
  ok(/^    10 deny icmp any any$/.test(r[0]), 'the line reads as a box prints it', JSON.stringify(r[0]));
}

console.log('');
console.log('A line given a sequence keeps it, and its body is printed once:');
{
  const r = rows(table(lab(['access-list 102 9999 permit ip any any'])));
  ok(seqOf(r[0]).seq === 9999, 'the typed sequence is the number shown', r[0]);
  ok(!/9999\s+9999/.test(r[0]), 'the body does not carry a second copy of it', r[0]);
  ok(/permit ip any any$/.test(r[0]), 'and the body is intact', r[0]);
}

console.log('');
console.log('The numbers read top to bottom are the order the box tests packets in:');
{
  // Typed permit first, then a deny at 5: the deny is consulted first, so the ping never reaches the permit.
  const env = lab(['access-list 101 permit ip any any', 'access-list 101 5 deny icmp any any']);
  const r = rows(table(env));
  ok(seqOf(r[0]).seq === 5, 'the 5 line is printed first', r[0]);
  ok(seqOf(r[1]).seq === 10, 'and the defaulted line follows at 10', r[1]);
  const res = env.sim.ping('pc', '10.0.0.1', { count: 3 });
  ok(res.replies.every(function (x) { return !x.success; }),
    'and the 5 line decides the ping - the table and the match agree',
    res.replies.map(function (x) { return x.success; }).join(','));
}

console.log('');
console.log('Counters still land on the line that matched, not on its position:');
{
  const env = lab(['access-list 101 deny icmp any any', 'access-list 101 permit ip any any']);
  env.sim.ping('pc', '10.0.0.1', { count: 4 });
  const r = rows(table(env));
  ok(/\(4 matches\)$/.test(r[0]), 'the deny line carries the four matches', r[0]);
  ok(!/\(\d+ match/.test(r[1]), 'the line that matched nothing still carries no count', r[1]);
  ok(seqOf(r[0]).seq === 10, 'and the numbers are unchanged by the counting', r[0]);
}

console.log('');
console.log('The same table is behind `show ip access-lists`:');
{
  const env = lab(['access-list 101 permit ip any any']);
  const viaIp = ((new CliSession(env.r, env.t, env.sim).run('show ip access-lists').output) || [])
    .map(String).filter(function (l) { return /^\s+\d+\s+/.test(l); });
  ok(viaIp.length === 1 && /^    10 permit ip any any$/.test(viaIp[0]),
    'the alias prints the numbered line', viaIp.join(' | '));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
