'use strict';
// `show arp` has to say which port, and whether that neighbour is still there (#1253).
//
// The command printed a header with five columns and rows with three: the Interface column was a title over
// nothing, so the one table that tells you where a neighbour lives could not tell you. Everything after the
// MAC was missing:
//
//   Protocol  Address          Age (min)  Hardware Addr   Interface
//   Internet  10.0.0.9         -          02:00:00:00:02:00
//
// Worse, every entry was presented the same way whether the port it was learned on was up, shut, or had no
// cable - so a stale cache entry read as evidence that the address was reachable, which is exactly the
// belief someone is checking when they run this command.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const net = require('../engine/net');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];
const eth = function (d) {
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
};

// Two hosts on a switch: .9 and .10, deliberately out of numeric order against string order so the sort
// is visible.
function lab() {
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r1');
  const sw = t.addDevice(SWITCH, 'sw');
  const ten = t.addDevice(PC, 'ten');
  const nine = t.addDevice(PC, 'nine');
  t.connect('r1', eth(r)[0].name, 'sw', 'Fa0/1');
  t.connect('ten', 'eth0', 'sw', 'Fa0/2');
  t.connect('nine', 'eth0', 'sw', 'Fa0/3');
  const sim = new Simulator(t);
  runCommands(r, t, sim, ['configure terminal', 'interface ' + eth(r)[0].name,
    'ip address 10.0.0.1 255.255.255.0', 'end']);
  runCommands(ten, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.10 255.255.255.0', 'ip default-gateway 10.0.0.1', 'end']);
  runCommands(nine, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'ip default-gateway 10.0.0.1', 'end']);
  return { t: t, sim: sim, r: r, sw: sw, ten: ten, nine: nine };
}

function rows(env) {
  const lines = ((new CliSession(env.r, env.t, env.sim).run('show arp').output) || []).map(String);
  return {
    header: lines[0] || '',
    body: lines.slice(1),
    fields: lines.slice(1).map(function (l) { return l.trim().split(/\s+/); })
  };
}

console.log('');
console.log('Every learned neighbour is listed, and the Interface column holds something:');
{
  const env = lab();
  env.sim.ping('ten', '10.0.0.1', { count: 1 });
  env.sim.ping('nine', '10.0.0.1', { count: 1 });

  const out = rows(env);
  // Three rows: the router's own address (a local entry, age `-`) and the two neighbours it heard.
  ok(out.body.length === 3, "the two neighbours and the router's own address are listed", String(out.body.length));
  ok(out.fields.every(function (f) { return f.length === 6; }),
    'every row has as many columns as the header',
    out.fields.map(function (f) { return f.length; }).join(','));
  ok(/Interface/.test(out.header), 'the header still names the Interface column');

  // The port is the one the neighbour was heard on, not a guess: checked against what the engine recorded.
  const portOf = function (ip) { return env.r.arpPorts.get(ip); };
  const rowFor = function (ip) { return out.fields.filter(function (f) { return f[1] === ip; })[0] || []; };
  ok(rowFor('10.0.0.9')[5] === portOf('10.0.0.9'),
    'the interface printed is the port the engine learned it on',
    JSON.stringify({ printed: rowFor('10.0.0.9')[5], recorded: portOf('10.0.0.9') }));
  ok(portOf('10.0.0.9') === eth(env.r)[0].name,
    'and that port is the one facing the switch', String(portOf('10.0.0.9')));
  ok(rowFor('10.0.0.10')[5] === portOf('10.0.0.10'), 'for the other neighbour too');

  // The MAC column is the data plane's, not a decoration.
  // The value is the table's, printed the way the device prints a hardware address: 0200.0000.0900.
  ok(rowFor('10.0.0.9')[3] === net.formatMac(env.r.arp.get('10.0.0.9')),
    'the hardware address matches the table the engine uses',
    JSON.stringify({ printed: rowFor('10.0.0.9')[3], engine: env.r.arp.get('10.0.0.9') }));

  // The local entry: the address on the box itself, a hyphen where an age would be, the port's own MAC, and the
  // port's name - what a box prints for an address that is local rather than learned
  // (research/show-arp-local-address.md).
  ok(rowFor('10.0.0.1')[2] === '-', "the router's own address has a hyphen for its age", JSON.stringify(rowFor('10.0.0.1')));
  ok(rowFor('10.0.0.1')[3] === net.formatMac(eth(env.r)[0].mac),
    'and the hardware address of the port that holds it', JSON.stringify(rowFor('10.0.0.1')[3]));
  ok(rowFor('10.0.0.1')[5] === eth(env.r)[0].name, 'with the port named beside it', JSON.stringify(rowFor('10.0.0.1')[5]));

  ok(out.fields[0][1] === '10.0.0.1',
    'and the rows are in numeric address order (.1, .9, .10)',
    out.fields.map(function (f) { return f[1]; }).join(','));
}

