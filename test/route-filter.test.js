'use strict';
// route-filter.test.js — one protocol's routes, and how much of the table actually forwards.
//
// Reading a full table to find the OSPF rows is what an operator does when the filter is missing.
// `show ip route ospf` (also `connected`, `static`, `bgp`) selects them, and `show ip route summary`
// counts them — which is the only place the difference between "in the table" and "installed" is a
// number you can read without counting stars.
//
// Both answers come from `routesTable()`, so they cannot disagree with the table they summarise, and
// this file checks that: the summary's totals are compared with a count taken off the rendered table
// itself, and every filtered row must be a row the unfiltered table also shows.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { Device } = require('../engine/device');
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

// R1 -- R2. R1 has two static routes; R2 advertises 10.0.99.0/24 (which R1 also has statically,
// so that prefix is shadowed) and 10.0.77.0/24 (OSPF only).
const t = new Topology();
const r1 = t.addDevice(catalog('generic-router'));
const r2 = t.addDevice(catalog('generic-router'));
function catalog(model) {
  const found = loadCatalog(path.join(__dirname, '..', 'devices')).find((x) => x.model === model);
  if (!found) throw new Error('no such model: ' + model);
  return found;
}
r1.name = 'R1'; r2.name = 'R2';
t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
const sim = new Simulator(t);
function raw(cmds) {
  return runCommands(r1, t, sim, ['enable'].concat(cmds)).lines.filter(function (l) {
    return !/^[A-Za-z0-9_.() -]+[>#]/.test(l);
  });
}
function cli(cmds) { return raw(cmds).join('\n'); }

const cfg1 = ['enable', 'configure terminal', 'ospf router-id 1.1.1.1', 'ospf area 0',
  'interface Gi0/0', 'ip address 10.0.12.1 255.255.255.0', 'ip ospf area 0', 'exit',
  'ip route 10.0.99.0 255.255.255.0 10.0.12.2',
  'ip route 10.8.0.0 255.255.0.0 10.0.12.2', 'exit'];
const cfg2 = ['enable', 'configure terminal', 'ospf router-id 2.2.2.2', 'ospf area 0',
  'interface Gi0/0', 'ip address 10.0.12.2 255.255.255.0', 'ip ospf area 0', 'exit',
  'interface Gi0/1', 'ip address 10.0.99.1 255.255.255.0', 'ip ospf area 0', 'exit',
  'interface Gi0/2', 'ip address 10.0.77.1 255.255.255.0', 'ip ospf area 0', 'exit', 'exit'];
ok(!runCommands(r1, t, sim, cfg1).lines.some((l) => /^%/.test(l)), 'the R1 half of the lab is accepted');
ok(!runCommands(r2, t, sim, cfg2).lines.some((l) => /^%/.test(l)), 'and the R2 half');
cli(['show ip route at converged']);

// The full table, parsed independently of the filter code: these counts are the truth the summary
// is checked against.
function tableRows() {
  const out = [];
  for (const line of cli(['show ip route']).split('\n')) {
    const m = /^ *(\*?) +([CSOB]) (\S+\/\d+) +(\d+) +(\S+) +(\S+)$/.exec(line);
    if (m) out.push({ star: m[1] === '*', code: m[2], prefix: m[3], ad: m[4], gw: m[5], iface: m[6] });
  }
  return out;
}

console.log('A protocol selector returns that protocol\'s rows:');
{
  const all = tableRows();
  const codes = { ospf: 'O', static: 'S', connected: 'C' };
  for (const word of Object.keys(codes)) {
    const out = cli(['show ip route ' + word]);
    const rows = [];
    for (const line of out.split('\n')) {
      const m = /^ *(\*?) +([CSOB]) (\S+\/\d+) +(\d+) +(\S+) +(\S+)$/.exec(line);
      if (m) rows.push({ star: m[1] === '*', code: m[2], prefix: m[3] });
    }
    ok(rows.length > 0, word + ': the filter returns rows (' + rows.length + ')');
    ok(rows.every((r) => r.code === codes[word]),
      word + ': and every row is a ' + word + ' row, not just the first');
    const expected = all.filter((r) => r.code === codes[word]).length;
    eq(rows.length, expected, word + ': the count matches the unfiltered table (' + expected + ')');
    // Nothing invented and nothing dropped: each filtered row appears in the full table.
    for (const r of rows) {
      ok(all.some((a) => a.prefix === r.prefix && a.code === r.code && a.star === r.star),
        word + ': ' + r.code + ' ' + r.prefix + ' is the same row the full table shows');
    }
  }
}

console.log('\nThe selector is case-insensitive and reports its own totals:');
{
  const lower = cli(['show ip route ospf']);
  eq(cli(['show ip route OSPF']).toLowerCase(), lower.toLowerCase(), 'OSPF and ospf agree');
  match(/^2 OSPF routes, 1 installed$/m, lower,
    'the total names the protocol properly and separates rows from installed ones');
  const statics = cli(['show ip route static']);
  match(/^2 static routes, 2 installed$/m, statics, 'a protocol with nothing shadowed says so by the numbers');
  const one = cli(['show ip route connected']);
  match(/^1 connected route, 1 installed$/m, one, 'and a single row is singular in the sentence too');
}

console.log('\nA protocol that is not there says which ones are:');
{
  const out = cli(['show ip route bgp']);
  eq(out.split('\n')[0], '% No BGP routes in the table', 'an absent protocol is a refusal, not a blank table');
  match(/^% Codes present: connected, static, OSPF$/m, out,
    'and it names the codes that are present instead of only what is missing');
}

console.log('\nThe summary counts routes and installed routes:');
{
  const out = cli(['show ip route summary']);
  match(/^Route summary$/m, out, 'the answer is headed');
  match(/^ {2}Protocol +Routes +Installed$/m, out, 'with counted columns');
  const all = tableRows();
  const perCode = { C: 'connected', S: 'static', O: 'ospf', B: 'bgp' };
  for (const code of ['C', 'S', 'O']) {
    const rows = all.filter((r) => r.code === code);
    const up = rows.filter((r) => r.star).length;
    const line = out.split('\n').filter((l) => l.indexOf('  ' + perCode[code]) === 0)[0] || '';
    const cells = line.trim().split(/ {2,}/);
    eq(cells[1], String(rows.length), perCode[code] + ': the route count matches the table');
    eq(cells[2], String(up), perCode[code] + ': and so does the installed count');
  }
  const total = out.split('\n').filter((l) => l.trim().indexOf('total') === 0)[0].trim().split(/ {2,}/);
  eq(total[1], String(all.length), 'the total is every row in the table');
  eq(total[2], String(all.filter((r) => r.star).length), 'and the installed total is every starred row');
  match(/1 route shadowed by a lower administrative distance/m, out,
    'a shadowed route is called out, because that is the number the table cannot show');
}

console.log('\nFilters and the summary respect the instant:');
{
  const early = cli(['show ip route summary at 0']);
  match(/^Routes at t=0 ms/m, early, 'the instant label leads the summary too');
  const earlyTotal = early.split('\n').filter((l) => l.trim().indexOf('total') === 0)[0]
    .trim().split(/ {2,}/);
  const now = cli(['show ip route summary at converged']);
  const nowTotal = now.split('\n').filter((l) => l.trim().indexOf('total') === 0)[0]
    .trim().split(/ {2,}/);
  ok(Number(earlyTotal[1]) < Number(nowTotal[1]),
    'before convergence there are fewer routes than after (' + earlyTotal[1] + ' < ' + nowTotal[1] + ')');
  const earlyOspf = cli(['show ip route ospf at 0']);
  eq(earlyOspf.split('\n')[1], '% No OSPF routes in the table',
    'and the OSPF filter finds none at t=0, under the label');
  cli(['show ip route at converged']);   // leave the lab converged for the checks below
}

console.log('\nA destination is still a destination, not a selector:');
{
  // The selector words are matched before the address forms, so an address can never be read as a
  // protocol and vice versa.
  const lookup = cli(['show ip route 10.0.99.5']);
  match(/^ {2}Matched +10\.0\.99\.0\/24 {2}\(static, AD 1\)$/m, lookup,
    'an address still produces the longest-match answer');
  match(/^% Invalid destination: ospff$/m, cli(['show ip route ospff']),
    'and a near-miss protocol word is refused as a destination, not silently filtered');
  match(/^% Invalid destination: summery$/m, cli(['show ip route summery']),
    'the same for a near-miss of summary');
}

console.log('\nThe empty table is not a crash:');
{
  const fresh = new Topology();
  const lone = fresh.addDevice(catalog('generic-router'));
  lone.name = 'R9';
  const freshSim = new Simulator(fresh);
  const out = runCommands(lone, fresh, freshSim, ['enable', 'show ip route summary']).lines.join('\n');
  match(/% The routing table is empty/, out, 'a device with no routes says the table is empty');
  const filtered = runCommands(lone, fresh, freshSim, ['enable', 'show ip route ospf']).lines.join('\n');
  match(/% No OSPF routes in the table/, filtered, 'and a filter on it refuses with the same clarity');
  match(/% Codes present: \(none\)/, filtered, 'naming "none" rather than printing nothing');
}

console.log('\nThe command is discoverable:');
{
  const help = cli(['?']);
  match(/show ip route \[<dest>\|connected\|static\|ospf\|bgp\|summary\] \[at <ms>\|converged\]/,
    help, 'help lists every selector, the destination and the instant in one row');
}

console.log('\nADMIN_DISTANCE is still the one table of distances:');
{
  ok(typeof Device.ADMIN_DISTANCE.ospf === 'number', 'the distances are importable, not literals in a command');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
