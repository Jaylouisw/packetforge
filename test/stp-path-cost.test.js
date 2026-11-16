'use strict';
// What a port costs in the spanning tree before anybody configures a cost, and which path a mixed-speed ring
// therefore roots through (#1585).
//
// The engine used the 32-bit path-cost numbers (1 Gb: 20,000) under a comment that called them the short ones,
// and `engine/simulator.js` kept a second copy of the same table that disagreed with the first at 40 Gb (400
// where the table says 500). Cisco's default is the *short* method - 10 Mb: 100, 100 Mb: 19, 1 Gb: 4, 10 Gb: 2,
// 25 Gb: 1, 40 Gb: 1, 100 Gb: 1 - so a 1 Gb port cost 5,000x what the switch it imitates charges, and a ring
// where one path is a single 100 Mb hop and the other is five 1 Gb hops rooted the wrong way.
const path = require('path');
const stp = require('../engine/stp');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const cost = stp.costForSpeedMbps;

// ---------------------------------------------------------------------------
console.log('the vendor’s short path-cost table, speed by speed');
{
  const rows = [[10, 100], [100, 19], [1000, 4], [10000, 2], [25000, 1], [40000, 1], [100000, 1]];
  for (const row of rows) {
    ok(cost(row[0]) === row[1], row[0] + ' Mb/s costs ' + row[1], String(cost(row[0])));
  }
  // The long-method numbers are the ones this file used to return, and they are five thousand times the short
  // ones at 1 Gb. A regression that swaps the table back is exactly this assertion.
  ok(cost(1000) !== 20000 && cost(100) !== 200000 && cost(10000) !== 2000,
    'the long path-cost numbers (20,000 / 200,000 / 2,000) are gone');
}

// ---------------------------------------------------------------------------
console.log('\na speed with no row of its own takes the next slower documented cost');
{
  ok(cost(2500) === 4, '2.5 Gb costs what 1 Gb costs (4)', String(cost(2500)));
  ok(cost(5000) === 4, '5 Gb costs what 1 Gb costs (4)', String(cost(5000)));
  ok(cost(200) === 19, '200 Mb costs what 100 Mb costs (19)', String(cost(200)));
  ok(cost(2000) === 4, '2 Gb costs what 1 Gb costs (4)', String(cost(2000)));
  ok(cost(400000) === 1, 'anything faster than the table costs what 100 Gb costs (1)', String(cost(400000)));
  ok(cost(5) === 100, 'anything slower than the table costs what 10 Mb costs (100)', String(cost(5)));
  // Cost must never rise as the link gets faster, or a faster ring would block a slower one.
  const speeds = [10, 100, 200, 1000, 2000, 2500, 5000, 10000, 25000, 40000, 100000, 400000];
  let monotonic = true;
  for (let i = 1; i < speeds.length; i++) if (cost(speeds[i]) > cost(speeds[i - 1])) monotonic = false;
  ok(monotonic, 'cost never rises with a faster link');
  // A port whose speed is unknown - a link that has not negotiated one - is not free and is not infinite.
  ok(cost(null) === 4 && cost(undefined) === 4 && cost(0) === 4 && cost('nonsense') === 4,
    'a port with no known speed costs like a 1 Gb port (4)',
    [cost(null), cost(undefined), cost(0), cost('nonsense')].join('/'));
}

// ---------------------------------------------------------------------------
console.log('\nthe election uses the short costs, not the long ones');
{
  // Root R at priority 0. A reaches R two ways: one 100 Mb hop (19), or five 1 Gb hops through B, C, D and E
  // (4 each = 20). The short method roots A through the 100 Mb port. With the long numbers the chain costs
  // 5 x 20,000 = 100,000 against 200,000, so A rooted the other way and blocked the fast link.
  const P = function (name, speed, to) { return { name: name, speedMbps: speed, to: to }; };
  const B = function (key, priority, ports) {
    return { key: key, priority: priority, mac: '00:00:00:00:00:' + key, ports: ports };
  };
  const res = stp.runStp({
    bridges: [
      B('R', 0, [P('rA', 100, { bridge: 'A', port: 'pR' }), P('rB', 1000, { bridge: 'B', port: 'pR' })]),
      B('A', 32768, [P('pR', 100, { bridge: 'R', port: 'rA' }), P('pE', 1000, { bridge: 'E', port: 'pA' })]),
      B('B', 32768, [P('pR', 1000, { bridge: 'R', port: 'rB' }), P('pC', 1000, { bridge: 'C', port: 'pB' })]),
      B('C', 32768, [P('pB', 1000, { bridge: 'B', port: 'pC' }), P('pD', 1000, { bridge: 'D', port: 'pC' })]),
      B('D', 32768, [P('pC', 1000, { bridge: 'C', port: 'pD' }), P('pE', 1000, { bridge: 'E', port: 'pD' })]),
      B('E', 32768, [P('pD', 1000, { bridge: 'D', port: 'pE' }), P('pA', 1000, { bridge: 'A', port: 'pE' })])
    ]
  });
  ok(res.ports.A.pR.cost === 19 && res.ports.A.pE.cost === 4, 'the two ports carry the short costs (19 and 4)',
    res.ports.A.pR.cost + '/' + res.ports.A.pE.cost);
  ok(res.ports.A.pR.role === 'root', 'A roots through the single 100 Mb hop (19 < 20)', res.ports.A.pR.role);
  ok(res.ports.A.pE.state === 'blocking', 'and blocks its end of the five-hop chain', res.ports.A.pE.state);
}

// ---------------------------------------------------------------------------
console.log('\nthe simulator and the library charge the same cost');
{
  const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
  const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
  const t = new Topology();
  const a = t.addDevice(SWITCH, 'sa');
  const b = t.addDevice(SWITCH, 'sb');
  t.connect('sa', 'Fa0/1', 'sb', 'Fa0/1');
  const sim = new Simulator(t);
  sim.computeStp();
  ok(sim.stpResult.ports.sa['Fa0/1'].cost === 4, 'a 1 Gb cable costs 4 in the election',
    String(sim.stpResult.ports.sa['Fa0/1'].cost));
  // The same cable at 100 Mb, forced on both ends: 19. This is the number the second table could not produce,
  // because it had no row for 100 Mb at all and returned 200,000 for anything slower than a gigabit.
  for (const dev of [a, b]) {
    runCommands(dev, t, sim, ['configure terminal', 'interface Fa0/1', 'speed 100']);
  }
  sim.computeStp();
  ok(sim.stpResult.ports.sa['Fa0/1'].cost === 19, 'the same cable at 100 Mb costs 19',
    String(sim.stpResult.ports.sa['Fa0/1'].cost));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
