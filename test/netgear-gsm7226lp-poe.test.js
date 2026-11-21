'use strict';
// NETGEAR M4100-26G-POE (GSM7226LP): 24 x 802.3af ports sharing a 192 W budget.
//
// The model declared every powered port `poeOutClass: "PoE+"` (802.3at, 30 W) and carried no `poe`
// block, so `show power inline` answered "budget not modelled" and the allocator never counted a
// watt. NETGEAR's own data sheet settles both facts in one table row:
//   https://www.downloads.netgear.com/files/GDC/datasheet/en/M4100.pdf  ("Hardware at a Glance")
//     M4100-26G-POE | - | 26 | 4 (shared) | "24 PoE 802.3af" | ... | "192W" | "Up to 380W (EPS)" | GSM7226LP
//   and, one row below, the model that *is* PoE+:
//     M4100-24G-POE+ | - | 24 | 4 (shared) | "24 PoE+ 802.3at" | ... | "380W" | "Up to 720W (EPS)" | GSM7224P
// The ordering table repeats it: "M4100-26G-POE ... 24 ports Gigabit PoE 802.3af ... GSM7226LP-100NES".
// The family product brief gives the per-port ceiling the class implies: "IEEE 802.3af Power over
// Ethernet (PoE) provides up to 15.4W per port (... M4100-26G-POE)".
// Two resellers upgrade the SKU to "PoE+ 802.3at" while keeping 192 W - the class of the other
// 24-port model stapled to this one's budget; research/netgear-gsm7226lp-poe-budget.md records it.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.find(function (s) { return s.vendor === 'netgear' && s.model === 'GSM7226LP'; });
const AP = catalog.find(function (s) { return s.vendor === 'ubiquiti' && s.model === 'U6-Lite'; });

console.log('The data sheet states the budget and the standard:');
ok(!!SWITCH, 'GSM7226LP is in the catalogue');
ok(SWITCH && SWITCH.poe && SWITCH.poe.budgetW === 192,
  'the budget is 192 W (' + (SWITCH && SWITCH.poe && SWITCH.poe.budgetW) + ')');
ok(SWITCH && /M4100\.pdf$/.test(String(SWITCH.poe.sourceUrl)),
  'and it cites NETGEAR\'s own M4100 data sheet');
ok(SWITCH && SWITCH.capabilities.indexOf('802.3af') !== -1, 'the device claims 802.3af');
ok(SWITCH && SWITCH.capabilities.indexOf('802.3at') === -1,
  'and no longer claims 802.3at, which belongs to the M4100-24G-POE+');
ok(SWITCH && /802\.3af/.test(SWITCH.description), 'the description names 802.3af: ' + (SWITCH && SWITCH.description));

console.log('\n24 ports source 802.3af; the two cages source nothing:');
{
  const dev = new Topology().addDevice(SWITCH, 'sw1');
  const ifaces = [...dev.interfaces.values()];
  const pse = ifaces.filter(function (i) { return i.poeOut; });
  ok(pse.length === 24, 'exactly 24 ports source power (' + pse.length + ')');
  // `poeOutClass` is a declaration, not derived hardware: DEVICE_SCHEMA.md says the string is kept
  // verbatim and dropped by derivePortHardware(), so it is read off the spec's own ports.
  const declared = (SWITCH.interfaces || []).filter(function (i) { return i.poeOut; });
  ok(declared.length === 24 && declared.every(function (i) { return i.poeOutClass === 'PoE'; }),
    'every one is declared class PoE (802.3af)');
  ok(declared.every(function (i) { return i.poeOutClass !== 'PoE+'; }),
    'and none is declared PoE+ (802.3at)');
  const cages = ifaces.filter(function (i) { return i.hardware.cage === 'sfp'; });
  ok(cages.length === 2 && cages.every(function (i) { return !i.poeOut; }),
    'the two SFP cages are not PSE ports');
  ok(dev.poeBudget === 192, 'the device carries 192 W (' + dev.poeBudget + ')');
  ok(dev.poeBudgetSource === 'research', 'sourced from research, not guessed from the model name');
}

console.log('\n192 W funds fourteen 12.95 W access points, and refuses the fifteenth:');
{
  const t = new Topology();
  t.addDevice(SWITCH, 'sw1');
  for (let n = 1; n <= 15; n++) t.addDevice(AP, 'ap' + n);
  for (let n = 1; n <= 15; n++) {
    t.connect('sw1', 'ge' + n, 'ap' + n, 'port1', { mediaId: '1000base-t', speedMbps: 1000 });
  }
  const sim = new Simulator(t);
  const entry = sim.computePoe().filter(function (p) { return p.dev === t.getDevice('sw1').id; })[0];
  ok(!!entry, 'the switch has a PoE result');
  ok(entry && entry.budget === 192, 'counted against 192 W (' + (entry && entry.budget) + ')');
  ok(entry && entry.ports.length === 15, 'the allocator sees all fifteen PSE ports');
  ok(entry && entry.ports.filter(function (p) { return p.powered; }).length === 14,
    'fourteen are powered (' + (entry && entry.ports.filter(function (p) { return p.powered; }).length) + ')');
  ok(entry && Math.abs(entry.used - 181.3) < 1e-9,
    '14 x 12.95 W = 181.3 W of the 192 W budget (' + (entry && entry.used) + ')');
  const denied = entry && entry.ports.filter(function (p) { return !p.powered; })[0];
  ok(denied && denied.iface === 'ge15', 'the fifteenth port is the one refused (' + (denied && denied.iface) + ')');
  ok(denied && /PSE budget exhausted: 12\.95 W requested, 10\.7 W left/.test(denied.reason || ''),
    'and it says why: ' + (denied && denied.reason));

  const cli = new CliSession(t.getDevice('sw1'), t, sim);
  const table = (cli.run('show power inline').output || []).map(String).join('\n');
  ok(/^Available:192\.0\(w\) Used:181\.3\(w\) Remaining:10\.7\(w\)$/m.test(table),
    'the summary line adds up: ' + (table.split('\n')[0]));
  ok(/^ge1\s+auto\s+on\s+13\.0\s/m.test(table), 'ge1 is on, drawing 13.0 W');
  ok(/^ge15\s+auto\s+power-deny\s+0\.0\s/m.test(table),
    'ge15 is power-deny with 0.0 allocated, not "off"');
  ok(/ge15: PSE budget exhausted: 12\.95 W requested, 10\.7 W left/.test(table),
    'and the denial sentence is repeated under the table');
  ok(/9 ports with nothing plugged in: ge16, ge17, ge18, ge19, ge20 \(\+4 more\)/.test(table),
    'the nine unused powered ports are named once, not as nine rows');
}
{
  // A port the model does not carry is still refused by name, and a cage is refused as a non-PSE.
  const t = new Topology();
  t.addDevice(SWITCH, 'sw1');
  const sim = new Simulator(t);
  sim.computePoe();
  const cli = new CliSession(t.getDevice('sw1'), t, sim);
  const one = (cli.run('show power inline ge24').output || []).map(String).join('\n');
  ok(/ge24\s+auto\s+off\s+-\s+nothing plugged in/.test(one),
    'one port answers about that port, with no summary line: ' + JSON.stringify(one));
  const cage = (cli.run('show power inline sfp1').output || []).map(String).join('\n');
  ok(/sfp1 .*cannot supply power \(it is not a PSE port\)/.test(cage),
    'an SFP cage cannot supply power: ' + cage);
  const missing = (cli.run('show power inline ge25').output || []).map(String).join('\n');
  ok(/No interface ge25/.test(missing), 'a port the model does not carry is refused by name: ' + missing);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
