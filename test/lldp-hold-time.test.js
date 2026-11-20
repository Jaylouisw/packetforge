'use strict';
// A neighbour is not "here" for ever.
//
// Two switches and a host on an access port, all up. The host is discovered by LLDP, as it should be. Then the
// host's port is shut: it announces nothing, and nothing refreshes the record our switch holds.
//
// A real switch drops that record when the TTL the host advertised runs out. IEEE 802.1AB defines the Time To
// Live TLV as "the number of seconds that the recipient LLDP agent is to regard the information associated with
// this MSAP identifier to be valid" (8.5.4), and Cisco's defaults are `lldp timer` 30 s and `lldp holdtime`
// 120 s; the `Hold-time` column of `show lldp neighbors` repeats that advertised number rather than
// counting down - the countdown is `Time remaining`, a field of the detail view, not of the table
// (research/lldp-hold-time-column.md). This console had
// no instant on the record at all, so `show lldp neighbors` named a device that had been silent for as long as
// you cared to ask - at 600 s, five TTLs later, the row was still there.
//
// Nothing here invents a countdown the model cannot honour: an entry heard at an instant ages against the instant
// the question is asked at, and an entry with no instant (a fixture, an imported lab, a run at Infinity) is
// printed unaged rather than aged against a guess - the rule `show mac address-table` and `show arp` follow.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const lldp = require('../engine/lldp');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

// One switch, one host on an access port, and the instant the lab comes up.
function lab(atMs) {
  const t = new Topology();
  t.addDevice(SWITCH, 's1'); t.addDevice(PC, 'a');
  t.connect('a', 'eth0', 's1', 'Fa0/2');
  const sim = new Simulator(t);
  if (Number.isFinite(atMs)) sim.setRunTime(atMs);
  sim.refreshNeighbours();                      // the call the board makes when a cable is plugged in
  const cli = new CliSession(t.getDevice('s1'), t, sim);
  return {
    t: t, sim: sim, cli: cli,
    show: function (cmd) { return cli.run(cmd).output; },
    row: function (name) {
      return this.show('show lldp neighbors').filter(function (l) { return l.indexOf(name) !== -1; })[0] || '';
    },
    shutHost: function () {
      const hostCli = new CliSession(t.getDevice('a'), t, sim);
      hostCli.run('configure terminal');
      hostCli.run('interface eth0');
      hostCli.run('shutdown');
      hostCli.run('end');
    }
  };
}

console.log('A neighbour that stops announcing is dropped when its TTL lapses:');
{
  const L = lab(0);
  ok(L.row('PC-a') !== '', 'the host is discovered at t=0', L.show('show lldp neighbors').join(' | '));
  const rec = L.t.getDevice('s1').lldp.get('Fa0/2');
  ok(rec && rec.ttl === 120, 'the record carries the 120 s TTL the host advertised', rec && String(rec.ttl));
  const seen = L.t.getDevice('s1').lldpSeenAt.get('Fa0/2');
  ok(seen === 0, 'and the instant it was heard, kept beside the record so it can be aged', String(seen));
  ok(!('atMs' in rec), 'which the record itself does not carry: a clock reading is not something the far end advertised',
    JSON.stringify(Object.keys(rec)));

  L.shutHost();                                  // silent from here on: nothing refreshes the record
  L.sim.setRunTime(119000);
  ok(L.row('PC-a') !== '', 'at 119 s - still inside the hold-time - the row is listed',
    L.show('show lldp neighbors').join(' | '));

  L.sim.setRunTime(121000);
  ok(L.row('PC-a') === '', 'at 121 s the hold-time has lapsed and the row is gone: a silent neighbour is not a neighbour',
    L.show('show lldp neighbors').join(' | '));
  const empty = L.show('show lldp neighbors').join('\n');
  ok(/gone past the hold-time it advertised/.test(empty),
    'and the empty table says the hold-time ran out rather than "no LLDP has been heard", which would be false',
    empty);
}

