'use strict';
// The cost OSPF puts on a link nobody configured - the number that decides which path SPF takes.
//
// A Cisco box with the default configuration computes cost = 10^8 / bandwidth (100 Mbps reference),
// truncated, minimum 1: 10 Mbps costs 10, 100 Mbps and anything faster costs 1, a T1 costs 64. The
// engine divided by 10 Gbps instead (100M -> 100, 1G -> 10, 2.5G -> 4), the arithmetic of
// `auto-cost reference-bandwidth 10000` - a command this console does not have. On a real default box
// a 100 Mbps port and a gigabit port are equal-cost, so a lab that mixed them could not show why one
// path was preferred; the engine preferred the gigabit one for a reason the device would never state.
//
// Sources for the formula and the default:
//   * Cisco IOS XR OSPF command reference, `auto-cost (OSPF)`: "The OSPF metric is calculated as the
//     mbps value divided by bandwidth, with mbps equal to 10^8 by default ... the default path cost is 1
//     for any interface that has a link bandwidth of 100 Mbps or higher."
//     http://www.cisco.com/c/en/us/td/docs/ios_xr_sw/iosxr_r3-7/routing/command/reference/rr37ospf.pdf
//   * Cisco "How to configure OSPF cost": default reference 100 Mbps; FE = 1; change
//     auto-cost reference-bandwidth to differentiate links above 100 Mbps.
//     https://community.cisco.com/t5/networking-knowledge-base/how-to-configure-ospf-cost/ta-p/3133153
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const ospf = require('../engine/ospf');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const specs = loadCatalog(require('path').join(__dirname, '..', 'devices'))
  .filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /^ISR 4331$/.test(s.model); }) ||
  specs.find(function (s) { return /ISR 4331/.test(s.model); });

console.log('');
console.log('The reference-bandwidth table, at the rates the device files use:');
{
  const cases = [
    ['10M', 10, '10 Mbps is 10 under a 100 Mbps reference'],
    ['100M', 1, '100 Mbps is 1 - the reference rate itself'],
    ['1G', 1, 'a gigabit port is 1, not 0.1: cost is a whole number'],
    ['2.5G', 1, '2.5 Gbps is 1'],
    ['5G', 1, '5 Gbps is 1'],
    ['10G', 1, '10 Gbps is 1'],
    ['40G', 1, '40 Gbps is 1'],
    ['100G', 1, '100 Gbps is 1']
  ];
  for (const c of cases) {
    ok(ospf.costForSpeed(c[0]) === c[1], c[2],
      String(ospf.costForSpeed(c[0])));
  }
  ok(ospf.costForSpeedMbps(1.544) === 64, 'a T1 (1.544 Mbps) is 64, as the vendor tables print it',
    String(ospf.costForSpeedMbps(1.544)));
  ok(ospf.costForSpeedMbps(0.064) === 1562, 'a 64 kbps serial line is 1562',
    String(ospf.costForSpeedMbps(0.064)));
  ok(ospf.costForSpeed(null) === ospf.DEFAULT_COST, 'no rate is not a rate: falls back to DEFAULT_COST',
    String(ospf.costForSpeed(null)));
  ok(ospf.costForSpeed('auto') === ospf.DEFAULT_COST, 'an unparseable rate falls back rather than inventing one',
    String(ospf.costForSpeed('auto')));
  ok(ospf.costForSpeedMbps(0) === ospf.DEFAULT_COST, 'zero is not a link rate',
    String(ospf.costForSpeedMbps(0)));
}

console.log('');
console.log('The derived cost reaches the engine, and a typed cost still outranks it:');
{
  const t = new Topology();
  ['r1', 'r2'].forEach(function (id) { t.addDevice(ROUTER, id); });
  t.connect('r1', 'Gi0/0/0', 'r2', 'Gi0/0/0', { mediaId: '1000base-t', speedMbps: 1000 });
  const a = t.getDevice('r1').interfaces.get('Gi0/0/0');
  const b = t.getDevice('r2').interfaces.get('Gi0/0/0');
  a.ip = '10.0.12.1'; a.mask = '255.255.255.0';
  b.ip = '10.0.12.2'; b.mask = '255.255.255.0';
  a.speed = '100M';   // the port is a Fast Ethernet one, whatever the cable could carry
  b.speed = '1G';

  const s1 = new CliSession(t.getDevice('r1'), t, null);
  ['enable', 'configure terminal', 'ospf router-id 1.1.1.1', 'interface Gi0/0/0'].forEach(function (c) {
    s1.run(c);
  });
  const s2 = new CliSession(t.getDevice('r2'), t, null);
  ['enable', 'configure terminal', 'ospf router-id 2.2.2.2', 'interface Gi0/0/0'].forEach(function (c) {
    s2.run(c);
  });

  const sim = new Simulator(t);
  sim.computeOspf();
  const ia = t.getDevice('r1').ospfInterfaces.filter(function (i) { return i.name === 'Gi0/0/0'; })[0];
  const ib = t.getDevice('r2').ospfInterfaces.filter(function (i) { return i.name === 'Gi0/0/0'; })[0];
  ok(ia.cost === 1, 'a 100 Mbps port derives cost 1', String(ia.cost));
  ok(ib.cost === 1, 'and the gigabit port at the other end does too', String(ib.cost));
  ok(ia.costSource === 'derived', 'the report says the rate decided it, not an operator', ia.costSource);

  // The edge cost is the sum of the two interface costs, so 1 + 1 = 2 - not 100 + 10 = 110.
  const adj = ospf.adjacencies(ospf.buildGraph(
    [{ id: 'r1', routerId: '1.1.1.1', areaId: 0, interfaces: [{ name: 'Gi0/0/0', ip: '10.0.12.1', mask: '255.255.255.0', cost: 1 }] },
      { id: 'r2', routerId: '2.2.2.2', areaId: 0, interfaces: [{ name: 'Gi0/0/0', ip: '10.0.12.2', mask: '255.255.255.0', cost: 1 }] }],
    [{ a: { router: 'r1', iface: 'Gi0/0/0' }, b: { router: 'r2', iface: 'Gi0/0/0' } }]));
  ok(adj[0].cost === 2, 'the link between them costs 1 + 1 = 2', String(adj[0].cost));

  // A typed cost is still the operator's decision, and the report must not claim it was derived.
  s1.run('ip ospf cost 25');
  const sim2 = new Simulator(t);
  sim2.computeOspf();
  const typed = t.getDevice('r1').ospfInterfaces.filter(function (i) { return i.name === 'Gi0/0/0'; })[0];
  ok(typed.cost === 25 && typed.costSource === 'configured',
    '`ip ospf cost 25` stays 25 and is reported as configured',
    JSON.stringify({ cost: typed.cost, source: typed.costSource }));

  const out = (((new CliSession(t.getDevice('r1'), t, sim2).run('show ip ospf interface')) || {}).output || [])
    .map(String).filter(function (l) { return l.indexOf('Gi0/0/0 ') === 0; })[0] || '';
  ok(/\b25\b/.test(out) && /configured/.test(out), 'and the console prints the same pair', out);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
