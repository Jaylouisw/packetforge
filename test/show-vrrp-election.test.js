'use strict';
// `show vrrp` must name the router the election chose, not the router you are typing at (#1241).
//
// The Master column used to be `dev.name` for every group, so a backup router introduced itself as the
// master. That is the one field you read to answer "which box is answering for the gateway", and it sent
// you to the wrong device - including, after a failover, to a box that was no longer even a candidate.
//
// The fix is not to re-derive the election in the CLI: it is to keep the verdict `Simulator.computeVrrp()`
// already produces. One election, one answer, printed. The last sections check that answer against the
// data plane, because a table that disagrees with which box answers ARP for the virtual address is worth
// nothing.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const vrrp = require('../engine/vrrp');

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

// Three routers on one segment and a host pointing at the virtual address. Priorities 120 / 100 / 250, so
// the winner is neither the first router nor the one you might assume.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const r2 = t.addDevice(ROUTER, 'r2');
  const r3 = t.addDevice(ROUTER, 'r3');
  const sw = t.addDevice(SWITCH, 'sw');
  const pc = t.addDevice(PC, 'pc');
  t.connect('r1', eth(r1)[0].name, 'sw', 'Fa0/1');
  t.connect('r2', eth(r2)[0].name, 'sw', 'Fa0/2');
  t.connect('r3', eth(r3)[0].name, 'sw', 'Fa0/4');
  t.connect('pc', 'eth0', 'sw', 'Fa0/3');
  const sim = new Simulator(t);
  runCommands(r1, t, sim, ['configure terminal', 'interface ' + eth(r1)[0].name,
    'ip address 10.0.0.1 255.255.255.0', 'vrrp 42 ip 10.0.0.254', 'vrrp 42 priority 120', 'end']);
  runCommands(r2, t, sim, ['configure terminal', 'interface ' + eth(r2)[0].name,
    'ip address 10.0.0.2 255.255.255.0', 'vrrp 42 ip 10.0.0.254', 'vrrp 42 priority 100', 'end']);
  runCommands(r3, t, sim, ['configure terminal', 'interface ' + eth(r3)[0].name,
    'ip address 10.0.0.3 255.255.255.0', 'vrrp 42 ip 10.0.0.254', 'vrrp 42 priority 250', 'end']);
  runCommands(pc, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.50 255.255.255.0', 'ip default-gateway 10.0.0.254', 'end']);
  sim.computeVrrp();
  return { t: t, sim: sim, r1: r1, r2: r2, r3: r3, pc: pc };
}

function show(env, dev) {
  return ((new CliSession(dev, env.t, env.sim).run('show vrrp').output) || []).map(String);
}

// One group's row as whitespace-separated fields: iface, group, pri, state, master, virtual IPs, MAC.
// Token-based on purpose: '10.0.0.2' is a substring of '10.0.0.254', which is exactly the kind of
// assertion that passes while the output is wrong.
function fieldsFor(lines, vrid) {
  const row = lines.filter(function (l) {
    const f = l.trim().split(/\s+/);
    return f[1] === String(vrid) && /^\d+$/.test(f[2] || '');
  })[0] || '';
  return row.trim().split(/\s+/);
}

console.log('');
console.log('The highest priority wins, and everyone says so:');
{
  const env = lab();
  const f1 = fieldsFor(show(env, env.r1), 42);
  ok(f1[3] === 'Backup', 'R1 (120) is a backup', f1.join(' '));
  ok(f1[4] === '10.0.0.3', 'and names R3 as the master', f1.join(' '));
  ok(f1[4] !== '10.0.0.1', 'not itself - this was the bug', f1.join(' '));

  const f2 = fieldsFor(show(env, env.r2), 42);
  ok(f2[3] === 'Backup', 'R2 (100) is a backup', f2.join(' '));
  ok(f2[4] === '10.0.0.3', 'and names R3 as well', f2.join(' '));

  const f3 = fieldsFor(show(env, env.r3), 42);
  ok(f3[3] === 'Master', 'R3 (250) is the master', f3.join(' '));
  ok(f3[4] === '10.0.0.3', 'naming its own address', f3.join(' '));
  ok(f3[6] === vrrp.virtualMac(42), 'with the group virtual MAC', f3.join(' '));
  ok(env.r3.vrrpClaims.length === 1 && env.r1.vrrpClaims.length === 0,
    'and the data plane gave the claim to R3 alone',
    JSON.stringify({ r1: env.r1.vrrpClaims.length, r3: env.r3.vrrpClaims.length }));
}

