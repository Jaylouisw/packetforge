'use strict';
// A route whose next hop is on no subnet of the router read as installed (#1439).
//
// `routeNote()` asked which port a route leaves by, and when the answer was "none" it returned no note at all -
// so the row was reported as healthy. On a router holding only `10.0.0.1/24`:
//
//   r1(config)# ip route 192.168.50.0 255.255.255.0 172.16.9.1
//   r1> show ip route
//   S  192.168.50.0   /24  [1/0] via 172.16.9.1          <- no caveat: reads as an installed route
//   r1> ping 192.168.50.5
//   "no usable egress interface"                          <- the data plane could not use it at all
//
// The table already knew how to say a row cannot carry anything (`(not installed: ...)`, `(administratively down
// (shut down))`, `(gone)`); the one case where there is *nowhere to send the packet* said nothing. And
// `Gateway of last resort is 172.16.9.1` named a gateway no packet could reach.
//
// The row is printed - it is configuration, and `routeTo()` still finds it, exactly like a connected route on a
// shut port - but it now carries the reason, and the data plane's drop names the next hop it could not reach
// instead of the vaguer "no usable egress interface" that sent the reader looking for a port.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const flowLib = require('../engine/flow');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('spec not found: ' + v + '/' + m);
  return s;
}
const ROUTER = spec('generic', 'generic-router');
const PC = spec('generic', 'generic-pc');