console.log('');
console.log('The Type column sits between the hardware address and the interface:');
{
  // The vendor's field list under `show arp` names six fields - Protocol, Address, Age (min), Hardware Addr,
  // Type, Interface - and its own samples fill Type with ARPA (Ethernet), SNAP (RFC 1042) or SAP (802.3):
  // https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/show_ip_arp.htm
  // This table printed five, so a row could not be lined up against a box's and the encapsulation was simply
  // absent. ARPA is the only value this model can print: SNAP and SAP are encap on Token Ring/FDDI, and the
  // catalogue has no such port.
  const env = lab();
  env.sim.ping('nine', '10.0.0.1', { count: 1 });
  const out = rows(env);
  const row = out.body.filter(function (l) { return /^Internet\s+10\.0\.0\.9/.test(l); })[0] || '';
  ok(/Hardware Addr\s+Type\s+Interface/.test(out.header),
    'the header names Type between the hardware address and the interface', out.header);
  ok((row.trim().split(/\s+/)[4] || '') === 'ARPA',
    'an IPv4-over-Ethernet binding reads ARPA, the vendor word for it', row);
  // A column that is named but whose values do not land under the name is the #1521 fault again.
  ok(out.header.indexOf('Type') === row.indexOf('ARPA'),
    'and ARPA lands under the Type heading',
    JSON.stringify({ heading: out.header.indexOf('Type'), value: row.indexOf('ARPA') }));
}

console.log('');
console.log('A neighbour on a port that is gone is not presented as reachable:');
{
  const env = lab();
  env.sim.ping('nine', '10.0.0.1', { count: 1 });
  const before = rows(env);
  ok(before.fields[0][5] === eth(env.r)[0].name, 'the entry starts out clean', before.fields[0][5]);

  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface ' + eth(env.r)[0].name,
    'shutdown', 'end']);
  const after = rows(env);
  // The neighbour row survives the shutdown (a real ARP cache does not empty on it) and the local row stays put;
  // the local row is not the one that carries the fault report, so assertions about the neighbour pick it out by
  // address rather than by position.
  ok(after.fields.length === 2, 'the entry is still listed - a real ARP cache does not empty on shutdown',
    String(after.fields.length));
  const neighbour = after.fields.filter(function (f) { return f[1] === '10.0.0.9'; })[0] || [];
  ok(/administratively down/.test(after.body[1] || ''), 'but it says the port cannot carry a frame',
    after.body[1]);
  ok(neighbour[5] === eth(env.r)[0].name, 'and the port is still named',
    JSON.stringify(neighbour[5]));
  ok(after.fields[0][1] === '10.0.0.1' && after.fields[0][2] === '-',
    'the local entry is untouched by the shutdown', after.body[0]);

  // A cable pulled with `link down` is a different fault from a shut port, and the column says which.
  const env2 = lab();
  env2.sim.ping('nine', '10.0.0.1', { count: 1 });
  const linkId = [...env2.t.links.keys()].filter(function (id) {
    const l = env2.t.links.get(id);
    return (l.a.deviceId === 'r1' && l.a.iface === eth(env2.r)[0].name) ||
      (l.b.deviceId === 'r1' && l.b.iface === eth(env2.r)[0].name);
  })[0];
  ok(!!linkId, 'the lab has the cable to pull', String(linkId));
  env2.sim.setLinkState(linkId, 'down');
  const rows2 = rows(env2);
  ok(/link down/.test(rows2.body.join(' ')), 'a cable taken down marks the entry as such',
    rows2.body.join(' | '));
  const pulled = rows2.body.filter(function (l) { return /^Internet\s+10\.0\.0\.9\s/.test(l); })[0] || '';
  ok(/down: link down/.test(pulled), 'and names the reason, not just "down"', pulled);
}

