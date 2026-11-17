'use strict';
// `show mac address-table` must not keep claiming an entry it can no longer know (#1255).
//
// Two ways the table lied:
//
//   1. A port moved between VLANs kept the entries it had learned in the old VLAN. Nothing ages entries out
//      here, so `show mac address-table` went on printing a VLAN-1 entry on a port that had become access
//      VLAN 20 - indefinitely, and with no mark of any kind:
//
//        Vlan    Mac Address         Type        Ports
//        1       0200.0000.0200      DYNAMIC     Fa0/2      <- Fa0/2 is VLAN 20 now
//
//   2. Every row looked identical whether its port was up, shut, or uncabled, so a stale entry read as a
//      live forwarding decision.
//
// A real switch flushes a port's dynamic entries when its membership changes and ages the rest out. The
// flush is the fix; the marking covers what the model still cannot know.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
// Where a row's port sits in the printed table: Vlan, MAC, Type, Age, Ports. One constant, so a column added
// later moves the index in one place instead of five (#1395).
const PORT = 4;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];

// Two hosts on one switch: a on Fa0/1, b on Fa0/2.
function lab() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const a = t.addDevice(PC, 'a');
  const b = t.addDevice(PC, 'b');
  t.connect('a', 'eth0', 'sw', 'Fa0/1');
  t.connect('b', 'eth0', 'sw', 'Fa0/2');
  const sim = new Simulator(t);
  runCommands(a, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'end']);
  runCommands(b, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.10 255.255.255.0', 'end']);
  sim.ping('a', '10.0.0.10', { count: 1 });        // so both MACs are learned
  return { t: t, sim: sim, sw: sw, a: a, b: b };
}

// The table is surrounded by a title, a rule, a blank line and a total, so the rows are found rather than
// assumed to start on line 1: the heading is the line that begins `Vlan`, the data starts under its dash rule,
// and the trailing total is the device's count, not a row (#1395 follow).
function table(env) {
  const lines = ((new CliSession(env.sw, env.t, env.sim).run('show mac address-table').output) || [])
    .map(String);
  const head = lines.findIndex(function (l) { return /^Vlan\s/.test(l); });
  const total = lines.findIndex(function (l) { return /^Total Mac Addresses for this criterion:/.test(l); });
  const body = lines.slice(head + 2, total < 0 ? lines.length : total).filter(function (l) { return l !== ''; });
  return { header: lines[head] || '', body: body, fields: body.map(function (l) { return l.trim().split(/\s+/); }) };
}

console.log('');
console.log('The table lists what the switch has learned, per VLAN:');
{
  const env = lab();
  const out = table(env);
  ok(out.body.length === 2, 'both hosts are in the table', String(out.body.length));
  ok(out.fields.every(function (f) { return f.length === PORT + 1; }),
    'every row has five columns (Vlan, MAC, Type, Age, Ports)',
    out.fields.map(function (f) { return f.join('|'); }).join(' / '));
  ok(PORT === 4 && out.fields[0][PORT] === 'Fa0/1' && out.fields[1][PORT] === 'Fa0/2',
    'each on the port it was heard on', out.fields.map(function (f) { return f[PORT]; }).join(','));
  ok(out.fields.every(function (f) { return f[0] === '1'; }), 'in VLAN 1, where the ports are');
}

console.log('');
console.log('The Age column says how long ago the switch heard from an address:');
{
  const env = lab();
  const out = table(env);
  ok(out.fields.every(function (f) { return f[3] === '-'; }),
    'an entry written without an instant reports no age rather than a made-up one',
    out.fields.map(function (f) { return f[3]; }).join(','));
  ok(/Age/.test(out.header), 'and the column is named', out.header);
}

console.log('');
console.log('Moving a port to another VLAN drops what it learned there:');
{
  const env = lab();
  const before = table(env).fields.filter(function (f) { return f[PORT] === 'Fa0/2'; });
  ok(before.length === 1, 'Fa0/2 has an entry to lose', JSON.stringify(before));

  runCommands(env.sw, env.t, env.sim, ['configure terminal', 'interface Fa0/2',
    'switchport access vlan 20', 'end']);

  const after = table(env);
  const onMoved = after.fields.filter(function (f) { return (f[PORT] || '').indexOf('Fa0/2') === 0; });
  ok(onMoved.length === 0, 'and nothing is left claiming VLAN 1 on it any more',
    onMoved.map(function (f) { return f.join(' '); }).join(' | '));
  ok(after.fields.length === 1, 'while the other port keeps its entry', String(after.fields.length));
  ok(after.fields[0][PORT] === 'Fa0/1', 'and that entry is untouched', after.fields[0][PORT]);

  // The flush is per port: the VLAN-20 table must not lose anything that belongs to another port.
  env.sw.macTables.set(20, new Map([['02:00:00:00:aa:00', 'Fa0/1']]));
  runCommands(env.sw, env.t, env.sim, ['configure terminal', 'interface Fa0/2', 'no shutdown', 'end']);
  runCommands(env.sw, env.t, env.sim, ['configure terminal', 'interface Fa0/2',
    'switchport access vlan 30', 'end']);
  const kept = (env.sw.macTables.get(20) || new Map()).get('02:00:00:00:aa:00');
  ok(kept === 'Fa0/1', 'a flush on one port leaves another port\'s entries alone', String(kept));
}

