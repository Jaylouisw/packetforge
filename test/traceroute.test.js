'use strict';
// traceroute.test.js — the forwarding path, hop by hop. Before it existed the only
// way to learn which way traffic went was to read the flow event log and infer it.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('spec not found: ' + v + '/' + m);
  return s;
}

function build() {
  const t = new Topology();
  const pc1 = t.addDevice(spec('generic', 'generic-pc'));
  const pc2 = t.addDevice(spec('generic', 'generic-pc'));
  const r1 = t.addDevice(spec('generic', 'generic-router'));
  const r2 = t.addDevice(spec('generic', 'generic-router'));
  pc1.name = 'PC1'; pc2.name = 'PC2'; r1.name = 'R1'; r2.name = 'R2';
  t.connect(pc1.id, 'eth0', r1.id, 'Gi0/0');
  t.connect(r1.id, 'Gi0/1', r2.id, 'Gi0/0');
  t.connect(r2.id, 'Gi0/1', pc2.id, 'eth0');
  const sim = new Simulator(t);
  const cfg = function (dev, cmds) {
    runCommands(dev, t, sim, ['configure terminal'].concat(cmds));
  };
  cfg(pc1, ['interface eth0', 'ip address 10.0.1.10 255.255.255.0', 'exit',
    'ip default-gateway 10.0.1.1']);
  cfg(pc2, ['interface eth0', 'ip address 10.0.2.20 255.255.255.0', 'exit',
    'ip default-gateway 10.0.2.1']);
  cfg(r1, ['interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.12.1 255.255.255.0', 'exit',
    'ip route 10.0.2.0 255.255.255.0 10.0.12.2']);
  cfg(r2, ['interface Gi0/0', 'ip address 10.0.12.2 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0', 'exit',
    'ip route 10.0.1.0 255.255.255.0 10.0.12.1']);
  return { t: t, sim: sim, pc1: pc1, pc2: pc2, r1: r1, r2: r2 };
}

const L = build();
function trace(dev, arg) {
  return runCommands(dev, L.t, L.sim, ['enable', 'traceroute ' + arg]).lines.join('\n');
}

const out = trace(L.pc1, '10.0.2.20');
ok(/Tracing the route to 10\.0\.2\.20/.test(out), 'traceroute names the target');
ok(/^\s+1\s+10\.0\.1\.1/m.test(out), 'hop 1 is the default gateway');
ok(/^\s+2\s+10\.0\.12\.2/m.test(out), 'hop 2 is the second router on the transit link');
ok(/^\s+3\s+10\.0\.2\.20\s+.*\(destination\)/m.test(out), 'the last hop is the destination');
ok(/R1/.test(out) && /R2/.test(out) && /PC2/.test(out), 'each hop names the device it landed on');
ok(/Path: PC1 -> R1 -> R2 -> PC2\s+\(3 hops\)/.test(out), 'the summary spells out the path');
ok(/(us|ms)\b/.test(out), 'each hop carries a delay');
ok(!/no reply/.test(out), 'a walkable path reports no stars');

// Delays grow down the list: the column is cumulative one-way time, not jitter.
const times = [];
const re = /^\s+\d+\s+\S+\s+([\d.]+)\s+(ns|us|ms|s)\b/gm;
let m;
while ((m = re.exec(out)) !== null) {
  const mul = { ns: 1e-9, us: 1e-6, ms: 1e-3, s: 1 }[m[2]];
  times.push(Number(m[1]) * mul);
}
ok(times.length === 3, 'three measured hops');
ok(times.length === 3 && times[0] <= times[1] && times[1] <= times[2], 'cumulative delay never decreases');

// A host with no route says why instead of printing an empty table.
const dead = build();
const orphan = dead.t.addDevice(spec('generic', 'generic-pc'));
orphan.name = 'ORPHAN';
runCommands(orphan, dead.t, dead.sim, ['configure terminal', 'interface eth0',
  'ip address 192.168.5.5 255.255.255.0']);
const none = runCommands(orphan, dead.t, dead.sim, ['enable', 'traceroute 8.8.8.8']).lines.join('\n');
ok(/\*  \*  \*/.test(none), 'an unroutable target prints stars');
ok(/% no route to 8\.8\.8\.8 on ORPHAN/.test(none), 'and names the device that had no route');

const bad = runCommands(L.pc1, L.t, L.sim, ['enable', 'traceroute 999.1.1.1']).lines.join('\n');
ok(/% Invalid traceroute target/.test(bad), 'a malformed address is refused');

const alias = runCommands(L.pc1, L.t, L.sim, ['enable', 'tracert 10.0.2.20']).lines.join('\n');
ok(/Path: PC1 -> R1 -> R2 -> PC2/.test(alias), 'tracert is an accepted alias');

// Directly connected: one hop, the destination itself.
const one = runCommands(L.r2, L.t, L.sim, ['enable', 'traceroute 10.0.2.20']).lines.join('\n');
ok(/\(1 hop\)/.test(one), 'a directly connected target is a single hop');
ok(/Path: R2 -> PC2/.test(one), 'and the chain is just the neighbour');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