console.log('');
console.log('An entry with no recorded port says so rather than inventing one:');
{
  const env = lab();
  // What a topology restored from an older file looks like: an ARP entry and no port beside it.
  env.r.arp.set('10.0.0.200', '02:00:00:00:00:aa');
  const out = rows(env);
  const row = out.fields.filter(function (f) { return f[1] === '10.0.0.200'; })[0] || [];
  ok(row.length === 6, 'the row still has six columns', JSON.stringify(row));
  ok(row[5] === '-', 'with no interface claimed', JSON.stringify(row[5]));
  ok(!/[A-Za-z]/.test(row[5] || ''), 'and no invented port name', String(row[5]));
}

console.log('');
console.log('A recorded port that no longer exists is reported as gone:');
{
  const env = lab();
  env.r.arp.set('10.0.0.201', '02:00:00:00:00:bb');
  env.r.arpPorts.set('10.0.0.201', 'Gi9/9');
  const out = rows(env);
  const row = out.fields.filter(function (f) { return f[1] === '10.0.0.201'; })[0] || [];
  ok(/Gi9\/9/.test(out.body.join(' ')), 'the port it named is printed', out.body.join(' | '));
  ok(/gone/.test(out.body.join(' ')), 'and marked as gone', out.body.join(' | '));
  ok(row[5] === 'Gi9/9', 'rather than silently dropped', JSON.stringify(row));
}

console.log('');
console.log('A device with no topology still prints a table:');
{
  const r = new Topology().addDevice(ROUTER, 'bare');
  r.learnArp('10.0.0.77', '02:00:00:00:00:cc', eth(r)[0].name);
  // No topology at all: the command cannot know about a cable it was never told about, so it names the port
  // and says nothing about link state (the same rule `show interfaces` follows).
  const lines = ((new CliSession(r, null, null).run('show arp').output) || []).map(String);
  ok(lines.length === 2, 'header and one row', lines.join(' | '));
  ok(lines[1].trim().split(/\s+/).length === 6, 'with six columns', lines[1]);
  ok(lines[1].trim().split(/\s+/)[5] === eth(r)[0].name,
    'and the port, with no link state to report', lines[1]);
  ok(!/\(/.test(lines[1]), 'without inventing a state it cannot know', lines[1]);
}

console.log('');
console.log('Learning one entry cannot forget another port:');
{
  const env = lab();
  env.sim.ping('nine', '10.0.0.1', { count: 1 });
  const first = env.r.arpPorts.get('10.0.0.9');
  env.r.learnArp('10.0.0.9', '02:00:00:00:00:ee', eth(env.r)[1].name);
  ok(env.r.arpPorts.get('10.0.0.9') === eth(env.r)[1].name,
    'a later learn updates the port, as a real ARP cache does', String(env.r.arpPorts.get('10.0.0.9')));
  ok(first !== env.r.arpPorts.get('10.0.0.9'), 'and the move is visible', first + ' -> ' +
    env.r.arpPorts.get('10.0.0.9'));
  ok(env.r.arp.get('10.0.0.9') === '02:00:00:00:00:ee', 'with the new hardware address');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
