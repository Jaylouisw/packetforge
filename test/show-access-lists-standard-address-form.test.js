'use strict';
// How `show access-lists` spells the source of a standard entry (#1724's sibling).
//
// The table echoed the line as it had been typed. Every IOS prints a standard entry's address in its own
// form instead: `permit 192.168.1.0, wildcard bits 0.0.0.255` (comma, then the words), a host as the bare
// address with no `host` keyword, and `any` as `any`. A reader comparing the simulator with a box saw a
// column of rules that no box prints, on the one command opened to read a policy back.
//
// The extended form is different - it keeps `host` and prints the address and wildcard side by side - so
// nothing here changes an extended line. What a box does with a host typed as `x 0.0.0.0` in an extended
// entry is not settled by the captures in hand; research/show-access-lists-standard-address-form.md.
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

// pc -- r1, with the given ACL lines typed in this order and bound inbound on the router port.
function lab(rules, bind) {
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r1');
  const pc = t.addDevice(PC, 'pc');
  const port = eth(r)[0].name;
  t.connect('pc', 'eth0', 'r1', port);
  const sim = new Simulator(t);
  runCommands(r, t, sim, ['configure terminal', 'interface ' + port,
    'ip address 10.0.0.1 255.255.255.0', 'end']);
  runCommands(r, t, sim, ['configure terminal'].concat(rules)
    .concat(['interface ' + port, 'ip access-group ' + (bind || 10) + ' in', 'end']));
  runCommands(pc, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'end']);
  return { t: t, sim: sim, r: r, pc: pc, port: port };
}

function table(env, cmd) {
  return ((new CliSession(env.r, env.t, env.sim).run(cmd || 'show access-lists').output) || []).map(String);
}

function rules(lines) {
  return lines.filter(function (l) { return /^\s+\d+\s+(?:permit|deny)\b/.test(l); });
}

console.log('');
console.log('A standard entry prints its address the way a box prints it:');
{
  const env = lab([
    'access-list 10 permit 192.168.1.0 0.0.0.255',
    'access-list 10 deny host 10.0.1.10',
    'access-list 10 permit any'
  ]);
  const r = rules(table(env));
  ok(r.length === 3, 'all three rules are listed', r.join(' | '));
  ok(/^    10 permit 192\.168\.1\.0, wildcard bits 0\.0\.0\.255$/.test(r[0]),
    'a network prints with a comma and the words `wildcard bits`', JSON.stringify(r[0]));
  ok(/^    20 deny 10\.0\.1\.10$/.test(r[1]),
    'a host prints as the bare address - the typed `host` keyword is dropped', JSON.stringify(r[1]));
  ok(!/host/.test(r[1]), 'and the word `host` is nowhere on the line', r[1]);
  ok(/^    30 permit any$/.test(r[2]), '`any` stays `any`', JSON.stringify(r[2]));
}

console.log('');
console.log('The sequence number, the indent and a trailing `log` are unchanged:');
{
  const r = rules(table(lab([
    'access-list 10 permit 10.0.0.0 0.255.255.255 log',
    'access-list 10 5 deny 172.16.0.0 0.0.255.255'
  ])));
  const first = r.filter(function (l) { return /10\.0\.0\.0/.test(l); })[0] || '';
  const five = r.filter(function (l) { return /5 deny/.test(l); })[0] || '';
  ok(/^    10 permit 10\.0\.0\.0, wildcard bits 0\.255\.255\.255 log$/.test(first),
    'the number sits four columns in, the address carries its wildcard, and `log` ends the line',
    JSON.stringify(first));
  ok(/^    5 deny 172\.16\.0\.0, wildcard bits 0\.0\.255\.255$/.test(five),
    'a hand-typed sequence is still printed once, in front of the canonical body', JSON.stringify(five));
  ok(!/5\s+5\s/.test(five), 'and the body does not carry a second copy of it', five);
}

console.log('');
console.log('A wildcard of all zeroes is a host, however it was typed:');
{
  const r = rules(table(lab(['access-list 10 permit 10.1.1.1 0.0.0.0'])));
  ok(/^    10 permit 10\.1\.1\.1$/.test(r[0] || ''),
    'an all-zero wildcard prints as the bare address, not with `wildcard bits`', JSON.stringify(r[0]));
}

