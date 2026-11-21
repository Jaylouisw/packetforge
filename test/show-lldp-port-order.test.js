'use strict';
// `show lldp neighbors` is read down the Local Intf column, so the column is in port order: 2, then 9,
// then 10. The engine sorted the rows with `localeCompare`, and string order puts `Gi1/0/10` before
// `Gi1/0/2` - on a 24-port switch the tenth socket was printed above the second. A vendor capture with
// ten or more ports runs 9, 10, 11 ... (Cisco Nexus 3500 NX-API CLI reference, `show lldp neighbors`,
// Eth1/9 to Eth1/48), and the Catalyst 1300 and Aruba samples run 1, 2, 3. No capture prints the column
// as text. The rule and the one counter-example (an IOS-XE ASR 920 sample that groups by neighbour) are
// in research/show-lldp-neighbor-row-order.md; the comparator is the panel-order one the PoE allocator
// already uses (`ifaceName.comparePortNames`).
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
const SWITCH = catalog.filter(function (s) { return s.model === 'C2960X-24TS-L'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];

// Cabled in an order that is neither port order nor string order, so an implementation that keeps
// insertion order cannot pass either.
function lab() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw1');
  const ports = ['Gi1/0/10', 'Gi1/0/2', 'Gi1/0/9'];
  ports.forEach(function (p) {
    const name = 'pc' + p.split('/').pop();
    t.addDevice(PC, name);
    t.connect(name, 'eth0', 'sw1', p);
  });
  const sim = new Simulator(t);
  runCommands(sw, t, sim, ['configure terminal', 'lldp run', 'end']);
  ports.forEach(function (p) { sim.ping('pc' + p.split('/').pop(), '255.255.255.255', { count: 1 }); });
  return { t: t, sim: sim, sw: sw };
}

function rows(env) {
  const lines = ((new CliSession(env.sw, env.t, env.sim).run('show lldp neighbors').output) || []).map(String);
  const header = lines.findIndex(function (l) { return /^Device ID/.test(l); });
  const body = lines.slice(header + 1).filter(function (l) {
    return l.trim() && !/^\s{2}\(/.test(l) && !/^Total entries displayed:/.test(l);
  });
  return {
    lines: lines,
    body: body,
    ports: body.map(function (l) { return l.slice(20, 35).trim(); })
  };
}

console.log('');
console.log('The Local Intf column reads in port order, not string order:');
{
  const env = lab();
  const out = rows(env);
  ok(out.ports.length === 3, 'three neighbours are listed', JSON.stringify(out.ports));
  ok(JSON.stringify(out.ports) === JSON.stringify(['Gi1/0/2', 'Gi1/0/9', 'Gi1/0/10']),
    'ports print 2, 9, 10 - the panel order', JSON.stringify(out.ports));
  const two = out.ports.indexOf('Gi1/0/2');
  const ten = out.ports.indexOf('Gi1/0/10');
  ok(two !== -1 && ten !== -1 && two < ten,
    'the tenth socket is below the second, where a box prints it', JSON.stringify(out.ports));
  ok(out.body.every(function (l) { return /PC-pc\d+\s+Gi1\/0\/\d+\s+120\s+S\s+eth0/.test(l); }),
    'every row still carries its five fields', out.body.join(' | '));
  const total = out.lines.filter(function (l) { return /^Total entries displayed:/.test(l); })[0];
  ok(total === 'Total entries displayed: 3', 'the count still counts the rows', total);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
