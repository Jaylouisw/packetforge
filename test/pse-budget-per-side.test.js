'use strict';
// #1621 - one PoE budget belongs to one side of the cable.
//
// `pseDraw()` (engine/validation.js) is handed the cable under test and sums the
// PSE ports of ONE device against that device's budget. It used to be handed both
// ends of the cable in a single `connecting` array, and the second loop - meant to
// catch a port object that is not yet in `device.interfaces` - never asked whose
// port it was. Cabling a PoE *passthrough* PD (a wall-plate AP that both draws PoE
// and supplies it) into a PoE+ port therefore charged the switch's 15.4 W port
// ceiling to the AP's own 13 W output budget and refused the link outright:
//
//   Error: TP-Link EAP225-Wall PoE budget exceeded: 1 powered port draw 15.4 W
//   of a 13 W budget (1/1/1).
//
// Every word of that sentence was wrong: 13 W is the AP's OUTPUT budget (its eth3
// passthrough, idle and unconnected), 15.4 W belongs to the switch, and 1/1/1 is
// the switch's port. The same link on a plain PD worked only because a plain PD
// declares no `poe` block, so `pseDraw()` returned null before it ever looked.
//
// The fix bills each side against its own ports only. The check must keep working
// where it is right, so this file also proves a genuine over-budget is still
// refused and that the refusal names the over-budget device's own ports.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const validation = require('../engine/validation');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(vendor, model) {
  return catalog.filter(function (s) { return s.vendor === vendor && s.model === model; })[0];
}

// A 48-port PoE+ switch (30 W per port, 982 W total) and the passthrough AP.
const SWITCH = spec('aruba', 'CX 6200F 24G CL4 PoE 4SFP+');
const AP = spec('tp-link', 'EAP225-Wall');

console.log('The passthrough AP cables to a PoE+ port without spending its own budget');
{
  ok(!!SWITCH && !!AP, 'both fixtures are in the catalogue');
  ok(!!AP && AP.poe && AP.poe.budgetW === 13,
    'the AP budgets 13 W of its own output (' + (AP && AP.poe && AP.poe.budgetW) + ')');

  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'SW');
  const ap = t.addDevice(AP, 'AP');
  let threw = null;
  let link = null;
  try { link = t.connect(ap.id, 'eth0', sw.id, '1/1/1'); } catch (e) { threw = e; }
  ok(!threw, 'AP first: the link is accepted, no E_POE_BUDGET (' + (threw && threw.message) + ')');
  ok(!!link, 'and a link object is returned (' + JSON.stringify(link && Object.keys(link)) + ')');

  // Order must not matter: the cable is the same cable from the switch's end.
  const t2 = new Topology();
  const sw2 = t2.addDevice(SWITCH, 'SW');
  const ap2 = t2.addDevice(AP, 'AP');
  threw = null;
  try { t2.connect(sw2.id, '1/1/2', ap2.id, 'eth0'); } catch (e) { threw = e; }
  ok(!threw, 'switch first: the same link is accepted (' + (threw && threw.message) + ')');

  // The AP's own PSE port (eth3) is idle, so none of its 13 W is in use. Before
  // the fix it was reported as 15.4 W of 13 W - consumed by the switch's port.
  const sim = new Simulator(t2);
  sim.computePoe();
  const apEntry = sim.poe.filter(function (p) { return p.dev === ap2.id; })[0];
  ok(!!apEntry, 'the AP still has a PoE budget entry');
  ok(!!apEntry && apEntry.used === 0, 'and it spends nothing on the uplink (' + (apEntry && apEntry.used) + ')');
  ok(!!apEntry && apEntry.ports.length === 0, 'its idle passthrough port is not allocated');

  const swEntry = sim.poe.filter(function (p) { return p.dev === sw2.id; })[0];
  const row = swEntry && swEntry.ports.filter(function (p) { return p.iface === '1/1/2'; })[0];
  ok(!!row && row.powered === true, 'the switch powers the AP (' + JSON.stringify(row) + ')');
  ok(!!row && row.draw === 12.95, "drawing the AP's declared 12.95 W (" + (row && row.draw) + ')');
}

console.log('\nA genuine over-budget is still refused, and blames only its own ports');
{
  // Two 15.4 W sockets on a 30 W budget, and a passthrough PD on the far end of
  // the second one. Before the fix this produced TWO errors: the switch over its
  // budget (correct) and the PD over its own 13 W budget for the switch's port
  // (nonsense, and it named the switch's port).
  function mkIface(s) {
    return Object.assign({ name: 'eth0', type: 'ethernet', speed: '1G', enabled: true, peer: null }, s);
  }
  function mkDevice(id, label, specs, extra) {
    const dev = { id: id, name: label, label: label, model: 'test-' + id, category: 'switch',
      capabilities: [], interfaces: new Map(), poeBudget: 0 };
    Object.assign(dev, extra || {});
    specs.forEach(function (s) { dev.interfaces.set(s.name, mkIface(s)); });
    return dev;
  }

  const sw = mkDevice('d1', 'SW-PoE', [
    { name: 'Gi0/1', speed: '1G', poeOut: 15.4 },
    { name: 'Gi0/2', speed: '1G', poeOut: 15.4 }
  ], { capabilities: ['poe-pse'], poeBudget: 30 });
  // A passthrough PD: draws 12.95 W on its uplink and sources 13 W on eth1
  // against a 13 W budget of its own.
  const pd = mkDevice('d2', 'WALL-AP', [
    { name: 'eth0', speed: '1G', poeIn: 12.95 },
    { name: 'eth1', speed: '1G', poeOut: 13 }
  ], { category: 'wireless', capabilities: ['poe-pd', 'poe-pse'], poeBudget: 13 });

  // Port 1 already powers an access point, so port 2 puts the switch at 30.8 W.
  sw.interfaces.get('Gi0/1').peer = { deviceId: 'd3', iface: 'eth0' };

  const r = validation.validateConnection({
    devA: sw, devB: pd,
    ifaceA: sw.interfaces.get('Gi0/2'),
    ifaceB: pd.interfaces.get('eth0')
  });

  const poe = (r.errors || []).filter(function (e) { return e.code === 'E_POE_BUDGET'; });
  ok(poe.length === 1, 'exactly one E_POE_BUDGET is reported (' + poe.length + ')');
  ok(!!poe[0] && /^SW-PoE/.test(poe[0].message),
    'and it is the switch that is named: ' + (poe[0] && poe[0].message));
  ok(!!poe[0] && /30\.8 W of a 30 W budget/.test(poe[0].message),
    "reporting the switch's own draw against its own budget: " + (poe[0] && poe[0].message));
  ok(!!poe[0] && /\(Gi0\/1, Gi0\/2\)/.test(poe[0].message),
    "listing only the switch's ports: " + (poe[0] && poe[0].message));
  ok(!!poe[0] && (poe[0].message.indexOf('WALL-AP') === -1),
    'the passthrough PD is not blamed for a cable it is not spending its budget on');
  ok(!(r.errors || []).some(function (e) {
    return e.code === 'E_POE_BUDGET' && /WALL-AP/.test(e.message);
  }), 'no second refusal is minted against the PD');
}

if (failed) {
  console.error('\n' + passed + ' passed, ' + failed + ' FAILED');
  process.exit(1);
}
console.log('\n' + passed + ' passed, 0 failed');
