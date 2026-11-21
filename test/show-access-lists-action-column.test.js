'use strict';
// The action is a seven-column field on a standard line of `show access-lists`: `permit` plus one space,
// `deny` plus three, so the address starts in the same column on every line of the list.
//
// The table printed one space after either action, so a list read
//
//   Standard IP access list 1
//       10 permit 10.1.2.3 log
//       20 deny 10.1.1.1
//
// where the vendor's own material prints
//
//   Standard IP access list 1
//       10 permit 10.1.2.3 log
//       20 deny   10.1.1.1
//
// The decisive sample is one page of a Cisco Press certification chapter that prints a standard list and an
// extended list a few lines apart: `10 deny   192.168.11.0, wildcard bits 0.0.0.255 log (5 matches)` under
// `Standard IP access list STND-1`, and `10 deny ip 192.168.10.0 0.0.0.255 host 209.165.200.225 (4 matches)`
// under an extended one (Pearson sample chapter, 158713201X). Same book, same typesetting, two different
// spellings - so the pad is a standard-list rule, not a lost run of spaces in an HTML paste.
//
// The raw captures agree and draw the same line between the two kinds: `20 deny   10.1.1.1`, `30 deny
// 192.168.1.0, wildcard bits 0.0.0.255`, `40 deny   any log` in a standard list beside `20 deny ip any any`
// in an extended one (ntc-templates, cisco_ios_show_access-list.raw, cat -A). A NetAcad ACL deck and a
// university handout print the padded standard form too. research/show-access-lists-action-column.md has the
// sources and the one machine capture that disagrees.
//
// Extended lines are untouched: the renderer returns null for them and the console prints the typed text,
// which is one space, exactly what the same sources show.
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
  return { t: t, sim: sim, r: r, pc: pc, port: port };
}

function table(env, cmd) {
  return ((new CliSession(env.r, env.t, env.sim).run(cmd || 'show access-lists').output) || []).map(String);
}

function rules(lines) {
  return lines.filter(function (l) { return /^ {4}\d+ (?:permit|deny)/.test(l); });
}

const host = { ip: '10.1.1.1', wildcard: '0.0.0.0', host: true };
const net = { ip: '192.168.1.0', wildcard: '0.0.0.255' };
const any = { ip: '0.0.0.0', wildcard: '255.255.255.255', any: true };

console.log('');
console.log('The renderer puts both actions in the same seven columns:');
{
  ok(aclLib.displayBody({ kind: 'standard', action: 'permit', source: host }) === 'permit 10.1.1.1',
    'permit takes one space - six letters and the separator make seven',
    JSON.stringify(aclLib.displayBody({ kind: 'standard', action: 'permit', source: host })));
  ok(aclLib.displayBody({ kind: 'standard', action: 'deny', source: host }) === 'deny   10.1.1.1',
    'deny takes three, so its address lands under the permit lines\'',
    JSON.stringify(aclLib.displayBody({ kind: 'standard', action: 'deny', source: host })));
  ok(aclLib.displayBody({ kind: 'standard', action: 'deny', source: any, log: true }) === 'deny   any log',
    'and the pad is inside the field, ahead of the source, not after the line', 
    JSON.stringify(aclLib.displayBody({ kind: 'standard', action: 'deny', source: any, log: true })));
  const permitLine = aclLib.displayBody({ kind: 'standard', action: 'permit', source: net });
  const denyLine = aclLib.displayBody({ kind: 'standard', action: 'deny', source: net });
  ok(permitLine.indexOf('192.168.1.0') === denyLine.indexOf('192.168.1.0'),
    'the address column is the same whether the entry permits or denies',
    permitLine.indexOf('192.168.1.0') + ' vs ' + denyLine.indexOf('192.168.1.0'));
}

console.log('');
console.log('A standard list, line for line out of the Cisco Press sample:');
{
  const env = lab([
    'access-list 1 permit 10.1.2.3 log',
    'access-list 1 deny host 10.1.1.1',
    'access-list 1 deny 192.168.1.0 0.0.0.255',
    'access-list 1 deny any log'
  ]);
  const r = rules(table(env));
  ok(r.length === 4, 'all four entries are printed', r.join(' | '));
  ok(r[0] === '    10 permit 10.1.2.3 log', 'the permit keeps its single space', JSON.stringify(r[0]));
  ok(r[1] === '    20 deny   10.1.1.1', 'the host deny prints three spaces and its bare address',
    JSON.stringify(r[1]));
  ok(r[2] === '    30 deny   192.168.1.0, wildcard bits 0.0.0.255',
    'the network deny pads the same way and keeps the comma form', JSON.stringify(r[2]));
  ok(r[3] === '    40 deny   any log', 'and `any` sits in the same column as the addresses',
    JSON.stringify(r[3]));
  const starts = ['10.1.2.3', '10.1.1.1', '192.168.1.0', 'any']
    .map(function (needle, i) { return r[i].indexOf(needle); });
  ok(starts.every(function (c) { return c === starts[0]; }),
    'the four sources begin in one column, whatever the action and the sequence width',
    starts.join(' | '));
}

console.log('');
console.log('An extended list keeps one space after the action:');
{
  const env = lab([
    'access-list 101 permit ip any any',
    'access-list 101 deny icmp any any'
  ], 101);
  const r = rules(table(env));
  ok(r[0] === '    10 permit ip any any', 'permit is followed by the protocol after one space',
    JSON.stringify(r[0]));
  ok(r[1] === '    20 deny icmp any any', 'and deny is not padded here - the protocol follows one space',
    JSON.stringify(r[1]));
}

console.log('');
console.log('The same rendering is behind `show ip access-lists`:');
{
  const env = lab(['access-list 10 deny host 10.1.1.1']);
  const r = rules(table(env, 'show ip access-lists'));
  ok(r[0] === '    10 deny   10.1.1.1', 'the alias prints the padded line too', JSON.stringify(r[0]));
}

console.log('');
console.log('The configuration still echoes what was typed:');
{
  const env = lab(['access-list 10 deny host 10.1.1.1']);
  const cfg = runCommands(env.r, env.t, env.sim, ['show running-config']).lines.join('\n');
  ok(/access-list 10 deny host 10\.1\.1\.1/.test(cfg),
    'running-config keeps the typed `host`, not the rendered address', cfg);
  ok(!/deny   10\.1\.1\.1/.test(cfg), 'and carries none of the display padding', cfg);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
