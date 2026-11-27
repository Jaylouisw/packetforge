'use strict';
// Where the columns of `show ip arp` sit.
//
// The table exists to be read down: `Hardware Addr` over a hardware address, `Type` over `ARPA`, the interface
// under its own heading. A row a few columns off its headings is a row an operator cannot compare against a
// box, and this table's last two columns were two and three columns right of the words above them.
//
// The widths come from captures whose spaces survived the trip off the console. A typeset document is not
// evidence here: the same sample set into a PDF or an HTML page reflows the gaps, and the samples recovered
// from Cisco's own PDFs disagree with each other by up to four columns for that reason alone.
//
//   Protocol  Address          Age (min)  Hardware Addr   Type   Interface
//   Internet  10.10.20.28             7   0050.56bf.490f  ARPA   GigabitEthernet1
//   Internet  192.168.2.1            -    bbbb.bbbb.bbbb  ARPA   GigabitEthernet1/0/1
//
// Sources (both byte-exact pastes, in unrelated repositories, on unrelated images):
//   ZainE-net/network-code-samples, "Sample ARP Table CLI output"
//     https://raw.githubusercontent.com/ZainE-net/network-code-samples/main/README.md
//   ktbyers/netmiko issue #3386, the `show ip arp` output the reporter pasted
//     https://github.com/ktbyers/netmiko/issues/3386
// Both print a 70-character heading with `Hardware Addr` in column 38, `Type` in 54 and `Interface` in 61 -
// so the five fixed fields are 10, 17, 11, 16 and 7 wide, and the age is the one cell written right-aligned
// (a `-`, a one-digit and a two-digit age all end in the same column).
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return s.model === 'ISR 4331'; })[0];
const HOST = catalog.filter(function (s) { return s.model === 'Raspberry Pi 5'; })[0];

// The capture's own heading, character for character.
const CAPTURE = 'Protocol  Address          Age (min)  Hardware Addr   Type   Interface';
const C = { hw: CAPTURE.indexOf('Hardware Addr'), type: CAPTURE.indexOf('Type'), iface: CAPTURE.indexOf('Interface') };
const AGE_LAST = 34;   // the column an age's last digit lands in, three short of the hardware address

function lab() {
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  t.addDevice(HOST, 'h1');
  t.connect('h1', 'eth0', 'r1', 'Gi0/0/0', { mediaId: '1000base-t', speedMbps: 1000 });
  function cli(dev, cmds) {
    const s = new CliSession(dev, t, new Simulator(t));
    for (const c of cmds) s.run(c);
  }
  cli(t.getDevice('r1'), ['enable', 'configure terminal', 'interface Gi0/0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end']);
  cli(t.getDevice('h1'), ['enable', 'configure terminal', 'interface eth0',
    'ip address 10.0.0.2 255.255.255.0', 'end']);
  return { t: t, r: t.getDevice('r1'), sim: new Simulator(t) };
}

function table(env) {
  return ((new CliSession(env.r, env.t, env.sim).run('show arp').output) || []).map(String);
}

function rowsOf(lines) {
  return lines.slice(1).filter(function (l) { return /^Internet\s/.test(l); });
}

console.log('The heading is the capture\'s, character for character');
{
  const env = lab();
  const lines = table(env);
  ok(lines[0] === CAPTURE, 'the six headings, one space where the capture has one', JSON.stringify(lines[0]));
  ok(lines[0].length === 70, 'seventy characters wide, as the capture is', String(lines[0].length));
  ok(C.hw === 38 && C.type === 54 && C.iface === 61,
    'Hardware Addr in 38, Type in 54, Interface in 61', JSON.stringify(C));
}

console.log('\nEvery row lands under them');
{
  const env = lab();
  env.sim.setRunTime(600000);
  env.sim.ping('r1', '10.0.0.2', { count: 1 });
  const lines = table(env);
  const head = lines[0];
  const rows = rowsOf(lines);
  ok(rows.length >= 1, 'the table has a row to read', JSON.stringify(rows));
  for (const row of rows) {
    const mac = /\d{4}\.[0-9a-f]{4}\.[0-9a-f]{4}/.exec(row);
    ok(!!mac && mac.index === C.hw, 'the hardware address starts in ' + C.hw, JSON.stringify(row));
    ok(row.indexOf('ARPA') === head.indexOf('Type'), 'ARPA sits under Type', JSON.stringify(row));
    const iface = /(GigabitEthernet|FastEthernet|Vlan|Ethernet)\S*$/.exec(row);
    ok(!!iface && iface.index === C.iface, 'and the interface under Interface', JSON.stringify(row));
    ok(row.indexOf('ARPA') + 4 + 3 === iface.index, 'three spaces after the type word', JSON.stringify(row));
  }
}

console.log('\nThe age is right-aligned, so - and 0 and 170 all end in one column');
{
  const env = lab();
  env.sim.setRunTime(600000);
  env.sim.ping('r1', '10.0.0.2', { count: 1 });
  // The table is read at three instants without another ping, so the only thing that changes is the silence.
  const seen = [];
  for (const minutes of [0, 5, 52, 170]) {
    env.sim.setRunTime(600000 + minutes * 60000);
    const rows = rowsOf(table(env));
    const row = rows.filter(function (l) { return l.indexOf('10.0.0.2') !== -1; })[0];
    if (!row) { ok(false, 'the neighbour is still in the table at ' + minutes + ' min'); continue; }
    const age = /^Internet\s+10\.0\.0\.2\s+(\S+)/.exec(row)[1];
    const end = row.indexOf(age, 17) + age.length - 1;
    seen.push(age);
    ok(end === AGE_LAST, 'age "' + age + '" ends in column ' + AGE_LAST, row + ' [ends in ' + end + ']');
  }
  ok(seen.join(',') === '0,5,52,170', 'the ages really were 0, 5, 52 and 170 minutes', seen.join(','));
}

console.log('\nA local address carries a hyphen, and it right-aligns with them');
{
  const env = lab();
  const rows = rowsOf(table(env));
  const local = rows.filter(function (l) { return l.indexOf('10.0.0.1') !== -1; })[0];
  ok(!!local, 'the box prints its own address', JSON.stringify(rows));
  ok(local && local.slice(AGE_LAST, AGE_LAST + 1) === '-', 'with a hyphen in the age column',
    JSON.stringify(local));
  ok(local && local.indexOf('-') === AGE_LAST, 'the hyphen is the age, not a dash in the interface name',
    JSON.stringify(local));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
