'use strict';
// route-legend.test.js — the `show ip route` legend must name every code the
// table actually uses. It used to print only "C - connected, S - static", so an
// O or B row was real but unexplained by the header.
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

// A router with only connected + static routes: the base legend, no O/B.
{
  const t = new Topology();
  const r = t.addDevice(spec('generic', 'generic-router'));
  const sim = new Simulator(t);
  runCommands(r, t, sim, ['configure terminal',
    'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'ip route 172.16.0.0 255.255.0.0 10.0.0.254']);
  const out = runCommands(r, t, sim, ['enable', 'show ip route']).lines.join('\n');
  ok(/Codes: C - connected, S - static\n/.test(out + '\n'), 'a static-only table has the C/S legend');
  ok(!/O - OSPF/.test(out), 'and does not invent an OSPF entry');
}

// Two OSPF routers: R1 learns R2's stub network, so its legend must name O.
{
  const t = new Topology();
  const r1 = t.addDevice(spec('generic', 'generic-router'));
  const r2 = t.addDevice(spec('generic', 'generic-router'));
  r1.name = 'R1'; r2.name = 'R2';
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  const cfg = function (dev, cmds) {
    runCommands(dev, t, sim, ['configure terminal'].concat(cmds));
  };
  cfg(r1, ['interface Gi0/0', 'ip address 10.0.12.1 255.255.255.0', 'exit',
    'ospf router-id 1.1.1.1', 'ospf area 0']);
  cfg(r2, ['interface Gi0/0', 'ip address 10.0.12.2 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0', 'exit',
    'ospf router-id 2.2.2.2', 'ospf area 0']);

  sim.computeOspf();
  const out = runCommands(r1, t, sim, ['enable', 'show ip route']).lines.join('\n');
  ok(/O - OSPF/.test(out), 'an OSPF route adds O - OSPF to the legend');
  // The rows are rendered by renderTable() now, so a row starts with padding and the marker column
  // rather than with the code - match the code and the prefix, not the start of the line.
  ok(/\bO 10\.0\.2\.0\/24\b/.test(out), 'and the O row is present');
  ok(/\bO 10\.0\.2\.0\/24 +110\b/.test(out), 'with its administrative distance in the AD column');
  ok(!/B - BGP/.test(out), 'a table with no BGP route does not claim B - BGP');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
