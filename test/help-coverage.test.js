'use strict';
// help-coverage.test.js — the help page and the parser must not drift apart.
// A command the parser accepts but help omits is undiscoverable; a line held in
// place by hand-typed spaces drifts the moment a command grows. This reads the
// mode dispatchers in engine/cli.js, collects every `head === '…'` token, and
// requires each one to appear in that mode's own help.
const fs = require('fs');
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'engine', 'cli.js'), 'utf8');

function methodBody(name) {
  const start = SRC.indexOf('  ' + name + '(');
  if (start < 0) throw new Error('method not found in engine/cli.js: ' + name);
  const end = SRC.indexOf('\n  }', start);
  if (end < 0) throw new Error('unterminated method: ' + name);
  return SRC.slice(start, end);
}
function acceptedHeads(body) {
  const out = new Set();
  const re = /head === '([^']+)'/g;
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return out;
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const t = new Topology();
const r = t.addDevice(catalog.find(function (x) { return x.model === 'generic-router'; }));
r.name = 'R1';
const sim = new Simulator(t);

function helpOf(commands) {
  return runCommands(r, t, sim, commands).lines
    .filter(function (l) { return !/^[A-Za-z0-9._()\/-]*[>#]/.test(l); });
}

// The page *this* device is shown is filtered by capability: a router is not offered `switchport`
// or `spanning-tree`, because it cannot use them. So "documented" here means documented for some
// device - the unfiltered page - and the filtered page is checked to be a subset of it, never a
// place where a row can be invented.
function everyHelpOf(commands) {
  const s = new CliSession(r, t, sim);
  for (const c of commands.slice(0, -1)) s.run(c);
  return s._helpPage().filter(function (l) { return !/^[A-Za-z0-9._()\/-]*[>#]/.test(l); });
}

const MODES = [
  { name: 'exec', method: 'run', cmd: ['enable', '?'], label: 'Available commands:' },
  { name: 'config', method: '_configMode', cmd: ['enable', 'configure terminal', '?'], label: 'Config-mode commands' },
  { name: 'interface', method: '_ifaceMode', cmd: ['enable', 'configure terminal', 'interface Gi0/0', '?'], label: 'Interface-mode commands (Gi0/0)' },
  { name: 'dhcp pool', method: '_dhcpPoolMode', cmd: ['enable', 'configure terminal', 'ip dhcp pool LAB', '?'], label: 'DHCP pool commands (LAB)' }
];

// `!` is a comment line, not a command an operator types to do something.
const ALLOWED = ['!'];

console.log('Every command a mode dispatches on is listed in that mode\'s help:');
for (const mode of MODES) {
  const heads = Array.from(acceptedHeads(methodBody(mode.method))).sort();
  const text = everyHelpOf(mode.cmd).join('\n');
  const missing = heads.filter(function (h) {
    return ALLOWED.indexOf(h) === -1 && text.toLowerCase().indexOf(h.toLowerCase()) === -1;
  });
  ok(missing.length === 0, mode.name + ': all ' + heads.length + ' accepted commands are documented' +
    (missing.length ? ' — missing ' + missing.join(', ') : ''));
  ok(text.indexOf(mode.label) !== -1, mode.name + ': the list opens by naming the mode');
  // Capability filtering may hide a row from a device that cannot use it, and must never add one.
  const shown = helpOf(mode.cmd);
  const invented = shown.filter(function (l) { return /^ {2}\S/.test(l) && text.indexOf(l) === -1; });
  ok(invented.length === 0, mode.name + ': the filtered page is a subset of the whole one' +
    (invented.length ? ' — invented ' + invented.slice(0, 2).join(' | ') : ''));
}

console.log('\nHelp rows are built, not hand-padded:');
{
  const body = methodBody('_helpPage');
  // A row written as a literal that starts with two spaces is held in place by
  // typing spaces; helpLine() pads to a column instead, so they cannot drift.
  const handPadded = (body.match(/'  [A-Za-z<]/g) || []).length;
  ok(handPadded === 0, 'no help row is a hand-padded string literal (' + handPadded + ' found)');
  ok(/helpLine\(/.test(body), 'the rows go through helpLine()');
}

console.log('\n`help` and `?` are the same list in every mode:');
for (const mode of MODES) {
  const viaMark = helpOf(mode.cmd).join('\n');
  const viaWord = helpOf(mode.cmd.map(function (c) { return c === '?' ? 'help' : c; })).join('\n');
  ok(viaMark === viaWord, mode.name + ': help and ? agree');
}

console.log('\nA description is never glued to the command it explains:');
{
  // The defect this catches: a command longer than the help column used to have its
  // description printed with no separating space at all - "…[sport <n>]start a
  // conversation from here". Every command ends in ">", "]" or a word, so a letter
  // directly against one of those is the signature.
  const glued = [];
  for (const mode of MODES) {
    for (const l of helpOf(mode.cmd)) {
      if (/\][a-z]/.test(l) || />[a-z]/.test(l)) glued.push(mode.name + ': ' + l.trim().slice(0, 60));
    }
  }
  ok(glued.length === 0, 'no help line runs a description straight on from a command' +
    (glued.length ? ' - ' + glued.join(' | ') : ''));
}

console.log('\nA command too long for the column keeps its description on the next line:');
{
  const lines = helpOf(['enable', '?']);
  // Two rows are long enough to wrap; both must wrap the same way, at the same column.
  for (const row of [/^ {2}flow open <dst>/, /^ {2}ping <dst> /]) {
    const at = lines.findIndex(function (l) { return row.test(l); });
    ok(at !== -1, 'the long row ' + row.source + ' is there');
    const next = lines[at + 1] || '';
    ok(/^ {45}\S/.test(next),
      'and its description sits under it, at the same column as every other description');
  }
}

console.log('\nDescriptions line up in one column:');
{
  // The FIRST run of two or more spaces is the padding that separates a command
  // from its description. (A description may contain a double space of its own -
  // "declare a VLAN  (no vlan <id>)" - so the match must be non-greedy.)
  const cols = {};
  for (const mode of MODES) {
    const rows = helpOf(mode.cmd).filter(function (l) { return /^  \S/.test(l); });
    for (const l of rows) {
      const m = /^( {2}\S.*?)( {2,})(\S.*)$/.exec(l);
      if (!m) continue;                      // command longer than the column
      const at = m[1].length + m[2].length;
      if (!cols[at]) cols[at] = [];
      cols[at].push(mode.name + ': ' + l.trim().slice(0, 40));
    }
  }
  const positions = Object.keys(cols).map(Number);
  const total = positions.reduce(function (n, k) { return n + cols[k].length; }, 0);
  ok(total > 20, 'there are rows with descriptions to measure (' + total + ')');
  ok(positions.length === 1, 'every description starts at the same column' +
    (positions.length === 1 ? ' (' + positions[0] + ')' :
      ' - found ' + positions.map(function (p) { return p + ': ' + cols[p].slice(0, 2).join(' | '); }).join('; ')));
}

console.log('\nThe show list names the commands that answer "what is happening":');
{
  const exec = helpOf(['enable', '?']).join('\n');
  const shows = ['show ip route', 'show running-config', 'show ip ospf', 'show ip dhcp binding',
    'show power inline', 'show scion paths', 'show dns', 'show ipv6 nd', 'show lldp',
    'show ip nat translations', 'show ip nat statistics', 'show flows'];
  const absent = shows.filter(function (s) { return exec.indexOf(s) === -1; });
  ok(absent.length === 0, 'each of the ' + shows.length + ' show commands is discoverable' +
    (absent.length ? ' — missing ' + absent.join(', ') : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