function lab(extra) {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const a = t.addDevice(PC, 'a');
  t.connect('a', 'eth0', 'r1', 'Gi0/0');
  const fs = flowLib.createFlowState();
  const sim = new Simulator(t, { flowState: fs });
  runCommands(r1, t, sim, ['configure terminal', 'interface Gi0/0',
    'ip address 10.0.0.1 255.255.255.0', 'end']);
  runCommands(a, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.10 255.255.255.0', 'exit', 'ip default-gateway 10.0.0.1', 'end']);
  if (extra && extra.length) {
    runCommands(r1, t, sim, ['configure terminal'].concat(extra).concat(['end']));
  }
  return { t: t, sim: sim, fs: fs, r1: r1, a: a };
}
function lines(out) { return (out && out.lines) ? out.lines : []; }
function showRoute(L) { return lines(runCommands(L.r1, L.t, L.sim, ['show ip route'])); }
function rowFor(L, dest) {
  return (L.r1.routesTable(L.t) || []).filter(function (r) { return r.dest === dest; })[0] || null;
}
// The row for one prefix, matched on the column it sits in: `indexOf('0.0.0.0')` also matches the connected
// `10.0.0.0/24` row, which is how the first version of this test passed while reading the wrong line.
function printedFor(linesOut, dest) {
  return linesOut.filter(function (l) {
    const t = l.trim().split(/\s+/);
    return t.length > 2 && t[1] === dest && /^\//.test(t[2]) && !/^Codes:/.test(l);
  })[0] || '';
}

// ---------------------------------------------------------------------------
// A. A next hop on no subnet the router holds.
// ---------------------------------------------------------------------------
console.log('Scenario A: `ip route ... via 172.16.9.1` on a router that only holds 10.0.0.0/24');
const A = lab(['ip route 192.168.50.0 255.255.255.0 172.16.9.1']);
{
  const row = rowFor(A, '192.168.50.0');
  ok(!!row, 'the route is in the table (it is configuration)');
  ok(!!row && row.note === '(no interface on the subnet of next hop 172.16.9.1)',
    'the row says why it cannot carry anything', row && row.note);
  ok(!!row && row.unusable === true, 'and is marked unusable, not healthy', row && String(row.unusable));

  const printed = printedFor(showRoute(A), '192.168.50.0');
  ok(/\(no interface on the subnet of next hop 172\.16\.9\.1\)/.test(printed),
    '`show ip route` prints that reason on the row', printed);

  const ping = A.sim.ping(A.a.id, '192.168.50.5', { count: 1 });
  const reason = String(ping.replies[0].reason || '');
  ok(/no interface on the subnet of next hop 172\.16\.9\.1/.test(reason),
    'a ping that dies on it names the next hop', reason);
  ok(/192\.168\.50\.5/.test(reason), 'and the destination it was routing to', reason);
  ok(reason !== 'no usable egress interface', 'instead of the sentence that named neither', reason);

  const drops = flowLib.counterSnapshot(A.fs, A.r1.id).drops.byReason;
  const keys = Object.keys(drops || {});
  ok(keys.length === 1 && /no interface on the subnet of next hop 172\.16\.9\.1/.test(keys[0]),
    'the counters file the loss under the same sentence', JSON.stringify(keys));
  ok(keys.length === 1 && drops[keys[0]] === 1, 'once, not once per attempt', JSON.stringify(drops));

  // One rule, one place: the payload row and the printed row are the same verdict.
  ok(printed.indexOf(row.note) !== -1, 'the printed row and the payload row carry the identical sentence');
}

// ---------------------------------------------------------------------------
// B. A default route through a gateway no packet can reach.
// ---------------------------------------------------------------------------
console.log('Scenario B: a default route through an unreachable gateway');
{
  const L = lab(['ip route 0.0.0.0 0.0.0.0 172.16.9.1']);
  const out = showRoute(L);
  ok(!out.some(function (l) { return /^Gateway of last resort/.test(l); }),
    'no "Gateway of last resort" line names a gateway that cannot be reached',
    out.filter(function (l) { return /Gateway/.test(l); }).join(' | '));
  ok(/\(no interface on the subnet of next hop 172\.16\.9\.1\)/.test(printedFor(out, '0.0.0.0')),
    'the default is still printed, with its reason', printedFor(out, '0.0.0.0'));
}

// ---------------------------------------------------------------------------
// C. With a usable default beside the unusable one, the line names the usable one.
// ---------------------------------------------------------------------------
console.log('Scenario C: two defaults, only one of them reachable');
{
  const L = lab([
    'ip route 0.0.0.0 0.0.0.0 172.16.9.1',
    'ip route 0.0.0.0 0.0.0.0 10.0.0.99'
  ]);
  const out = showRoute(L);
  const gw = out.filter(function (l) { return /^Gateway of last resort is/.test(l); })[0] || '';
  ok(gw.indexOf('10.0.0.99') !== -1, 'the gateway line names the reachable next hop', gw);
  ok(gw.indexOf('172.16.9.1') === -1, 'and not the unreachable one', gw);
  const rows = (L.r1.routesTable(L.t) || []).filter(function (r) { return r.dest === '0.0.0.0'; });
  ok(rows.length === 2, 'both defaults are still in the table', String(rows.length));
  ok(rows.filter(function (r) { return r.gw === '10.0.0.99'; })[0].note === '',
    'the reachable one carries no fault note');
  ok(rows.filter(function (r) { return r.gw === '172.16.9.1'; })[0].unusable === true,
    'the unreachable one does');
}

// ---------------------------------------------------------------------------
// D. Regressions: a next hop the router *can* reach keeps reading as healthy.
// ---------------------------------------------------------------------------
console.log('Scenario D: a reachable next hop is unchanged');
{
  const L = lab(['ip route 192.168.50.0 255.255.255.0 10.0.0.99']);
  const row = rowFor(L, '192.168.50.0');
  ok(row && row.note === '' && row.unusable === false,
    'a next hop on a connected subnet has no note', row && JSON.stringify({ note: row.note, unusable: row.unusable }));
  const printed = printedFor(showRoute(L), '192.168.50.0');
  ok(!/no interface/.test(printed), 'and `show ip route` prints it plainly', printed);

  // ... and it really does carry a frame: the next hop answers ARP at the far end of the cable.
  const L2 = lab(['ip route 192.168.50.0 255.255.255.0 10.0.0.99']);
  const ping = L2.sim.ping(L2.a.id, '192.168.50.5', { count: 1 });
  ok(/no ARP reply from 10\.0\.0\.99/.test(String(ping.replies[0].reason)),
    'the loss is ARP silence at a reachable next hop, not a routing problem',
    String(ping.replies[0].reason));
}

// ---------------------------------------------------------------------------
// E. The other two shapes still say what they always said.
// ---------------------------------------------------------------------------
console.log('Scenario E: a shut port and a missing port');
{
  const L = lab(['ip route 192.168.50.0 255.255.255.0 10.0.0.99']);
  runCommands(L.r1, L.t, L.sim, ['configure terminal', 'interface Gi0/0', 'shutdown', 'end']);
  const row = rowFor(L, '192.168.50.0');
  ok(row && /would leave by Gi0\/0, which cannot carry: administratively down/.test(row.note) && row.unusable === true,
    'a next hop behind a shut port names that port, and says it cannot carry', row && row.note);
  ok(!/no interface on the subnet/.test(row.note), 'and does not claim the next hop is off-subnet', row.note);
}
{
  // The console refuses a port this box does not have, so this shape arrives from a saved document - a route
  // written when the port existed, or one hand-edited. The row must still say which port is gone.
  const L = lab();
  L.r1.config.routes.push({ dest: '192.168.50.0', mask: '255.255.255.0', gw: '10.0.0.99', iface: 'Gi0/9' });
  const row = rowFor(L, '192.168.50.0');
  ok(row && /gone: Gi0\/9 is not a port on this device/.test(row.note),
    'a route naming a port the box does not have says that instead', row && row.note);
  ok(!!row && row.unusable === true, 'and is marked unusable', row && String(row.unusable));
}

// ---------------------------------------------------------------------------
// F. The reason ranks where a "cannot send at all" cause belongs: above silence and above policy.
// ---------------------------------------------------------------------------
console.log('Scenario F: the ranking');
{
  const sim = A.sim;
  const routed = { type: 'drop', dev: 'r1', reason: 'no interface on the subnet of next hop 172.16.9.1 (route to 8.8.8.8)' };
  const silence = { type: 'drop', dev: 'a', iface: 'eth0', discard: true, reason: 'no ARP reply from 10.9.9.9' };
  const acl = { type: 'acl-deny', dev: 'r1', iface: 'Gi0/0', dir: 'in', acl: '110' };
  ok(sim._lastDiscard([routed]) === routed.reason, 'the routing cause is reported on its own');
  ok(sim._lastDiscard([silence, routed]) === routed.reason,
    'a next hop that cannot be reached outranks silence');
  ok(sim._lastDiscard([acl, routed]) === routed.reason,
    'and outranks a policy denial on a device the packet never reached');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