console.log('');
console.log('A port that goes down is not the way to an address:');
{
  // This block used to assert the opposite - "shutting a port does NOT empty the table - real switches age
  // entries out" - and print the surviving row with an `(administratively down)` note instead. The claim about
  // real switches is not true. A switch removes the dynamic entries it learned on a port as soon as the port
  // leaves the active topology, and Aruba states the observable in one line: a dynamically learned address is
  // removed "if the entry ages out, the link goes down, or the system resets" (Instant On 1930 Management and
  // Configuration Guide, "Port security"). 802.1D says the same to the filtering database: remove all entries
  // for a Port that is no longer part of the active topology (17.19.7), and learning is conditional on the
  // Port State (7.4). See research/mac-table-link-down-flush.md.
  const env = lab();
  const closed = runCommands(env.sw, env.t, env.sim,
    ['configure terminal', 'interface Fa0/2', 'shutdown', 'end']).output;
  ok(closed.indexOf('Fa0/2 administratively down (1 learned address on it dropped)') !== -1,
    'the port is closed and the console says how many addresses went with it', closed);
  const out = table(env);
  ok(out.body.length === 1, 'and the address it had learned is gone from the table, not aged out later',
    String(out.body.length));
  ok(out.fields[0][PORT] === 'Fa0/1', 'while the other port keeps its entry', out.fields[0][PORT]);

  // The entry does not come back when the port does. The switch has to hear from the host again, which is why
  // a reconnected machine floods until it speaks - and why a table that resurrected the address would be
  // forwarding out of a port on the strength of something nobody re-announced.
  runCommands(env.sw, env.t, env.sim, ['configure terminal', 'interface Fa0/2', 'no shutdown', 'end']);
  const reopened = table(env);
  ok(reopened.body.length === 1, 'reopening the port does not resurrect the address',
    String(reopened.body.length));

  // The same rule, from the other event that takes a port down: the cable being unplugged. Both ends lose the
  // entries they learned on that port, because both ports stopped carrying frames.
  const pulled = lab();
  const cable = [...pulled.t.links.values()].filter(function (l) { return l.touches(pulled.b.id); })[0];
  ok(!!cable, 'the lab has a cable to pull', cable && cable.id);
  pulled.t.disconnect(cable.id);
  const after = table(pulled);
  ok(after.body.length === 1, 'unplugging it drops the entry the switch learned on that port',
    String(after.body.length));
  ok(after.fields[0][PORT] === 'Fa0/1', 'and leaves the other port alone', after.fields[0][PORT]);
  const onHost = new CliSession(pulled.b, pulled.t, pulled.sim).run('show mac address-table').output.join(' ');
  ok(onHost.indexOf('0200.0000.0100') === -1, "and the host at the far end lost the switch's address too",
    onHost);
}

console.log('');
console.log('A row whose port is gone, or carries another VLAN, is marked:');
{
  const env = lab();
  env.sw.macTables.set(20, new Map([
    ['02:00:00:00:bb:00', 'Fa0/1'],      // Fa0/1 is access VLAN 1, so this cannot be right
    ['02:00:00:00:cc:00', 'Fa9/9']       // a port this device does not have
  ]));
  const out = table(env);
  // The printed cell is dotted (test/mac-address-format.test.js); the table is keyed colon-separated.
  const mismatch = out.fields.filter(function (f) { return f[1] === '0200.0000.bb00'; })[0] || [];
  ok(/vlan mismatch/.test(out.body.join(' ')), 'an entry in a VLAN its port does not carry says so',
    out.body.join(' | '));
  ok(mismatch[PORT] === 'Fa0/1', 'and still names the port', JSON.stringify(mismatch));
  ok(/gone/.test(out.body.join(' ')), 'an entry pointing at a port that does not exist says so',
    out.body.join(' | '));
}

console.log('');
console.log('A trunk carries its VLANs, so its entries are not marked:');
{
  const t = new Topology();
  const s1 = t.addDevice(SWITCH, 's1');
  const s2 = t.addDevice(SWITCH, 's2');
  const a = t.addDevice(PC, 'a');
  t.connect('a', 'eth0', 's1', 'Fa0/1');
  t.connect('s1', 'Fa0/2', 's2', 'Fa0/1');
  const sim = new Simulator(t);
  runCommands(s1, t, sim, ['configure terminal', 'interface Fa0/1', 'switchport access vlan 20',
    'interface Fa0/2', 'switchport mode trunk', 'end']);
  runCommands(a, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'end']);
  runCommands(a, t, sim, ['configure terminal', 'interface eth0', 'ip address 10.0.0.9 255.255.255.0', 'end']);
  // Reach the switch so it learns a on Fa0/1 in VLAN 20.
  sim.ping('a', '10.0.0.99', { count: 1 });

  const out = table({ t: t, sim: sim, sw: s1 });
  const inVlan20 = out.fields.filter(function (f) { return f[0] === '20'; });
  ok(inVlan20.length >= 1, 'the host is learned in VLAN 20', out.body.join(' | '));
  ok(inVlan20.every(function (f) { return !/\(/.test(f[3]); }),
    'and none of those rows is marked stale', inVlan20.map(function (f) { return f[3]; }).join(','));
}

console.log('');
console.log('The flush is one call, so a new membership command cannot forget it:');
{
  const env = lab();
  const dropped = env.sw.flushMacsOnPort('Fa0/2');
  ok(dropped === 1, 'flushMacsOnPort reports what it dropped', String(dropped));
  ok(env.sw.flushMacsOnPort('Fa0/2') === 0, 'and nothing the second time');
  ok(env.sw.flushMacsOnPort('nosuchport') === 0, 'and nothing for a port that has no entries');
  ok(env.sw.macTable.size === 1, 'the other port survives', String(env.sw.macTable.size));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
