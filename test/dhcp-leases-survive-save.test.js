'use strict';
// A saved lab forgot every DHCP lease, and without a clock the view called the survivors "active" (#1465).
//
//   save a lab where two hosts hold leases -> reopen -> show ip dhcp binding
//   % no leases: nothing has asked this server for an address yet
//
// The leases live on the topology (`topo.dhcpStates`, aliased by the simulator), which is exactly the state the
// document is supposed to carry - `Topology.serialize()` wrote the flows for that reason (#1435) and never wrote the
// leases. A server that had answered two hosts an hour earlier reopened claiming nobody had ever asked.
//
// The second half is the same mistake in the view: a lease's state is a fact about time, and `leaseTable()` only
// states it when it is asked at an instant. Without one, rows carry no `state` - and the summary subtracted the
// lapsed count from the total and called the remainder "active", a claim about time the engine had explicitly
// declined to make.
const path = require('path');
const fs = require('fs');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const dhcpLib = require('../engine/dhcp');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const MODEL = function (m) { return catalog.find(function (s) { return s.model === m; }); };
const ROUTER = MODEL('generic-router'), SWITCH = MODEL('generic-switch'), PC = MODEL('generic-pc');

const POOL = ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown',
  'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0', 'range 10.0.0.100 10.0.0.110',
  'default-router 10.0.0.1', 'lease 0 0 1', 'exit'];

function lab() {
  const t = new Topology();
  t.addDevice(ROUTER, 'r1'); t.addDevice(SWITCH, 'sw'); t.addDevice(PC, 'p1'); t.addDevice(PC, 'p2');
  t.connect('r1', 'Gi0/0', 'sw', 'Fa0/1');
  t.connect('p1', 'eth0', 'sw', 'Fa0/3');
  t.connect('p2', 'eth0', 'sw', 'Fa0/4');
  const sim = new Simulator(t);
  const S = {};
  const cli = function (id) { return (S[id] = S[id] || new CliSession(t.getDevice(id), t, sim)); };
  const cfg = function (id, lines) {
    cli(id).run('configure terminal');
    lines.forEach(function (l) { return cli(id).run(l); });
    cli(id).run('end');
  };
  return { t: t, sim: sim, cli: cli, cfg: cfg };
}

// Two hosts holding leases, granted at t=5000.
function leasedLab() {
  const L = lab();
  L.cfg('r1', POOL);
  L.cfg('p1', ['interface eth0', 'ip address dhcp']);
  L.cfg('p2', ['interface eth0', 'ip address dhcp']);
  L.sim.runAtMs = 5000;
  L.sim.computeDhcp();
  return L;
}

function reopen(L) {
  const doc = JSON.parse(JSON.stringify(L.t.serialize()));
  const t = Topology.fromJSON(JSON.parse(JSON.stringify(doc)));
  return { doc: doc, t: t, sim: new Simulator(t) };
}

console.log('');
console.log('The document carries the leases:');
{
  const L = leasedLab();
  const bindings = L.sim.dhcpBindings('r1');
  ok(bindings.length === 2, 'the server holds two leases', String(bindings.length));
  const doc = JSON.parse(JSON.stringify(L.t.serialize()));
  ok(!!doc.dhcp && !!doc.dhcp.r1, 'the document has a dhcp block for the server', JSON.stringify(Object.keys(doc.dhcp || {})));
  const leases = (doc.dhcp && doc.dhcp.r1 && doc.dhcp.r1.leases) || [];
  ok(leases.length === 2, 'with both leases in it', JSON.stringify(leases));
  ok(leases.every(function (l) { return l.mac && l.ip && l.pool === 'LAN'; }),
    'each naming the holder, the address and the pool', JSON.stringify(leases[0]));
  ok(leases.every(function (l) { return Number.isFinite(l.leaseSec) && Number.isFinite(l.expiresStep); }),
    'and the lease length and its expiry', JSON.stringify(leases[0]));
  const ip1 = bindings[0].ip, mac1 = bindings[0].mac;
  const rec = leases.filter(function (l) { return l.mac === mac1; })[0];
  ok(!!rec && rec.ip === ip1, 'the saved record is the binding the server reported', JSON.stringify(rec));

  const empty = JSON.parse(JSON.stringify(new Topology().serialize()));
  ok(empty.dhcp === undefined, 'a board with no lease writes no dhcp block at all', JSON.stringify(Object.keys(empty)));
}

console.log('');
console.log('A reopened lab still knows who holds what:');
{
  const L = leasedLab();
  const R = reopen(L);
  ok(R.t.dhcpStates.size === 1, 'the topology restored one server state', String(R.t.dhcpStates.size));
  const rows = R.sim.dhcpBindings('r1');
  ok(rows.length === 2, 'and its bindings are there before anything is run', String(rows.length));
  ok(rows.every(function (r) { return r.pool === 'LAN'; }), 'each still naming its pool', '');
  const view = new CliSession(R.t.getDevice('r1'), R.t, R.sim).run('show ip dhcp binding').output.join('\n');
  ok(view.indexOf('nothing has asked this server') === -1,
    'the view no longer claims nobody asked', view);
  ok(/10\.0\.0\.10[01]/.test(view), 'the addresses are printed', view);
}

