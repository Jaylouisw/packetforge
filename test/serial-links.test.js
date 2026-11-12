'use strict';
// Synchronous serial WAN links.
//
// The engine had 64 media types - copper, fibre at nine rates, PON, DAC, DOCSIS, MoCA, DSL,
// powerline, Wi-Fi, cellular - and no concept of a serial cable. That is the one link type a
// Packet Tracer lab reaches for first: two routers back to back, one end DCE, `clock rate`,
// an IP each, and a ping. The catalogue had no device with a serial port either, so the
// whole exercise was impossible rather than merely unmodelled.
//
// What is locked here:
//   1. serial is a connector family of its own, with one medium (V.35) and a clocked ladder;
//   2. it mates with itself and refuses RJ45 - a V.35 cable does not go into an Ethernet port;
//   3. a serial link needs exactly one clock: neither end is refused, both ends are refused;
//   4. the link's rate is the clock, not the fastest rate the hardware could reach;
//   5. `clock rate` is refused on a non-serial port and for a rate the port cannot clock;
//   6. the Cisco 2811 exists, with two onboard 10/100 ports and two WIC-2T serial ports;
//   7. traffic actually crosses a clocked link.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const media = require('../engine/media');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.log('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) +
    ', got ' + JSON.stringify(actual) + ')');
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(model) { return catalog.find(function (x) { return x.model === model; }); }
function cfg(dev, cmds, topo, sim) {
  return runCommands(dev, topo, sim, ['enable', 'configure terminal'].concat(cmds));
}

section('1. Serial is its own connector family');
{
  ok(!!media.CAGES.serial, 'there is a serial cage');
  eq(media.CAGES.serial.label, 'Serial (V.35)', 'it is a V.35 socket');
  const m = media.MEDIA['serial-v35'];
  ok(!!m, 'and a V.35 medium');
  eq(m.connector, 'serial', 'with a serial connector');
  eq(m.speedMbps, 1.544, 'defaulting to T1 rate');

  const hw = media.derivePortHardware({ name: 'Se0/0/0', type: 'serial', speed: '1.544M' }, {});
  eq(hw.cage, 'serial', 'a serial port derives a serial cage');
  ok(hw.speedCaps.indexOf(0.064) !== -1, 'the ladder includes 64 kbps');
  ok(hw.speedCaps.indexOf(1.544) !== -1, 'and T1');
  ok(hw.speedCaps.indexOf(2) === -1 || hw.speedCaps.indexOf(2) <= 1.544,
    'and nothing faster than the port itself');

  const byName = media.derivePortHardware({ name: 'Serial0/1' }, {});
  eq(byName.cage, 'serial', 'a port named Serial0/1 with no type is still serial');
}

section('2. It mates with itself and refuses copper');
{
  const s = media.derivePortHardware({ name: 'Se0/0/0', type: 'serial', speed: '1.544M' }, {});
  const s2 = media.derivePortHardware({ name: 'Se0/0/1', type: 'serial', speed: '1.544M' }, {});
  const rj = media.derivePortHardware({ name: 'Fa0/0', type: 'ethernet', speed: '100M' }, {});

  ok(media.canMate(s, s2).ok, 'two serial ports mate');
  const bad = media.canMate(s, rj);
  ok(!bad.ok, 'a serial port and an Ethernet port do not');
  eq(bad.code, 'E_CONNECTOR_MISMATCH', 'and it is refused as a connector mismatch');
  eq(media.negotiateSpeed(s, s2), 1.544, 'they negotiate the T1 rate');
}

section('3. The Cisco 2811 exists, with the ports a WAN lab needs');
{
  const d = spec('2811');
  ok(!!d, 'the 2811 is in the catalogue');
  eq(d.vendor, 'cisco', 'from Cisco');
  eq(d.category, 'router', 'and is a router');

  const topo = new Topology();
  const r = topo.addDevice(d);
  const byName = function (n) { return r.interfaces.get(n); };
  eq(byName('Fa0/0').cage, 'rj45', 'Fa0/0 is copper');
  eq(byName('Fa0/1').cage, 'rj45', 'Fa0/1 is copper');
  eq(byName('Fa0/0').speedCaps.join(','), '10,100',
    'and 10/100, not gigabit - the 2811 predates onboard GigabitEthernet');
  eq(byName('Se0/0/0').cage, 'serial', 'Se0/0/0 is serial');
  eq(byName('Se0/0/1').cage, 'serial', 'Se0/0/1 is serial');
}