console.log('');
console.log('A wildcard of all ones is `any`, however it was typed:');
{
  const r = rules(table(lab([
    'access-list 10 permit 0.0.0.0 255.255.255.255',
    'access-list 10 deny 0.0.0.0 255.255.255.255 log',
    'access-list 10 permit 10.0.0.1 255.255.255.255',
    'access-list 10 permit host 0.0.0.0'
  ])));
  ok(/^    10 permit any$/.test(r[0] || ''),
    'the spelled-out `any` prints as `any`, because that is the entry the box stored',
    JSON.stringify(r[0]));
  ok(/^    20 deny any log$/.test(r[1] || ''),
    'and the same fold keeps a trailing `log`', JSON.stringify(r[1]));
  ok(/^    30 permit 10\.0\.0\.1, wildcard bits 255\.255\.255\.255$/.test(r[2] || ''),
    'an all-ones wildcard over a real address keeps its wildcard - no capture shows a box folding that one',
    JSON.stringify(r[2]));
  ok(/^    40 permit 0\.0\.0\.0$/.test(r[3] || ''),
    'a host of 0.0.0.0 is a host, not `any`', JSON.stringify(r[3]));
  ok(aclLib.displayBody({ kind: 'standard', action: 'deny',
    source: { ip: '0.0.0.0', wildcard: '255.255.255.255', any: false, host: false } }) === 'deny any',
    'the renderer folds the pair without being told it was spelled out');
}

console.log('');
console.log('The count lands on the line as printed:');
{
  const env = lab(['access-list 10 deny host 10.0.0.9', 'access-list 10 permit any']);
  const res = env.sim.ping('pc', '10.0.0.1', { count: 3 });
  ok(res.replies.every(function (x) { return !x.success; }), 'the three pings are denied');
  const r = rules(table(env));
  ok(/^    10 deny 10\.0\.0\.9 \(3 matches\)$/.test(r[0] || ''),
    'the printed deny line carries the three matches', JSON.stringify(r[0]));
  ok(!/match/.test(r[1] || ''), 'the permit that never matched still carries no count', r[1]);
}

console.log('');
console.log('The same table is behind `show ip access-lists`:');
{
  const r = rules(table(lab(['access-list 10 permit 10.10.10.0 0.0.0.255']), 'show ip access-lists'));
  ok(/^    10 permit 10\.10\.10\.0, wildcard bits 0\.0\.0\.255$/.test(r[0] || ''),
    'the alias prints the canonical line', JSON.stringify(r[0]));
}

console.log('');
console.log('The running-config still shows what was typed, and extended lines are untouched:');
{
  const env = lab(['access-list 10 permit 192.168.1.0 0.0.0.255']);
  const cfg = runCommands(env.r, env.t, env.sim, ['show running-config']).lines.join('\n');
  ok(/access-list 10 permit 192\.168\.1\.0 0\.0\.0\.255/.test(cfg),
    'the configuration echoes the line as entered - address and wildcard, no comma', cfg);

  const ext = rules(table(lab(['access-list 101 deny icmp any any', 'access-list 101 permit ip any any'], 101)));
  ok(/^    10 deny icmp any any$/.test(ext[0] || ''),
    'an extended line keeps its own spelling', JSON.stringify(ext[0]));
}

console.log('');
console.log('A line with no parsed source keeps its text rather than losing it:');
{
  ok(aclLib.displayBody({ kind: 'standard', action: 'permit', line: 'permit 10.9.9.9 0.0.0.9' }) === null,
    'the renderer declines an entry it cannot read');
  ok(aclLib.displayBody({ kind: 'extended', action: 'permit', protocol: 'ip',
    source: { ip: '0.0.0.0', wildcard: '255.255.255.255', any: true },
    destination: { ip: '0.0.0.0', wildcard: '255.255.255.255', any: true } }) === null,
    'and declines an extended entry, which this question did not settle');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