console.log('');
console.log('A fresh LLDPDU brings the neighbour back:');
{
  const L = lab(0);
  L.shutHost();
  L.sim.setRunTime(121000);
  ok(L.row('PC-a') === '', 'gone at 121 s', L.show('show lldp neighbors').join(' | '));
  const hostCli = new CliSession(L.t.getDevice('a'), L.t, L.sim);
  hostCli.run('configure terminal'); hostCli.run('interface eth0'); hostCli.run('no shutdown'); hostCli.run('end');
  L.sim.refreshNeighbours();                     // announcements go out again, at the instant the run is at
  ok(L.row('PC-a') !== '', 'a new announcement lists the neighbour again at once',
    L.show('show lldp neighbors').join(' | '));
  const seen = L.t.getDevice('s1').lldpSeenAt.get('Fa0/2');
  ok(seen === 121000, 'with the new reception instant, not the old one', String(seen));
  L.sim.setRunTime(241000);
  ok(L.row('PC-a') !== '', 'and it is still good 120 s later, because the refresh reset the clock',
    L.show('show lldp neighbors').join(' | '));
  L.sim.setRunTime(242000);
  ok(L.row('PC-a') === '', 'and gone 121 s after that refresh', L.show('show lldp neighbors').join(' | '));
}

console.log('');
console.log('What must not change:');
{
  // A run with no named instant (Infinity) has no clock, so nothing is aged - the answer a fixture and the UI
  // get, and the one the existing "shut port does not forget the neighbour" test relies on.
  const L = lab(null);
  L.shutHost();
  L.sim.refreshNeighbours();
  ok(L.t.getDevice('s1').lldpSeenAt.has('Fa0/2') === false, 'with no clock nothing is dated, so nothing can be aged');
  L.sim.setRunTime(900000);
  const row = L.row('PC-a');
  ok(row !== '' && /down/.test(row), 'and an unaged neighbour is still listed, marked as down rather than deleted', row.trim());
}
{
  // A record written by an older caller (no instant at all) is printed, not silently hidden.
  const L = lab(0);
  const s1 = L.t.getDevice('s1');
  s1.lldpSeenAt.delete('Fa0/2');
  L.sim.setRunTime(600000);
  ok(L.row('PC-a') !== '', 'an entry with no reception instant is not aged against a guess',
    L.show('show lldp neighbors').join(' | '));
}
{
  // A TTL of 0 is 802.1AB's "this MSAP identifier is no longer valid", not "unset": it must not turn into 120 s.
  const frame = lldp.buildFrame({ config: { hostname: 'h' }, name: 'h', label: 'h', id: 'h' },
    { name: 'eth0', mac: '02:00:00:00:00:01' }, { ttl: 1 });
  frame.lldp.ttl = 0;
  const nb = lldp.neighbourFrom(frame, 'Fa0/2', 0);
  ok(nb.ttl === 0, 'a received TTL of 0 is kept as 0, not replaced by the 120 s default', String(nb.ttl));
  const L = lab(0);
  const s1 = L.t.getDevice('s1');
  s1.lldp.set('Fa0/2', nb);
  const rows = s1.lldpRows(L.t, 0);
  ok(rows.length === 0, 'and such an entry is dropped at once, at any instant', JSON.stringify(rows));
}
{
  // The table is still one row per port for a lab that has heard something.
  const L = lab(0);
  const rows = L.t.getDevice('s1').lldpRows(L.t, 0);
  ok(rows.length === 1 && rows[0].port === 'Fa0/2' && rows[0].holdTimeS === 120,
    'a live row still carries its port, its neighbour and the hold-time it was given',
    JSON.stringify(rows));
  const lines = L.show('show lldp neighbors');
  ok(lines[0] === 'Capability codes:' && /^Device ID/.test(lines[4]),
    'and the view keeps the box\'s shape (legend, blank line, header)', lines.join(' | '));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