console.log('');
console.log('Without a clock the view states no lease state:');
{
  const R = reopen(leasedLab());
  const text = new CliSession(R.t.getDevice('r1'), R.t, R.sim).run('show ip dhcp binding').output.join('\n');
  ok(/no clock/i.test(text), 'the expiry column says there is no clock', text);
  ok(text.indexOf('active binding') === -1, 'and nothing is called active', text);
  ok(/2 binding\(s\); no clock is set/.test(text), 'the summary counts bindings, not states', text);
  ok(/none is lapsed or active yet/.test(text), 'and says why it will not say', text);
}

console.log('');
console.log('With a clock, the same rows become states again:');
{
  const R = reopen(leasedLab());
  R.sim.runAtMs = 5000;
  R.sim.computeDhcp();
  const atGrant = new CliSession(R.t.getDevice('r1'), R.t, R.sim).run('show ip dhcp binding').output.join('\n');
  ok(/2 active binding\(s\)/.test(atGrant), 'at the granting instant both are active', atGrant);
  ok(/\b60s\b/.test(atGrant), 'with the lease length left', atGrant);
  R.sim.runAtMs = 200000;
  R.sim.computeDhcp();
  const later = new CliSession(R.t.getDevice('r1'), R.t, R.sim).run('show ip dhcp binding').output.join('\n');
  ok(/lapsed \(address free\)/.test(later), 'past the expiry they read as lapsed', later);
  ok(/0 active binding\(s\), 2 lapsed/.test(later), 'and the summary counts them that way', later);
}

console.log('');
console.log('The lease codec cannot restore two disagreeing maps:');
{
  const rec = { leases: [
    { mac: '02:00:00:00:aa:01', ip: '10.0.0.100', pool: 'LAN', leaseSec: 60, expiresStep: 180 },
    { mac: '02:00:00:00:aa:02', ip: '10.0.0.100', pool: 'LAN', leaseSec: 60, expiresStep: 180 },
    { mac: '02:00:00:00:aa:03', ip: null, pool: 'LAN' },
    { ip: '10.0.0.101', pool: 'LAN' }
  ] };
  // The decoder is the thing under test, so its absence must read as a failure, not as a crash: a suite that throws
  // here reports nothing about the eighteen checks above the throw.
  const codec = typeof dhcpLib.leaseStateFromJSON === 'function' && typeof dhcpLib.leaseStateToJSON === 'function';
  ok(codec, 'the lease state has a decoder and an encoder to round-trip with');
  const state = codec ? dhcpLib.leaseStateFromJSON(rec) : new Map() && dhcpLib.createLeaseState();
  ok(state.leases.size === 1, 'one address, one holder', String(state.leases.size));
  ok(state.leases.get('02:00:00:00:aa:01').ip === '10.0.0.100', 'the first holder keeps it', '');
  ok(state.byIp.get('10.0.0.100') === '02:00:00:00:aa:01', 'and the address map agrees with the MAC map', '');
  ok(!state.leases.has('02:00:00:00:aa:03'), 'an entry with no address is dropped', '');
  ok(!state.leases.has(undefined), 'and so is one with no holder', '');
  const back = codec ? dhcpLib.leaseStateToJSON(state) : { leases: [] };
  ok(back.leases.length === 1 && back.leases[0].mac === '02:00:00:00:aa:01',
    'the encoder writes back what the decoder kept', JSON.stringify(back.leases));
  const empty = codec ? dhcpLib.leaseStateFromJSON(null) : dhcpLib.createLeaseState();
  ok(empty.leases.size === 0 && empty.byIp.size === 0, 'nothing decodes to an empty state, not a crash', '');
}

console.log('');
console.log('A document naming a device that is not on the board is skipped:');
{
  const L = leasedLab();
  const doc = JSON.parse(JSON.stringify(L.t.serialize()));
  doc.dhcp.ghost = { leases: [{ mac: '02:00:00:00:bb:01', ip: '10.0.0.200', pool: 'LAN', leaseSec: 60, expiresStep: 999 }] };
  const t = Topology.fromJSON(doc);
  ok(!t.dhcpStates.has('ghost'), 'the ghost server is not restored', '');
  ok(t.dhcpStates.has('r1'), 'the real one still is', '');
}

console.log('');
console.log('The checked-in examples carry no leases, so nothing else moved:');
{
  const dir = path.join(__dirname, '..', 'examples');
  const files = fs.readdirSync(dir).filter(function (f) { return /\.json$/.test(f); });
  let withDhcp = [];
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (doc && doc.dhcp) withDhcp.push(f);
  }
  ok(withDhcp.length === 0, 'no example gained a dhcp block', withDhcp.join(','));
  ok(files.length > 0, 'and the examples were actually read', String(files.length));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