console.log('');
console.log('After failover, both sides tell the truth:');
{
  const env = lab();
  const before = env.sim.ping('pc', '10.0.0.254', { count: 2 });
  ok(before.replies.every(function (r) { return r.success; }), 'the virtual address answers before failover');

  runCommands(env.r3, env.t, env.sim, ['configure terminal', 'interface ' + eth(env.r3)[0].name, 'shutdown', 'end']);
  const after = env.sim.ping('pc', '10.0.0.254', { count: 2 });
  ok(after.replies.every(function (r) { return r.success; }), 'and after R3 fails, with no help needed');

  const f1 = fieldsFor(show(env, env.r1), 42);
  ok(f1[3] === 'Master', 'R1 (next highest) is now the master', f1.join(' '));
  ok(f1[4] === '10.0.0.1', 'naming its own address', f1.join(' '));

  const r3Lines = show(env, env.r3);
  const f3 = fieldsFor(r3Lines, 42);
  ok(f3[3] === 'Init', 'R3 reads Init - it is not participating at all', f3.join(' '));
  ok(f3[4] === '-', 'with no invented master', f3.join(' '));
  ok(!r3Lines.some(function (l) { return /no group holds its address yet/.test(l); }),
    'and no stale "run a simulation" note', r3Lines.join(' | '));
  ok(r3Lines.some(function (l) { return /took part in no VRRP election/.test(l); }),
    'but the note that explains why', r3Lines.join(' | '));
}

console.log('');
console.log('Recovery, and no stale election left behind:');
{
  const env = lab();
  runCommands(env.r3, env.t, env.sim, ['configure terminal', 'interface ' + eth(env.r3)[0].name, 'shutdown', 'end']);
  env.sim.computeVrrp();
  ok(fieldsFor(show(env, env.r1), 42)[4] === '10.0.0.1', 'R1 holds it while R3 is down');

  runCommands(env.r3, env.t, env.sim, ['configure terminal', 'interface ' + eth(env.r3)[0].name, 'no shutdown', 'end']);
  env.sim.computeVrrp();
  ok(fieldsFor(show(env, env.r1), 42)[4] === '10.0.0.3', 'when R3 comes back, R1 names it again');
  ok(fieldsFor(show(env, env.r3), 42)[3] === 'Master', 'and R3 is master again');

  // One election pass = one verdict per candidate port: no accumulated rows, no duplicate records.
  const rows = show(env, env.r1).filter(function (l) {
    const f = l.trim().split(/\s+/);
    return f[1] === '42' && /^\d+$/.test(f[2] || '');
  });
  ok(rows.length === 1, 'exactly one row for the group (' + rows.length + ')', rows.join(' | '));
  ok(env.sim.vrrpFor('r1').length === 1, 'and one verdict recorded for R1',
    String(env.sim.vrrpFor('r1').length));
}

console.log('');
console.log('The printed master is the box that answers ARP:');
{
  const env = lab();
  env.sim.ping('pc', '10.0.0.1', { count: 1 });   // touches the gateway, so the host resolves it
  const named = fieldsFor(show(env, env.r1), 42)[4];
  ok(named === '10.0.0.3', 'the table names R3 as the master', named);

  const holder = [env.r1, env.r2, env.r3].filter(function (d) { return eth(d)[0].ip === named; })[0];
  ok(!!holder, 'that address belongs to a router in the lab', named);
  ok(holder && Array.isArray(holder.vrrpClaims) && holder.vrrpClaims.length === 1,
    'and that router holds the virtual address claim', JSON.stringify(holder && holder.vrrpClaims));

  // Ask the data plane directly: the host's ARP for the VIP resolves to the group virtual MAC, which is
  // what makes a failover invisible to the host.
  const mac = env.pc.arp.get('10.0.0.254');
  ok(mac === vrrp.virtualMac(42), 'the host resolved the virtual address to the virtual MAC', String(mac));

  // A device with no simulator still prints a table, and says that nothing has been elected.
  const alone = ((new CliSession(env.r1, env.t, null).run('show vrrp').output) || []).join('\n');
  ok(/no election has run/.test(alone), 'without a simulator the command says so',
    alone.split('\n').slice(-1)[0]);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
