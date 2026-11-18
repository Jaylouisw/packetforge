'use strict';
// Which ports a PSE powers when its budget is short, and where the budget stops.
//
// The allocation walked the port names through `Array.prototype.sort()`, so a 24-port switch served
// 1/1/10, 1/1/11 and 1/1/12 before 1/1/2: the tens were powered and the twos went dark. Cisco states the only
// ordering it has for power - ports are granted power "in ascending order of the port numbers" and denied it
// "in descending order of the port numbers" - and the comment over this code had always claimed "port order"
// (research/poe-allocation-order.md). The same walk compared watts as floats, so a budget exactly equal to the
// draw of N ports funded N-1 of them.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const ifaceName = require('../engine/iface-name');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, extra) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (extra ? '\n      ' + extra : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}

const PSE = 'CX 6000 24G CL4 PoE 4SFP 370W';
const PD = 'UCG-Ultra';

console.log('Port order is numeric order, not string order:');
const c = ifaceName.comparePortNames;
ok(typeof c === 'function', 'engine/iface-name.js exports comparePortNames');
ok(c('1/1/2', '1/1/10') < 0, '1/1/2 comes before 1/1/10');
ok(c('1/1/10', '1/1/2') > 0, 'and the comparison is antisymmetric');
ok(c('eth2', 'eth10') < 0, 'eth2 before eth10 (RouterOS spelling)');
ok(c('Port 9', 'Port 10') < 0, 'Port 9 before Port 10 (the spaced spelling 17 models use)');
ok(c('Gi0/2', 'Gi0/2') === 0, 'one port compared with itself is equal');
ok(c('Gi0/2', 'Te1/1/1') < 0, 'copper downlinks still sort before the uplinks');
ok(['1/1/10', '1/1/2', '1/1/1'].sort(c).join(',') === '1/1/1,1/1/2,1/1/10',
  'sorting the three names gives the order on the panel');

// Twelve powered devices on ports 1..12, and a budget that covers five of them.
function build(psePorts, budget) {
  const t = new Topology();
  const sw = t.addDevice(spec('aruba', PSE));
  sw.name = 'SW1';
  const pds = [];
  for (let i = 1; i <= psePorts; i++) {
    const pd = t.addDevice(spec('ubiquiti', PD));
    pd.name = 'PD' + i;
    t.connect(pd.id, 'port1', sw.id, '1/1/' + i);
    pds.push(pd);
  }
  sw.poeBudget = budget;
  return { t: t, sw: sw, pds: pds };
}
const draw = build(1, 370).pds[0].interfaces.get('port1').poeIn;

console.log('\nA budget that covers five of twelve ports serves the five lowest:');
const b5 = build(12, draw * 5);
const sim5 = new Simulator(b5.t);
const poe5 = sim5.computePoe()[0];
const order5 = poe5.ports.map(function (p) { return p.iface; });
ok(order5.join(',') === '1/1/1,1/1/2,1/1/3,1/1/4,1/1/5,1/1/6,1/1/7,1/1/8,1/1/9,1/1/10,1/1/11,1/1/12',
  'the allocation walks the ports in port order', order5.join(' '));
const powered5 = poe5.ports.filter(function (p) { return p.powered; }).map(function (p) { return p.iface; });
ok(powered5.length === 5, 'exactly five ports are powered (got ' + powered5.length + ')');
ok(powered5.join(',') === '1/1/1,1/1/2,1/1/3,1/1/4,1/1/5',
  'and they are the five lowest-numbered ones', powered5.join(' '));
ok(poe5.ports.find(function (p) { return p.iface === '1/1/2'; }).powered === true,
  '1/1/2 is powered');
ok(poe5.ports.find(function (p) { return p.iface === '1/1/10'; }).powered === false,
  '1/1/10 is not - string order had it the other way round');
ok(poe5.used === draw * 5, 'power in use is five devices\' worth (' + poe5.used + ' W)');
const denies5 = sim5.events.filter(function (e) { return e.type === 'poe-deny'; })
  .map(function (e) { return e.iface; });
ok(denies5.join(',') === '1/1/6,1/1/7,1/1/8,1/1/9,1/1/10,1/1/11,1/1/12',
  'the denials are the highest-numbered ports, walked downwards from the top', denies5.join(' '));
ok(b5.pds[1].poeUnpowered === false && b5.pds[9].poeUnpowered === true,
  'and the device marks follow: PD2 powered, PD10 dark');

console.log('\nA budget that exactly equals the draw of N ports funds all N:');
ok(Math.round(draw * 1000) === 12950, 'the powered device draws 12.95 W (12950 mW)');
const bExact = build(6, draw * 5);
const simExact = new Simulator(bExact.t);
const poeExact = simExact.computePoe()[0];
ok(poeExact.ports.filter(function (p) { return p.powered; }).length === 5,
  'five 12.95 W devices fit a 64.75 W budget (the float comparison funded four)');
ok(poeExact.used === 64.75, 'and the used figure is the exact 64.75 W, not 64.74999999999999 (' + poeExact.used + ')');

console.log('\nOne hundredth of a watt short, and the last port is the one refused:');
const bShort = build(6, 64.74);
const simShort = new Simulator(bShort.t);
const poeShort = simShort.computePoe()[0];
const poweredShort = poeShort.ports.filter(function (p) { return p.powered; });
ok(poweredShort.length === 4, 'four ports are powered (got ' + poweredShort.length + ')');
const deniedShort = poeShort.ports.filter(function (p) { return !p.powered; });
ok(deniedShort.length === 2, 'the fifth and sixth are refused');
ok(deniedShort[0].iface === '1/1/5', 'the first refusal is 1/1/5, the lowest port that does not fit', deniedShort[0].iface);
ok(/12\.95 W requested, 12\.94 W left/.test(deniedShort[0].reason),
  'and it says what was asked for and what was left: "' + deniedShort[0].reason + '"');

console.log('\nThe console reports the same allocation:');
const out = runCommands(b5.sw, b5.t, sim5, ['enable', 'show power inline']).output;
ok(/1\/1\/2\s+auto\s+on/.test(out), 'the port that is powered reads `on`');
ok(/1\/1\/10\s+auto\s+off/.test(out), 'and the one that lost out reads `off`');
ok(/denied/.test(out), 'with the denial flagged, as the panel flags it');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