section('4. Exactly one end clocks the link');
{
  const topo = new Topology();
  const r1 = topo.addDevice(spec('2811'));
  const r2 = topo.addDevice(spec('2811'));
  const sim = new Simulator(topo);
  const check = function () {
    return topo.validateLink(r1.id, 'Se0/0/0', r2.id, 'Se0/0/0');
  };

  const none = check();
  eq(none.errors.length, 1, 'an unclocked link is refused');
  eq(none.errors[0].code, 'E_SERIAL_NO_CLOCK', 'for want of a clock');
  ok(/clock rate/.test(none.errors[0].message), 'and the message names the command that fixes it');

  cfg(r1, ['interface Se0/0/0', 'clock rate 64000', 'exit'], topo, sim);
  const one = check();
  eq(one.errors.length, 0, 'one clocked end is a valid link');
  eq(one.speedMbps, 0.064, 'and the link runs at the clock, not at the port maximum');

  cfg(r2, ['interface Se0/0/0', 'clock rate 1544000', 'exit'], topo, sim);
  const two = check();
  eq(two.errors.length, 1, 'both ends clocked is refused');
  eq(two.errors[0].code, 'E_SERIAL_TWO_CLOCKS', 'as two clock sources');
  ok(/DCE/.test(two.errors[0].message), 'and the message explains why');
}

section('5. clock rate refuses things it should');
{
  const topo = new Topology();
  const r = topo.addDevice(spec('2811'));
  const sim = new Simulator(topo);
  const run = function (cmds) {
    return runCommands(r, topo, sim, ['enable', 'configure terminal'].concat(cmds)).lines;
  };

  ok(/Clock rate set to 64000 bps/.test(run(['interface Se0/0/0', 'clock rate 64000']).join('\n')),
    'a legal rate is accepted');
  eq(r.interfaces.get('Se0/0/0').clockRateBps, 64000, 'and stored on the port');

  ok(/% clock rate is only configurable on a serial interface/.test(
    run(['interface Fa0/0', 'clock rate 64000']).join('\n')),
    'a non-serial port refuses it');

  const slow = run(['interface Se0/0/1', 'clock rate 9600']).join('\n');
  ok(/% 9600 bps is not a rate/.test(slow), 'a rate below the ladder is refused');
  ok(/64000, 128000/.test(slow), 'and the refusal lists the rates that would work');

  ok(/% Invalid clock rate/.test(run(['interface Se0/0/1', 'clock rate banana']).join('\n')),
    'nonsense is refused');

  run(['interface Se0/0/0', 'no clock rate']);
  eq(r.interfaces.get('Se0/0/0').clockRateBps, null, 'and it can be cleared again');
}

section('6. Traffic crosses a clocked link');
{
  const topo = new Topology();
  const r1 = topo.addDevice(spec('2811'));
  const r2 = topo.addDevice(spec('2811'));
  const sim = new Simulator(topo);
  cfg(r1, ['interface Se0/0/0', 'clock rate 1544000', 'ip address 10.0.0.1 255.255.255.252',
    'no shutdown', 'exit'], topo, sim);
  cfg(r2, ['interface Se0/0/0', 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'exit'],
    topo, sim);

  // Cabling without a clock is refused by connect(), not left to fail later.
  let refused = null;
  try { topo.connect(r1.id, 'Se0/0/1', r2.id, 'Se0/0/1'); }
  catch (e) { refused = e; }
  ok(refused !== null || topo.links.length === 0,
    'an unclocked serial cable is refused at cabling time');

  const link = topo.connect(r1.id, 'Se0/0/0', r2.id, 'Se0/0/0');
  ok(!!link, 'the clocked cable is accepted');
  const ping = sim.ping(r1.id, '10.0.0.2', { count: 1 });
  ok(ping.success, 'and a ping crosses it');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
