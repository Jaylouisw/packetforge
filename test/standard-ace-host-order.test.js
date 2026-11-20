'use strict';
// A standard access list is not printed — or tested — in the order it was typed or numbered.
//
// IOS moves every entry that pins one address (`host 10.0.0.9`, or `10.0.0.9 0.0.0.0`) above the entries that
// match a range, and it does so in the configuration file as well as in `show access-lists`:
//
//   "The switch always rewrites the order of standard access lists so that entries with host matches and
//    entries with matches having a don't care mask of 0.0.0.0 are moved to the top of the list, above any
//    entries with non-zero don't care masks. Therefore, in show command output and in the configuration
//    file, the ACEs do not necessarily appear in the order in which they were entered."
//   (Catalyst 2960-X 15.2(6)E config guide; the same paragraph runs from the 2960 12.2(25)FX book to the
//    2960-XR/3560CX/Catalyst 1000/IE4010 15.2(x)E books)
//
// A router capture shows what the moved lines look like: the numbers stay with their entries, so the column
// reads 30, 40, 10, 20, 50 … (Cisco Community "Reordered named access-list", td-p/844044). Full note:
// research/standard-ace-host-order.md.
//
// This console printed and evaluated standard lists in sequence order, so a list whose host entry carried the
// higher number was read - and simulated - upside down: the range line permitted the address the box denies.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const aclLib = require('../engine/acl');

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

// pc(10.0.0.9) -- r1(10.0.0.1), with `rules` typed in that order and 10 bound inbound on the port.
function lab(rules, num) {
  const bind = num || 10;
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r1');
  const pc = t.addDevice(PC, 'pc');
  const port = eth(r)[0].name;
  t.connect('pc', 'eth0', 'r1', port);
  const sim = new Simulator(t);
  runCommands(r, t, sim, ['configure terminal', 'interface ' + port,
    'ip address 10.0.0.1 255.255.255.0', 'end']);
  runCommands(r, t, sim, ['configure terminal'].concat(rules)
    .concat(['interface ' + port, 'ip access-group ' + bind + ' in', 'end']));
  runCommands(pc, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'end']);
  return { t: t, sim: sim, r: r, pc: pc, port: port };
}

function run(env, cmd) {
  return ((new CliSession(env.r, env.t, env.sim).run(cmd).output) || []).map(String);
}

// The rule lines, in the order the box printed them.
function ruleLines(lines) {
  return lines.filter(function (l) { return /^\s+\d+\s+(?:permit|deny)\b/.test(l); });
}

function indexOfRule(lines, needle) {
  const rows = ruleLines(lines);
  for (let i = 0; i < rows.length; i++) if (rows[i].indexOf(needle) !== -1) return i;
  return -1;
}

const NETWORK_FIRST = ['access-list 10 permit 10.0.0.0 0.0.0.255', 'access-list 10 deny host 10.0.0.9'];

console.log('');
console.log('A standard list prints its host entry above the range entry, numbers kept as they were given:');
{
  const env = lab(NETWORK_FIRST);
  const rows = ruleLines(run(env, 'show access-lists'));
  ok(rows.length === 2, 'both rules are printed', rows.join(' | '));
  ok(indexOfRule(run(env, 'show access-lists'), '20 deny 10.0.0.9') === 0,
    'the host deny (sequence 20) is the first line', rows.join(' | '));
  ok(indexOfRule(run(env, 'show access-lists'), '10 permit 10.0.0.0, wildcard bits 0.0.0.255') === 1,
    'the range permit (sequence 10) follows it', rows.join(' | '));
  ok(/^\s+20 deny 10\.0\.0\.9$/.test(rows[0]), 'the moved line keeps the number it was given', rows[0]);
}

console.log('');
console.log('The configuration file is written in that same order:');
{
  const env = lab(NETWORK_FIRST);
  const cfg = run(env, 'show running-config');
  const aclLines = cfg.filter(function (l) { return /^access-list 10 /.test(l); });
  ok(aclLines.length === 2, 'both lines are in the file', aclLines.join(' | '));
  ok(/deny host 10\.0\.0\.9|deny 10\.0\.0\.9/.test(aclLines[0] || ''),
    'the host entry is written first', aclLines.join(' | '));
  ok(/permit 10\.0\.0\.0/.test(aclLines[1] || ''), 'the range entry is written second', aclLines.join(' | '));
}

console.log('');
console.log('The simulation tests the list in the order it prints:');
{
  const env = lab(NETWORK_FIRST);
  const p = env.sim.ping('pc', '10.0.0.1', { count: 3 });
  ok(!p || p.received === 0 || p.lost === p.sent,
    'the echo the range line would have permitted is denied by the host line that is tested first',
    JSON.stringify(p && { sent: p.sent, received: p.received, lost: p.lost }));
  const rows = ruleLines(run(env, 'show access-lists'));
  ok(/\((\d+) matches?\)/.test(rows[0] || ''), 'the matches are counted on the host line', rows[0]);
  ok(!/\(\d+ match/.test(rows[1] || ''), 'and not on the range line', rows[1]);
}

console.log('');
console.log('A host spelled with a zero wildcard is the same entry:');
{
  const env = lab(['access-list 10 permit 10.0.0.0 0.0.0.255', 'access-list 10 deny 10.0.0.9 0.0.0.0']);
  const rows = ruleLines(run(env, 'show access-lists'));
  ok(indexOfRule(run(env, 'show access-lists'), 'deny 10.0.0.9') === 0,
    '`10.0.0.9 0.0.0.0` is moved to the top too', rows.join(' | '));
}

console.log('');
console.log('What is not a host, and what is not a standard list:');
{
  const env = lab(['access-list 10 permit 10.0.0.0 0.0.0.255', 'access-list 10 deny any']);
  const rows = ruleLines(run(env, 'show access-lists'));
  ok(indexOfRule(run(env, 'show access-lists'), 'permit 10.0.0.0') === 0 && /deny any/.test(rows[1] || ''),
    '`any` has a wildcard of all ones and stays below the range entry', rows.join(' | '));

  const ext = lab(['access-list 101 permit ip 10.0.0.0 0.0.0.255 any', 'access-list 101 deny ip host 10.0.0.9 any'], 101);
  const extRows = ruleLines(run(ext, 'show access-lists'));
  ok(/permit/.test(extRows[0] || '') && /deny/.test(extRows[1] || ''),
    'an extended list keeps sequence order - the rewrite is a standard-list rule', extRows.join(' | '));
}

console.log('');
console.log('The ordering helper itself, without a device in the way:');
{
  const list = [
    aclLib.parseEntry('permit 10.0.0.0 0.0.0.255', 10),
    aclLib.parseEntry('deny host 10.0.0.9', 10),
    aclLib.parseEntry('permit 192.168.0.0 0.0.255.255', 10)
  ];
  const ordered = aclLib.numberedEntries(list).map(function (s) { return s.seq; });
  ok(ordered.length === 3 && ordered[0] === 20 && ordered[1] === 10 && ordered[2] === 30,
    'hosts first, each group in sequence order (20, 10, 30)', ordered.join(','));
  const verdict = aclLib.evaluate(list, { srcIp: '10.0.0.9', dstIp: '10.0.0.1', protocol: 'icmp' });
  ok(verdict.action === 'deny' && verdict.matchedEntry && verdict.matchedEntry.source.ip === '10.0.0.9',
    'first match is the moved host line, and the verdict names the entry itself', JSON.stringify(verdict));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
