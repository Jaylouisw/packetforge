'use strict';
// uacc-lr-endpoint-poe-out.test.js -- the long-range endpoint's outlet is a PoE++ outlet, not a direction bit.
//
// `devices/ubiquiti/uacc-lr-endpoint.json` described its outlet in prose ("passthrough up to PoE++") while the
// port carried `poeOut: true`. `Device.poeDraw()` (engine/device.js) sums that field, and `true` is 1 W, so a
// lab that cabled a 60 W PoE++ camera behind the endpoint saw `show power inline` answer nothing and a draw of
// 1 W - the shape this stream has now repaired five times (UDW, the cloud gateways, the EdgeSwitches, the
// injectors, the UA-SK kits). The outlet's ceiling is the class Ubiquiti prints, and Ubiquiti's own glossary is
// on the same site as the endpoint's page:
//
//   * endpoint, https://techspecs.ui.com/unifi/accessories/uacc-lr-endpoint (HTTP 200, 594,569 B, read
//     2026-11-23): "Max. PoE Output | Passthrough up to PoE++", "Output Current | Max. output current: 1.9A",
//     "Input Current | 1.92A", "Power Method | PoE+++", "Max. Power Consumption | 2W",
//     "Supported Voltage Range | 52-57V".
//   * class table, https://techspecs.ui.com/unifi/cloud-gateways/udw (HTTP 200, 704,702 B, read 2026-11-23):
//     "Max. PoE Wattage per Port by PSE | PoE | 15.4W | PoE+ | 30W | PoE++ | 60W".
//
// The stated current is not the binding limit: 1.9 A x 52 V (the bottom of the supported range) is 98.8 W, so
// the 60 W class ceiling arrives first. `budgetW` is 60 because a passthrough with one outlet has no allocation
// apart from that outlet - there is no second row to read.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const CATALOGUE = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const find = function (model) { return CATALOGUE.filter(function (s) { return s.model === model; })[0]; };
const EP = 'UACC-LR-Endpoint';

console.log('\nThe spec states the outlet in watts and cites the page the class came from');
{
  const s = find(EP);
  ok(!!s, EP + ' is in the catalogue');
  const out = (s.interfaces || []).filter(function (i) { return i.name === 'out0'; });
  ok(out.length === 1, 'one outlet, out0');
  ok(out[0].poeOut === 60, 'out0 gives 60 W - the PoE++ PSE ceiling (' + out[0].poeOut + ')');
  ok(typeof out[0].poeOut === 'number', 'as a number, not a bare direction bit');
  ok(out[0].poeOutClass === 'PoE++', 'and keeps the vendor class word PoE++');
  ok(s.poe && s.poe.budgetW === 60, 'the device total is the same 60 W (' + (s.poe && s.poe.budgetW) + ')');
  ok(!(s.poe && s.poe.budgetUnknown), 'not marked unknown: the vendor does print the class');
  ok(/^https:\/\/techspecs\.ui\.com\//.test(String(s.poe && s.poe.sourceUrl)),
    'the budget cites the vendor host', String(s.poe && s.poe.sourceUrl));
  const note = String((s.poe && s.poe.note) || '');
  ok(/Passthrough up to PoE\+\+/.test(note), 'the note quotes the outlet row it came from');
  ok(/PoE\+\+ \| 60W|PoE\+\+ 60W/.test(note), 'and the class table that turns PoE++ into 60 W');
  ok(/read 2026-11-23/.test(note), 'and records the reading that produced it');
}

console.log('\nThe engine spends it instead of falling back to the model name');
{
  const dev = new Topology().addDevice(find(EP), 'e1');
  ok(dev.poeBudget === 60 && dev.poeBudgetSource === 'research',
    'budget resolves to 60 W from the document (' + dev.poeBudget + ' / ' + dev.poeBudgetSource + ')');
  const pse = [...dev.interfaces.values()].filter(function (p) { return p.poeOut; });
  ok(pse.length === 1, 'the engine builds one PSE port (' + pse.length + ')');
  ok(pse[0].hardware && pse[0].hardware.poeOut === 60,
    'and it is 60 W there too, not the 15.4 W 802.3af default (' + (pse[0].hardware && pse[0].hardware.poeOut) + ')');
}

console.log('\nA powered device behind the outlet is measured, not mistaken for 1 W');
{
  const t = new Topology();
  const ep = t.addDevice(find(EP), 'e1');
  const cam = t.addDevice(find('RUT276'), 'c1');
  t.connect('c1', 'lan1', 'e1', 'out0');
  const sim = new Simulator(t);
  sim.computePoe();
  ok(ep.poeDraw() === 60, 'poeDraw() reports the outlet\'s ceiling, 60 W (' + ep.poeDraw() + ')');
  const row = sim.poe.filter(function (p) { return p.dev === 'e1'; })[0];
  ok(!!row && row.ports.length === 1 && row.ports[0].powered === true,
    'the 12.94 W powered device is served (' + JSON.stringify(row && row.ports) + ')');
  const said = new CliSession(ep, t, sim).run('show power inline').output.join('\n');
  ok(/^Available:60(?:\.0)?\(w\)/m.test(said), '`show power inline` prints Available:60(w)', said.split('\n')[0]);
  ok(said.indexOf('budget not modelled') === -1, 'and never the not-modelled sentence');
}

console.log('\nA PoE+++ load does not pass: the outlet is class-capped, and says which budget refused it');
{
  const t = new Topology();
  const ep = t.addDevice(find(EP), 'e1');
  t.addDevice(find('USW-Flex-2.5G-8-PoE'), 'f1');
  t.connect('f1', 'Port 9', 'e1', 'out0');
  const sim = new Simulator(t);
  sim.computePoe();
  const row = sim.poe.filter(function (p) { return p.dev === 'e1'; })[0];
  const port = row && row.ports[0];
  ok(!!port && port.powered === false, 'a 90 W inlet is refused (' + JSON.stringify(port) + ')');
  ok(!!port && /90 W requested, 60 W left/.test(String(port.reason)),
    'and the reason names the class-capped budget', port && port.reason);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
