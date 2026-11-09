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
  ok(out.body.length === 2, 'both neighbours are listed', String(out.body.length));
  ok(out.fields.every(function (f) { return f.length === 5; }),
    'every row has as many columns as the header',
    out.fields.map(function (f) { return f.length; }).join(','));
  ok(/Interface/.test(out.header), 'the header still names the Interface column');

  // The port is the one the neighbour was heard on, not a guess: checked against what the engine recorded.
  const portOf = function (ip) { return env.r.arpPorts.get(ip); };
  const rowFor = function (ip) { return out.fields.filter(function (f) { return f[1] === ip; })[0] || []; };
  ok(rowFor('10.0.0.9')[4] === portOf('10.0.0.9'),
    'the interface printed is the port the engine learned it on',
    JSON.stringify({ printed: rowFor('10.0.0.9')[4], recorded: portOf('10.0.0.9') }));
  ok(portOf('10.0.0.9') === eth(env.r)[0].name,
    'and that port is the one facing the switch', String(portOf('10.0.0.9')));
  ok(rowFor('10.0.0.10')[4] === portOf('10.0.0.10'), 'for the other neighbour too');

  // The MAC column is the data plane's, not a decoration.
  ok(rowFor('10.0.0.9')[3] === env.r.arp.get('10.0.0.9'),
    'the hardware address matches the table the engine uses',
    JSON.stringify({ printed: rowFor('10.0.0.9')[3], engine: env.r.arp.get('10.0.0.9') }));

  ok(out.fields[0][1] === '10.0.0.9',
    'and the rows are in numeric address order (.9 before .10)', out.fields.map(function (f) { return f[1]; }).join(','));
}

console.log('');
console.log('A neighbour on a port that is gone is not presented as reachable:');
{
  const env = lab();
  env.sim.ping('nine', '10.0.0.1', { count: 1 });
  const before = rows(env);
  ok(before.fields[0][4] === eth(env.r)[0].name, 'the entry starts out clean', before.fields[0][4]);

  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface ' + eth(env.r)[0].name,
    'shutdown', 'end']);
  const after = rows(env);
  ok(after.fields.length === 1, 'the entry is still listed - a real ARP cache does not empty on shutdown',
    String(after.fields.length));
  ok(/administratively down/.test(after.body[0] || ''), 'but it says the port cannot carry a frame',
    after.body[0]);
  ok(after.fields[0][4] === eth(env.r)[0].name, 'and the port is still named',
    after.fields[0][4]);

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
  ok(/down: link down/.test(rows2.body[0] || ''), 'and names the reason, not just "down"', rows2.body[0]);
}

console.log('');
console.log('An entry with no recorded port says so rather than inventing one:');
{
  const env = lab();
  // What a topology restored from an older file looks like: an ARP entry and no port beside it.
  env.r.arp.set('10.0.0.200', '02:00:00:00:00:aa');
  const out = rows(env);
  const row = out.fields.filter(function (f) { return f[1] === '10.0.0.200'; })[0] || [];
  ok(row.length === 5, 'the row still has five columns', JSON.stringify(row));
  ok(row[4] === '-', 'with no interface claimed', JSON.stringify(row[4]));
  ok(!/[A-Za-z]/.test(row[4] || ''), 'and no invented port name', String(row[4]));
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
  ok(row[4] === 'Gi9/9', 'rather than silently dropped', JSON.stringify(row));
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
  ok(lines[1].trim().split(/\s+/).length === 5, 'with five columns', lines[1]);
  ok(lines[1].trim().split(/\s+/)[4] === eth(r)[0].name,
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
