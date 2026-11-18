'use strict';
// What priority a group runs at, versus what an operator typed into `vrrp <vrid> priority` (#1727).
//
// VRRP reserves 255 for the address owner - the router whose own interface address is one of the
// group's virtual addresses - so such a router runs at 255 whatever its configured priority says, and
// the election in engine/vrrp.js has always voted that way. `show vrrp` printed the configured value
// instead, so a router that owns the virtual gateway showed 100 in the Pri column and the column
// disagreed with the election that had just outranked a 254. The timeline carried the same number.
//
// The value is documented in two vendor guides, not inferred: "If a VRRP group is the IP address owner,
// its priority is fixed at 255" (Cisco IOS First Hop Redundancy Protocols Configuration Guide) and "the
// default is 100 for backups and 255 for a master that has an interface IP address equal to the virtual
// IP address" (Nexus 5600 Unicast Routing Configuration Guide). research/show-vrrp-owner-priority.md
// holds the sources, and the one thing they do not settle.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const vrrp = require('../engine/vrrp');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  + ' + msg); }
  else { failed++; console.error('  x ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const eth = function (d) {
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
};

// R1 is the address owner: its interface address IS the virtual address. R2 is not, and is configured
// at 254 - the highest value an operator may type, and still below the owner's reserved 255.
function lab(opts) {
  const o = opts || {};
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const r2 = t.addDevice(ROUTER, 'r2');
  const sw = t.addDevice(SWITCH, 'sw');
  t.connect('r1', eth(r1)[0].name, 'sw', 'Fa0/1');
  t.connect('r2', eth(r2)[0].name, 'sw', 'Fa0/2');
  const sim = new Simulator(t);
  const r1lines = ['configure terminal', 'interface ' + eth(r1)[0].name,
    'ip address 10.0.0.1 255.255.255.0', 'vrrp 7 ip 10.0.0.1'];
  if (o.priority) r1lines.push('vrrp 7 priority ' + o.priority);
  r1lines.push('end');
  runCommands(r1, t, sim, r1lines);
  runCommands(r2, t, sim, ['configure terminal', 'interface ' + eth(r2)[0].name,
    'ip address 10.0.0.2 255.255.255.0', 'vrrp 7 ip 10.0.0.1', 'vrrp 7 priority 254', 'end']);
  sim.computeVrrp();
  return { t: t, sim: sim, r1: r1, r2: r2 };
}

function show(env, dev, withSim) {
  return ((new CliSession(dev, env.t, withSim === false ? null : env.sim).run('show vrrp').output) || []).map(String);
}

// One group's row as fields: iface, group, pri, state, master, virtual IPs, MAC.
function fieldsFor(lines, vrid) {
  const row = lines.filter(function (l) {
    const f = l.trim().split(/\s+/);
    return f[1] === String(vrid) && /^\d+$/.test(f[2] || '');
  })[0] || '';
  return row.trim().split(/\s+/);
}

const noteFor = function (lines) {
  return lines.filter(function (l) { return /% VRRP group 7/.test(l); })[0] || '';
};

console.log('');
console.log('The owner runs at 255, and the column says so:');
{
  const env = lab();
  const f1 = fieldsFor(show(env, env.r1), 7);
  ok(f1[2] === '255', 'the owner Pri is 255, not the configured 100', f1.join(' '));
  ok(f1[3] === 'Master', 'and it is the master', f1.join(' '));
  const f2 = fieldsFor(show(env, env.r2), 7);
  ok(f2[2] === '254', 'a backup still prints the priority it was configured with', f2.join(' '));
  ok(f2[3] === 'Backup', 'and is a backup', f2.join(' '));
  // 254 is the highest value `vrrp 7 priority` accepts, and it still loses: the 255 in R1's row is the
  // reason, so the column explains the result instead of contradicting it.
  ok(env.sim.vrrpFor('r2')[0].masterPriority === 255,
    'the verdict records the master priority as 255 too', String(env.sim.vrrpFor('r2')[0].masterPriority));
  ok(env.sim.vrrpFor('r2')[0].reason === 'owner', 'and names ownership as the reason it won',
    env.sim.vrrpFor('r2')[0].reason);
}

console.log('');
console.log('A number the command refuses is a number the table may print - with the reason:');
{
  const env = lab();
  const note = noteFor(show(env, env.r1));
  ok(/% VRRP group 7 on \S+: this device holds 10\.0\.0\.1/.test(note), 'the note names the address it holds', note);
  ok(/address owner/.test(note) && /priority is 255/.test(note), 'says what it is and what that makes it', note);
  ok(/owner mode/.test(note), 'in the vendor own words', note);
  ok(/cannot set that value/.test(note), 'and warns that the value is not typeable, so nobody tries', note);
  // The refusal is still the refusal: displaying 255 did not make it configurable.
  const refuse = runCommands(env.r1, env.t, env.sim, ['configure terminal', 'interface ' + eth(env.r1)[0].name,
    'vrrp 7 priority 255']);
  ok(/1-254/.test(refuse.output), '`vrrp 7 priority 255` is still refused with the range quoted',
    refuse.lines.slice(-1)[0]);
  ok(env.r1.config.vrrp[0].priority === 100, 'and the group is left at its configured 100',
    String(env.r1.config.vrrp[0].priority));
  // The backup has no such note: it owns nothing.
  ok(noteFor(show(env, env.r2)) === '', 'the non-owner prints no owner note', noteFor(show(env, env.r2)));
}

console.log('');
console.log('The configured value is not lost, only outranked:');
{
  const env = lab({ priority: 150 });
  const f1 = fieldsFor(show(env, env.r1), 7);
  ok(f1[2] === '255', 'an owner that was configured 150 still runs at 255', f1.join(' '));
  ok(env.r1.config.vrrp[0].priority === 150, 'and the configured 150 is what the config holds',
    String(env.r1.config.vrrp[0].priority));
  const cfg = (new CliSession(env.r1, env.t, env.sim).run('show running-config').output || []).join('\n');
  ok(/vrrp 7 priority 150/.test(cfg), 'so show running-config prints 150, not the 255 it runs at',
    cfg.split('\n').filter(function (l) { return /vrrp/.test(l); }).join(' | '));
  const rec = env.sim.vrrpFor('r1')[0];
  ok(rec.candidates.filter(function (c) { return c.id === 'r1'; })[0].configured === 150,
    'and the election keeps both numbers per candidate', JSON.stringify(rec.candidates));
}

console.log('');
console.log('Ownership is a configuration fact, so it does not need an election to be true:');
{
  // No Simulator at all: nothing has voted, so the state column has no verdict to print - but 255 is
  // what this router would run at the moment a group formed, because its own address is the virtual
  // address. The number comes from the configuration, not from a measurement.
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  runCommands(r1, t, null, ['configure terminal', 'interface ' + eth(r1)[0].name,
    'ip address 10.0.0.1 255.255.255.0', 'vrrp 7 ip 10.0.0.1', 'end']);
  const lines = ((new CliSession(r1, t, null).run('show vrrp').output) || []).map(String);
  const f = fieldsFor(lines, 7);
  ok(f[2] === '255', 'with no simulation at all the Pri column still says 255', f.join(' '));
  ok(f[3] === 'Backup', 'while the state is the only claim it can make without a vote', f.join(' '));
  ok(/no election has run/.test(lines.join(String.fromCharCode(10))),
    'and the table says why the state is not a verdict');
}

console.log('');
console.log('A shut port still owns the address it holds:');
{
  const env = lab();
  runCommands(env.r1, env.t, env.sim, ['configure terminal', 'interface ' + eth(env.r1)[0].name, 'shutdown', 'end']);
  env.sim.computeVrrp();
  const f1 = fieldsFor(show(env, env.r1), 7);
  ok(f1[2] === '255', 'the address is still configured, so the group still runs at 255', f1.join(' '));
  ok(f1[3] === 'Init', 'and the state says it is not participating', f1.join(' '));
  const f2 = fieldsFor(show(env, env.r2), 7);
  ok(f2[3] === 'Master', 'the backup took over', f2.join(' '));
  ok(f2[2] === '254', 'at its own configured priority', f2.join(' '));
}

console.log('');
console.log('Nothing else got the owner number:');
{
  // Neither router holds the virtual address, so both print what they were configured with and the
  // owner rule stays where it belongs.
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const r2 = t.addDevice(ROUTER, 'r2');
  const sw = t.addDevice(SWITCH, 'sw');
  t.connect('r1', eth(r1)[0].name, 'sw', 'Fa0/1');
  t.connect('r2', eth(r2)[0].name, 'sw', 'Fa0/2');
  const sim = new Simulator(t);
  runCommands(r1, t, sim, ['configure terminal', 'interface ' + eth(r1)[0].name,
    'ip address 10.0.0.1 255.255.255.0', 'vrrp 7 ip 10.0.0.254', 'end']);
  runCommands(r2, t, sim, ['configure terminal', 'interface ' + eth(r2)[0].name,
    'ip address 10.0.0.2 255.255.255.0', 'vrrp 7 ip 10.0.0.254', 'vrrp 7 priority 254', 'end']);
  sim.computeVrrp();
  const env = { t: t, sim: sim };
  ok(fieldsFor(show(env, r1), 7)[2] === '100', 'a default group prints 100');
  ok(fieldsFor(show(env, r2), 7)[2] === '254', 'and the configured 254 prints as 254');
  ok(noteFor(show(env, r1)) === '' && noteFor(show(env, r2)) === '',
    'with no owner note on either side');
  ok(vrrp.VRRP_OWNER_PRIORITY === 255, 'the reserved value is still the library constant');
}

console.log(String.fromCharCode(10) + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
