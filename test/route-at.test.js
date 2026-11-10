'use strict';
// route-at.test.js — the route table as one token per destination, and as a question about time.
//
// Two changes, one command:
//
//   * `show ip route` printed `C  10.0.1.0       /24`, the mask detached into its own column by a
//     hand-typed 15-wide field. A reader copies `10.0.1.0` and gets `10.0.1.0`, not the route.
//     The prefix belongs to the destination, so it is printed attached - and the column is still
//     aligned, with its width now measured from the data rather than typed.
//   * `show ip route` prints the table *as last computed*, which is honest but only answers half
//     the question. `show ip route at <ms>` rebuilds the control planes at that instant first, so
//     "what routes exist at t=0, before OSPF has converged?" has an answer, and the answer says
//     which instant it is.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) +
    ', want ' + JSON.stringify(expected) + ')'));
}
function match(re, text, msg) {
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text) + ')'));
}

// A parsed route row. Positional cell indices are not safe: the marker column is empty on a
// shadowed row, so a starred row has five cells and an unstarred one four. Fields do not shift.
const ROW_RE = /^ *(\*?) +([CSOB]) (\S+\/\d+) +(\d+|-) +(\S+) +(\S+)$/;
function rowWith(text, needle) {
  for (const line of text.split('\n')) {
    const m = ROW_RE.exec(line);
    if (m && line.indexOf(needle) !== -1) {
      return { star: m[1] === '*', code: m[2], prefix: m[3], ad: m[4], gw: m[5], iface: m[6] };
    }
  }
  return null;
}
function routeRows(text) {
  return text.split('\n').filter(function (l) { return ROW_RE.test(l); });
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const model = (n) => catalog.find((x) => x.model === n);

// R1 -- R2, with a static route covering 10.0.99.0/24 on R1's side and the real network on R2,
// so the OSPF route both appears late and competes with the static one.
const t = new Topology();
const r1 = t.addDevice(model('generic-router'));
const r2 = t.addDevice(model('generic-router'));
r1.name = 'R1'; r2.name = 'R2';
t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
const sim = new Simulator(t);
function run(dev, cmds) {
  return runCommands(dev, t, sim, cmds).lines.filter(function (l) {
    return !/^[A-Za-z0-9_.()-]+[>#]/.test(l);
  });
}
function cli(dev, cmds) { return run(dev, ['enable'].concat(cmds)).join('\n'); }

run(r1, ['configure terminal', 'interface Gi0/0', 'ip address 10.0.12.1 255.255.255.0',
  'exit', 'ip route 10.0.99.0 255.255.255.0 10.0.12.2', 'ospf router-id 1.1.1.1', 'ospf area 0', 'exit']);
run(r2, ['configure terminal', 'interface Gi0/0', 'ip address 10.0.12.2 255.255.255.0',
  'exit', 'interface Gi0/1', 'ip address 10.0.99.1 255.255.255.0',
  'exit', 'interface Gi0/2', 'ip address 10.0.77.1 255.255.255.0',
  'exit', 'ospf router-id 2.2.2.2', 'ospf area 0', 'exit']);

console.log('The prefix is part of the destination:');
{
  const table = cli(r1, ['show ip route']);
  const connected = rowWith(table, 'C 10.0.12.0/24');
  ok(!!connected, 'a connected route prints as one token plus its mask');
  eq(connected && connected.prefix, '10.0.12.0/24', 'the code and the prefix are one cell');
  eq(connected && connected.code, 'C', 'with the connected code');
  eq(connected && connected.ad, '0', 'and its administrative distance');
  ok(!/10\.0\.12\.0\s+\/24/.test(table), 'the mask is not parked in a column of its own');
  // Anything a reader could copy as a destination must parse as a prefix.
  const dests = (table.match(/\b\d+\.\d+\.\d+\.\d+\/\d+\b/g) || []);
  ok(dests.length >= 2, 'every row yields a copyable prefix (' + dests.join(', ') + ')');
  ok(dests.every(function (d) { return /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(d); }),
    'and each one is address and length, not two tokens');
}

console.log('\nThe column is measured, not typed:');
{
  // A /32 destination is longer than a /24 one; both must still land in five cells. A glued
  // column merges two values and changes the count, which is the failure this measures.
  run(r1, ['enable', 'configure terminal', 'ip route 255.255.255.255 255.255.255.255 10.0.12.2', 'exit']);
  const table = cli(r1, ['show ip route']);
  const headerLine = table.split('\n').filter(function (l) { return /Prefix/.test(l); })[0] || '';
  const header = headerLine.trim().split(/ {2,}/);
  eq(header.length, 5, 'the header has five columns (' + header.join('|') + ')');
  eq(header[3], 'Gateway', 'the third is the gateway - the word "via" is gone');
  eq(header[4], 'Interface', 'and the fourth the interface');
  const rows = routeRows(table);
  ok(rows.length >= 3, 'the table has several rows (' + rows.length + ')');
  ok(rows.length >= 3 && rows.every(function (l) { return ROW_RE.test(l); }),
    'and every row parses into five fields, so no two values are glued');
  const wide = rowWith(table, '255.255.255.255/32');
  eq(wide && wide.prefix, '255.255.255.255/32', 'the widest destination of all still lines up');
  eq(wide && wide.ad, '1', 'with the static distance');
  run(r1, ['enable', 'configure terminal', 'no ip route 255.255.255.255 255.255.255.255', 'exit']);
}

console.log('\nThe table is what was last computed, and `at` says when:');
{
  const atZero = cli(r1, ['show ip route at 0']);
  match(/^Routes at t=0 ms \(control planes rebuilt for this answer\)$/m, atZero,
    'the answer names the instant it is about');
  ok(!rowWith(atZero, 'O 10.0.99.0/24'), 'before OSPF has converged there is no O row');
  ok(!/O - OSPF/.test(atZero), 'and the legend does not claim a code that is absent');

  const converged = cli(r1, ['show ip route at converged']);
  match(/^Routes at converged/m, converged, '"converged" is a legal instant');
  const ospf = rowWith(converged, 'O 10.0.99.0/24');
  ok(!!ospf, 'after convergence the OSPF route is there');
  eq(ospf && ospf.gw, '10.0.12.2', 'with the next hop it learned');
  eq(ospf && ospf.iface, 'Gi0/0', 'and the interface it learned it on');
  match(/O - OSPF/, converged, 'and the legend explains the O code');

  // Both candidates are listed; which one forwards is marked (see route-installed.test.js).
  const forPrefix = routeRows(converged).filter(function (l) {
    return l.indexOf('10.0.99.0/24') !== -1;
  });
  eq(forPrefix.length, 2, 'both routes for 10.0.99.0/24 are listed (' + forPrefix.length + ')');

  // The plain form keeps the last computed state rather than recomputing.
  const afterwards = cli(r1, ['show ip route']);
  ok(!/rebuilt for this answer/.test(afterwards), 'the plain form carries no instant label');
  ok(!!rowWith(afterwards, 'O '), 'and it still shows what the last computation left behind');
}

console.log('\nThe instant is validated:');
{
  eq(cli(r1, ['show ip route at']), '% Incomplete command: show ip route at <ms>|converged',
    'a bare "at" is refused with the form that works');
  eq(cli(r1, ['show ip route at abc']), '% Invalid instant: abc', 'garbage is refused by name');
  eq(cli(r1, ['show ip route at -1']), '% Invalid instant: -1', 'and so is a negative instant');
  eq(cli(r1, ['show ip route nonsense']).split('\n')[0], '% Invalid destination: nonsense',
    'a word is a malformed destination, refused by name rather than ignored');
}

console.log('\nThe two doors give the same answer about the same instant:');
{
  // `traceroute … at` and `show ip route at` both rebuild through Simulator.refreshControlPlanes(),
  // so at an instant before convergence neither can see the OSPF path, and after it both can.
  const trace0 = cli(r1, ['traceroute 10.0.77.1 at 0']);
  ok(/\*  \*  \*/.test(trace0), 'at t=0 the trace cannot reach a network only OSPF knows');
  const route0 = cli(r1, ['show ip route at 0']);
  ok(!rowWith(route0, 'O '), 'and the table agrees: no OSPF route yet');
  ok(!/10\.0\.77\.0/.test(route0), 'the OSPF-only network is absent from the table entirely');

  const traceC = cli(r1, ['traceroute 10.0.77.1 at converged']);
  ok(!/\*  \*  \*/.test(traceC), 'after convergence the trace completes');
  const routeC = cli(r1, ['show ip route at converged']);
  ok(!!rowWith(routeC, 'O '), 'and the table agrees again');
  const learned = rowWith(routeC, 'O 10.0.77.0/24');
  eq(learned && learned.gw, '10.0.12.2', 'with the OSPF-learned network present and its next hop named');
  eq(learned && learned.iface, 'Gi0/0', 'and the interface it leaves by');
}

console.log('\nThe command is discoverable:');
{
  const help = cli(r1, ['?']);
  match(/show ip route \[<dest>\|connected/, help,
    'help lists the destination and the protocol selectors');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
