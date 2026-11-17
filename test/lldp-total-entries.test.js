'use strict';
// `show lldp neighbors` ends with a count, and its number is the rows the view printed.
//
// The table this console prints is its own - Neighbour, Local port, Port ID, Mgmt address - but the sentence
// under it is the vendor's, and it is the one line that answers "how many neighbours are there" without
// counting them by eye. A Catalyst's own configuration example ends the view with it:
//
//   Switch#show lldp neighbors
//   Capability codes:
//       (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device
//       (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other
//   Device ID Local Intf Hold-time Capability Port ID
//   Nortel IP Phone Gi1/0/1 180 T 0019.e1e7.018d
//   ...
//   Total entries displayed: 4
//
// (Cisco, "Catalyst 3750/3750-E/3750-X Series Switches Using LLDP Configuration Example",
// https://www.cisco.com/c/en/us/support/docs/switches/catalyst-3750-series-switches/113397-lldp-3750-switch-00.html).
// NX-OS prints the same sentence (Nexus 3500 LLDP commands, Total entries displayed: 45), and so does IOS XR,
// so it is the view's closing line rather than one platform's habit. `show mac address-table` already closes
// its own table with a count of the rows printed for the criterion asked
// (research/mac-table-surround.md); this is the same rule for the neighbour view.
// research/lldp-total-entries.md records the evidence, and the half of the question the sources do not
// answer: what a box with nothing heard prints.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

const TOTAL = /^Total entries displayed: ([0-9]+)$/;

// s1 -- s2 on Fa0/1, s1 -- a on Fa0/2. Every row is a neighbour that really announced itself on the wire;
// nothing is read from the topology file.
function lab(withHost) {
  const t = new Topology();
  t.addDevice(SWITCH, 's1');
  t.addDevice(SWITCH, 's2');
  if (withHost !== false) t.addDevice(PC, 'a');
  t.connect('s1', 'Fa0/1', 's2', 'Fa0/1');
  if (withHost !== false) t.connect('a', 'eth0', 's1', 'Fa0/2');
  const sim = new Simulator(t);
  sim.setRunTime(1000);
  sim.refreshNeighbours();                 // the call a board makes when a cable is plugged in
  const cli = new CliSession(t.getDevice('s1'), t, sim);
  return { t: t, sim: sim, cli: cli };
}

function lines(env, cmd) {
  return (env.cli.run(cmd || 'show lldp neighbors').output || []).map(String);
}

// The rows are what sits between the column heading and the count: not the heading itself, not the bracketed
// empty-state prose.
function rowsOf(out) {
  const at = out.findIndex(function (l) { return /^ {2}Neighbour /.test(l); });
  if (at === -1) return [];
  return out.slice(at + 1).filter(function (l) {
    return /^ {2}\S/.test(l) && !/^ {2}\(/.test(l) && !TOTAL.test(l);
  });
}

function totalOf(out) {
  const line = out.filter(function (l) { return TOTAL.test(l); })[0];
  const hit = line ? line.match(TOTAL) : null;
  return hit ? { line: line, n: Number(hit[1]) } : null;
}

function linkAt(env, deviceId, port) {
  return [...env.t.links.values()].filter(function (l) {
    return (l.a.deviceId === deviceId && l.a.iface === port) ||
      (l.b.deviceId === deviceId && l.b.iface === port);
  })[0];
}

console.log('The view ends with the count, and the count is the rows it printed:');
{
  const env = lab();
  const out = lines(env);
  const rows = rowsOf(out);
  const total = totalOf(out);
  ok(rows.length === 2, 'two neighbours are listed', JSON.stringify(rows));
  ok(!!total, 'the table ends with a count line', out.join(' | '));
  ok(!!total && total.n === rows.length, 'and its number is the rows printed, not a guess',
    JSON.stringify({ total: total && total.n, rows: rows.length }));
  ok(!!total && out[out.length - 1] === total.line, 'the count is the last line of the view',
    out[out.length - 1]);
  ok(!!total && total.line === total.line.trim(),
    'it sits at the left margin, under the table rather than inside it', JSON.stringify(total && total.line));
  // No blank line between the last row and the count: the vendor transcript has none, and a blank there
  // would put the count outside the table it counts.
  ok(out[out.length - 2] === rows[rows.length - 1], 'nothing separates it from the last row',
    JSON.stringify(out.slice(-2)));
}

console.log('');
console.log('The number counts rows, so an empty table has no number to print:');
{
  const env = lab();
  // Both entries were heard at t=1000 with the default 120 s TTL, so both have lapsed at 121 s.
  env.sim.setRunTime(1000 + 121 * 1000);
  const out = lines(env);
  ok(rowsOf(out).length === 0, 'every neighbour has aged out', JSON.stringify(rowsOf(out)));
  ok(totalOf(out) === null,
    'and an empty table prints no count - no source shows an empty table, so none is invented',
    out.join(' | '));
  ok(/^ {2}\(none - every neighbour has gone past the hold-time/.test(out[out.length - 1]),
    'the empty state is the prose line that says why', out[out.length - 1]);
}

console.log('');
console.log('One neighbour reads 1, and the word stays plural:');
{
  const env = lab(false);
  const out = lines(env);
  const total = totalOf(out);
  ok(rowsOf(out).length === 1, 'one neighbour is listed', JSON.stringify(rowsOf(out)));
  ok(!!total && total.line === 'Total entries displayed: 1',
    'the vendor prints entries for a single row too', total && total.line);
}

console.log('');
console.log('Every spelling of the view ends the same way:');
{
  const env = lab();
  ['show lldp', 'show lldp neighbors', 'show lldp neighbours'].forEach(function (cmd) {
    const total = totalOf(lines(env, cmd));
    ok(!!total && total.n === 2, '"' + cmd + '" ends with the same count', JSON.stringify(total));
  });
}

console.log('');
console.log('A row for a port that has gone down is still a printed row, so it is still counted:');
{
  const env = lab();
  const link = linkAt(env, 's1', 'Fa0/1');
  ok(!!link, 'the s1-s2 link is addressable in the lab', JSON.stringify(link && link.id));
  if (link) env.sim.setLinkState(link.id, 'down');
  env.sim.refreshNeighbours();
  const out = lines(env);
  const total = totalOf(out);
  ok(rowsOf(out).length === 2, 'the entry stays until its hold-time lapses', JSON.stringify(rowsOf(out)));
  ok(!!total && total.n === rowsOf(out).length, 'so the count does not fall with the link',
    JSON.stringify({ total: total && total.n, rows: rowsOf(out).length }));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
