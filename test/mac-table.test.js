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
//        1       02:00:00:00:02:00   DYNAMIC     Fa0/2      <- Fa0/2 is VLAN 20 now
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

function table(env) {
  const lines = ((new CliSession(env.sw, env.t, env.sim).run('show mac address-table').output) || [])
    .map(String);
  return { header: lines[0] || '', body: lines.slice(1), fields: lines.slice(1).map(function (l) { return l.trim().split(/\s+/); }) };
}

console.log('');
console.log('The table lists what the switch has learned, per VLAN:');
{
  const env = lab();
  const out = table(env);
  ok(out.body.length === 2, 'both hosts are in the table', String(out.body.length));
  ok(out.fields.every(function (f) { return f.length === 4; }),
    'every row has four columns (Vlan, MAC, Type, Ports)',
    out.fields.map(function (f) { return f.join('|'); }).join(' / '));
  ok(out.fields[0][3] === 'Fa0/1' && out.fields[1][3] === 'Fa0/2',
    'each on the port it was heard on', out.fields.map(function (f) { return f[3]; }).join(','));
  ok(out.fields.every(function (f) { return f[0] === '1'; }), 'in VLAN 1, where the ports are');
}

console.log('');
console.log('Moving a port to another VLAN drops what it learned there:');
{
  const env = lab();
  const before = table(env).fields.filter(function (f) { return f[3] === 'Fa0/2'; });
  ok(before.length === 1, 'Fa0/2 has an entry to lose', JSON.stringify(before));

  runCommands(env.sw, env.t, env.sim, ['configure terminal', 'interface Fa0/2',
    'switchport access vlan 20', 'end']);

  const after = table(env);
  const onMoved = after.fields.filter(function (f) { return (f[3] || '').indexOf('Fa0/2') === 0; });
  ok(onMoved.length === 0, 'and nothing is left claiming VLAN 1 on it any more',
    onMoved.map(function (f) { return f.join(' '); }).join(' | '));
  ok(after.fields.length === 1, 'while the other port keeps its entry', String(after.fields.length));
  ok(after.fields[0][3] === 'Fa0/1', 'and that entry is untouched', after.fields[0][3]);

  // The flush is per port: the VLAN-20 table must not lose anything that belongs to another port.
  env.sw.macTables.set(20, new Map([['02:00:00:00:aa:00', 'Fa0/1']]));
  runCommands(env.sw, env.t, env.sim, ['configure terminal', 'interface Fa0/2', 'no shutdown', 'end']);
  runCommands(env.sw, env.t, env.sim, ['configure terminal', 'interface Fa0/2',
    'switchport access vlan 30', 'end']);
  const kept = (env.sw.macTables.get(20) || new Map()).get('02:00:00:00:aa:00');
  ok(kept === 'Fa0/1', 'a flush on one port leaves another port\'s entries alone', String(kept));
}

console.log('');
console.log('A membership change is the only thing that flushes:');
{
  const env = lab();
  runCommands(env.sw, env.t, env.sim, ['configure terminal', 'interface Fa0/2', 'shutdown', 'end']);
  const out = table(env);
  ok(out.body.length === 2, 'shutting a port does NOT empty the table - real switches age entries out',
    String(out.body.length));
  ok(/administratively down/.test(out.body.join(' ')), 'but the row says the port cannot carry a frame',
    out.body.join(' | '));
  ok(!/shut down/.test(out.body.join(' ')),
    'and does not repeat the reason the status already gives', out.body.join(' | '));
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
  const mismatch = out.fields.filter(function (f) { return f[1] === '02:00:00:00:bb:00'; })[0] || [];
  ok(/vlan mismatch/.test(out.body.join(' ')), 'an entry in a VLAN its port does not carry says so',
    out.body.join(' | '));
  ok(mismatch[3] === 'Fa0/1', 'and still names the port', JSON.stringify(mismatch));
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
