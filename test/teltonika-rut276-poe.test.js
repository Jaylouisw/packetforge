'use strict';
// teltonika-rut276-poe.test.js -- the RUT276 is a powered device, not a PSE.
//
// The row shipped `lan1` with `poeOut: true` and `poeOutClass: "PoE+"`. That is the bare direction bit
// `Device.poeDraw()` (engine/device.js) adds as 1 W, and `pseDraw()` (engine/validation.js) sums against a
// budget the vendor never published -- while `show power inline` answered "budget not modelled on RUT276".
// The other direction was missing entirely: nothing declared `poeIn`, so the one thing the datasheet does
// say about this box's power-over-Ethernet - that it *takes* 802.3af Class 0 on its LAN port - was absent
// from the model, and a lab could not power the router from the cable that powers it.
//
// Teltonika's own datasheet v1.05 (2026-07-24, https://download.kamami.pl/p1207999-Datasheet_RUT276_1.05.pdf,
// HTTP 200, 4,182,657 B, 14 pp, text layer, p.7; the same rows in v1.04, 2026-05-15,
// https://cdn.bueromarkt-ag.de/downloads/produktdatenblaetter/rut276000000.pdf, p.8):
//
//   "POE IN / PoE IN ports: 1 x PoE In / PoE standards: Active PoE input 802.3af Class 0 (12.94 W) on LAN port"
//   "PoE (passive): ... Possibility to power up through LAN port. Passive PoE voltage: 16 - 57 VDC."
//   "WAN 1 x WAN port 10/100 Mbps" / "LAN 1 x LAN port, 10/100 Mbps" (p.2)
//
// Neither revision carries a POE OUT section, a per-port PSE wattage or a PoE budget. v1.04 prints that
// value row as "PoE OUT ports = 1 x PoE In" - a template leftover v1.05 corrects to "PoE IN ports" - and it
// is the only place a "PoE out" reading could have come from.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalogue = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const spec = catalogue.filter(function (s) { return s.model === 'RUT276'; })[0];
const switchSpec = catalogue.filter(function (s) { return s.model === 'USW-Lite-8-PoE'; })[0];

console.log('The port census is the one Teltonika prints');
ok(!!spec, 'the RUT276 is in the catalogue');
const lan = spec.interfaces.filter(function (i) { return i.name === 'lan1'; })[0];
const wan = spec.interfaces.filter(function (i) { return i.name === 'wan1'; })[0];
ok(!!lan && !!wan, 'it has the one WAN and one LAN port the datasheet names');

console.log('\nPower over Ethernet runs the way the cable does: in on the LAN port');
ok(lan.poeIn === 12.94, 'lan1 takes 802.3af Class 0 - 12.94 W, the vendor\'s figure', String(lan.poeIn));
ok(!('poeOut' in lan) && !('poeOutClass' in lan),
  'and it sources no power: no `poeOut`, no `poeOutClass`', JSON.stringify(lan));
ok(!(spec.interfaces || []).some(function (i) { return i.poeOut; }),
  'no socket on the box is a PSE');
const caps = spec.capabilities || [];
ok(caps.indexOf('poe-pd') !== -1, 'the capability list says poe-pd', caps.join(','));
ok(caps.indexOf('802.3af') !== -1, 'and 802.3af');
ok(caps.indexOf('poe-pse') === -1, 'and no longer claims poe-pse', caps.join(','));

console.log('\nA PoE switch now powers it, instead of being told the far end needs nothing');
{
  const t = new Topology();
  const r = t.addDevice(spec, 'r'); r.name = 'RUT276';
  const s = t.addDevice(switchSpec, 's'); s.name = 'SW';
  t.connect(r.id, 'lan1', s.id, 'port1');
  const sim = new Simulator(t);
  sim.computePoe();
  const table = (new CliSession(s, t, sim).run('show power inline').output || []).map(String);
  const row = table.filter(function (l) { return /^port1\s/.test(l); })[0] || '';
  ok(/\bon\b/.test(row), 'the switch reports port1 "on" with the router attached', row);
  ok(/12\.9/.test(row) && /RUT276/.test(row), 'at 12.9 W, named as the RUT276', row);
  const own = (new CliSession(r, t, sim).run('show power inline').output || []).map(String).join('\n');
  ok(own.indexOf('budget not modelled') === -1,
    'and the router no longer answers `show power inline` with a PSE budget it never had', own.split('\n')[0]);
  ok(/% No PoE/.test(own), 'it says it cannot supply power at all', own.split('\n')[0]);
}

console.log('\nWAN and LAN are separate L3 surfaces, as the sheet names them');
ok(wan.role === 'wan' && lan.role === 'lan',
  'wan1 is "wan" and lan1 is "lan"', 'wan1=' + wan.role + ' lan1=' + lan.role);
{
  const t = new Topology();
  const r = t.addDevice(spec, 'r'); r.name = 'RUT276';
  const l = r.interfaces.get('lan1');
  l.ip = '192.168.1.1'; l.mask = '255.255.255.0';
  ok(r.ownsIpOn(l, '192.168.1.1'), 'the LAN port answers the LAN address');
  ok(!r.ownsIpOn(r.interfaces.get('wan1'), '192.168.1.1'),
    'and the WAN socket does not serve it - that is what NAT is for');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
