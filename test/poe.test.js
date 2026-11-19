'use strict';
// PoE budgeting is now enforced, not just stored: a PSE with a finite budget
// powers devices until it runs out, and the ones that miss out are dead - they
// transmit nothing and receive nothing.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  \u2713 ' + msg); } else { failed++; console.error('  \u2717 ' + msg); } }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}

// A real PoE switch and two real powered devices.
const PSE = 'CX 6000 24G CL4 PoE 4SFP 370W';
const PD = 'RBSXTsqG-5acD';   // powered device that is also L3, so it can ping

const t = new Topology();
const sw = t.addDevice(spec('aruba', PSE));
const pd1 = t.addDevice(spec('mikrotik', PD));
const pd2 = t.addDevice(spec('mikrotik', PD));
sw.name = 'SW1'; pd1.name = 'PD1'; pd2.name = 'PD2';

const l1 = t.connect(pd1.id, 'eth1', sw.id, '1/1/1');
const l2 = t.connect(pd2.id, 'eth1', sw.id, '1/1/2');

console.log('The catalogue gives this PSE a real budget:');
ok(sw.poeBudget === 370, 'Aruba ' + PSE + ' has a 370 W budget (from its model name)');
const pdDraw = pd1.interfaces.get('eth1').poeIn;
ok(pdDraw > 0, 'and the PD declares what it draws (' + pdDraw + ' W)');

console.log('\nA budget that cannot cover both devices powers only the first:');
sw.poeBudget = 25;                       // 2 x 12.95 W = 25.9 W > 25 W
let sim = new Simulator(t);
sim.computePoe();
ok(sim.poe.length === 1, 'one PSE was accounted for');
ok(sim.poe[0].budget === 25, 'budget recorded as 25 W');
ok(sim.poe[0].used === pdDraw, 'one device was powered (' + sim.poe[0].used + ' W used)');
const powered = sim.poe[0].ports.filter(function (p) { return p.powered; });
const denied = sim.poe[0].ports.filter(function (p) { return !p.powered; });
ok(powered.length === 1, 'exactly one port is powered');
ok(denied.length === 1, 'and exactly one is refused');
ok(denied[0].pd === pd2.id, 'the second port in order is the one that loses out');
const denyEv = sim.events.filter(function (e) { return e.type === 'poe-deny'; })[0];
ok(!!denyEv, 'a poe-deny event is logged');
ok(denyEv && /budget exhausted/i.test(denyEv.reason), 'with the reason: "' + (denyEv && denyEv.reason) + '"');

console.log('\nThe unpowered device is genuinely dead on the wire:');
runCommands(pd1, t, null, ['enable', 'configure terminal', 'interface ' + 'eth1',
  'ip address 192.168.50.1 255.255.255.0']);
runCommands(pd2, t, null, ['enable', 'configure terminal', 'interface ' + 'eth1',
  'ip address 192.168.50.2 255.255.255.0']);
sim = new Simulator(t);
let r = sim.ping(pd1.id, '192.168.50.2', { count: 1 });
ok(r.replies[0].success === false, 'ping from the powered device to the unpowered one fails');
ok(sim.events.some(function (e) { return e.type === 'poe-deny'; }), 'and the failure is attributed to power, not to ARP or routing');

console.log('\nGive the switch enough budget and it comes back:');
sw.poeBudget = 370;
sim = new Simulator(t);
r = sim.ping(pd1.id, '192.168.50.2', { count: 1 });
ok(r.replies[0].success === true, 'the same ping now succeeds');
ok(!sim.events.some(function (e) { return e.type === 'poe-deny'; }), 'and no power denial is logged');
ok(sw.poeUnpowered === false && pd1.poeUnpowered === false, 'neither device is marked unpowered');

console.log('\nOnly powered devices count against the budget:');
const t3 = new Topology();
const sw3 = t3.addDevice(spec('aruba', PSE));
const plain = t3.addDevice(spec('generic', 'generic-pc'));
sw3.name = 'SW3'; plain.name = 'PC1';
t3.connect(plain.id, 'eth0', sw3.id, '1/1/1');
const sim3 = new Simulator(t3);
const poe3 = sim3.computePoe();
ok(poe3[0].ports.length === 0, 'a plain PC draws no PoE and is not counted');
ok(poe3[0].used === 0, 'so the whole budget stays free');

console.log('\nA gateway that accepts no PoE is not a powered device:');
// `isPoePd()` matches `unifi` in the model+label, so a UniFi box that says nothing
// about PoE used to have every silent copper port invented as a 12.95 W 802.3af
// draw - 64.75 W on a 6.2 W USB-C console. The datasheets declare no PoE in either
// direction, so both models say so per port and nothing is drawn.
const t5 = new Topology();
const sw5 = t5.addDevice(spec('aruba', PSE));
const ucg = t5.addDevice(spec('ubiquiti', 'UCG-Ultra'));
const udm = t5.addDevice(spec('ubiquiti', 'UDM-Pro'));
t5.connect(ucg.id, 'port1', sw5.id, '1/1/1');
t5.connect(udm.id, 'port1', sw5.id, '1/1/2');
sw5.poeBudget = 370;
ok(ucg.interfaces.get('port1').poeIn === false && udm.interfaces.get('port1').poeIn === false,
  'both declare poeIn: false rather than leaving the inference to fill in 12.95 W');
const poe5 = new Simulator(t5).computePoe()[0];
ok(poe5.ports.length === 0, 'so neither port is in the allocation table (' + poe5.ports.length + ')');
ok(poe5.used === 0, 'and the switch spends nothing on them (' + poe5.used + ' W)');

console.log('\nAn unpowered device cannot transmit either:');
const t4 = new Topology();
const sw4 = t4.addDevice(spec('aruba', PSE));
const d1 = t4.addDevice(spec('mikrotik', PD));
const d2 = t4.addDevice(spec('mikrotik', PD));
t4.connect(d1.id, 'eth1', sw4.id, '1/1/1');
t4.connect(d2.id, 'eth1', sw4.id, '1/1/2');
sw4.poeBudget = 25;
runCommands(d2, t4, null, ['enable', 'configure terminal', 'interface ' + 'eth1',
  'ip address 10.9.9.9 255.255.255.0']);
const sim4 = new Simulator(t4);
sim4.ping(d2.id, '10.9.9.1', { count: 1 });
ok(sim4.events.some(function (e) { return e.type === 'poe-deny' && /no PoE power/.test(e.reason || ''); }),
   'the unpowered device is stopped at transmit, not just at receive');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
