'use strict';
// The USW-Ultra chassis sourced power it could not account for: all seven PoE+ ports carried
// `poeOut: true`, the bare direction bit, which `Device.poeDraw()` (engine/device.js) adds as
// 1 W and which `pseDraw()` (engine/validation.js) sums against the budget. On the 42 W model
// two 25.5 W access points cabled to eth0/eth1 were both accepted by the cabling guard
// (2 W of 42 W), and `poeDraw()` answered 2 W for 51 W of real load.
//
// Ubiquiti's own tech-spec pages, all read 2026-11-21 (200, server-rendered):
//   https://techspecs.ui.com/unifi/switching/usw-ultra       628,685 B
//   https://techspecs.ui.com/unifi/switching/usw-ultra-60w   628,751 B
//   https://techspecs.ui.com/unifi/switching/usw-ultra-210w  628,783 B
// each print the same panel - `Port Layout 1 GbE RJ45 8 (7 PoE+; 1 PoE++ input)`,
// `Max. PoE Output Up to PoE+`, `PoE Ports PoE+ 7`, `Max. PoE Wattage per Port by PSE PoE+ 30W` -
// and differ only in `Total PoE Availability`: 42 W on PoE++ input (base), 52 W on the 60 W AC
// adapter, 202 W on the 210 W AC adapter. The eighth socket is the PoE++ INPUT that powers the
// switch, so it sources nothing.
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
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}

const ULTRA = spec('ubiquiti', 'USW-Ultra');
const ULTRA_60 = spec('ubiquiti', 'USW-Ultra-60W');
const ULTRA_210 = spec('ubiquiti', 'USW-Ultra-210W');
const AT_PD = spec('aruba', 'AP-515');   // 25.5 W, an 802.3at draw

function show(dev, t, sim, cmd) {
  return (new CliSession(dev, t, sim).run(cmd).output || []).map(String);
}
function connectN(specObj, pads, name) {
  const t = new Topology();
  const sw = t.addDevice(specObj, name || 'sw1');
  const dev = t.devices.get(sw.id);
  let refusal = null, made = 0;
  for (let i = 1; i <= pads; i++) {
    const pd = t.addDevice(AT_PD, 'ap' + i);
    try { t.connect(pd.id, 'E0', sw.id, 'eth' + (i - 1)); made++; }
    catch (e) { refusal = e; break; }
  }
  return { t: t, sw: sw, dev: dev, refusal: refusal, made: made };
}

console.log('');
console.log('Each power configuration states its own vendor budget:');
ok(ULTRA.poe && ULTRA.poe.budgetW === 42, 'USW-Ultra is 42 W of PoE++ input (' + (ULTRA.poe && ULTRA.poe.budgetW) + ')');
ok(ULTRA_60.poe && ULTRA_60.poe.budgetW === 52, 'USW-Ultra-60W is 52 W on the 60 W adapter (' + (ULTRA_60.poe && ULTRA_60.poe.budgetW) + ')');
ok(ULTRA_210.poe && ULTRA_210.poe.budgetW === 202, 'USW-Ultra-210W is 202 W on the 210 W adapter (' + (ULTRA_210.poe && ULTRA_210.poe.budgetW) + ')');
ok([ULTRA, ULTRA_60, ULTRA_210].every(function (s) {
  return /^https:\/\/techspecs\.ui\.com\/unifi\/switching\/usw-ultra/.test(String(s.poe && s.poe.sourceUrl));
}), 'and each budget is cited to a techspecs page');

console.log('\nThe seven PoE+ sockets declare the vendor\'s 30 W ceiling:');
[ULTRA, ULTRA_60, ULTRA_210].forEach(function (s) {
  const src = s.interfaces.filter(function (i) { return /^eth[0-6]$/.test(i.name); });
  ok(src.length === 7, s.model + ' has seven PoE+ sockets (' + src.length + ')');
  ok(src.every(function (i) { return i.poeOut === 30; }),
    s.model + ': eth0..eth6 are 30 W PSE ports (' + src.map(function (i) { return i.poeOut; }).join(',') + ')');
  ok(src.every(function (i) { return i.poeOutClass === 'PoE+'; }), s.model + ': all seven are PoE+');
  const inp = s.interfaces.find(function (i) { return i.name === 'eth7'; });
  ok(!!inp && !inp.poeOut, s.model + ': eth7 sources nothing (' + (inp && inp.poeOut) + ')');
  ok(!!inp && inp.poeIn > 0, s.model + ': eth7 is the PoE++ input the switch runs from (' + (inp && inp.poeIn) + ')');
});

console.log('\nOne cabled port is counted at its 30 W ceiling, not at one watt:');
{
  const r = connectN(ULTRA, 1);
  ok(r.made === 1 && !r.refusal, 'an 802.3at access point cables to eth0');
  ok(r.dev.poeDraw() === 30, 'poeDraw() charges the port\'s 30 W ceiling, not the old 1 W (' + r.dev.poeDraw() + ')');
  const sim = new Simulator(r.t);
  sim.computePoe();
  const lines = show(r.dev, r.t, sim, 'show power inline');
  ok(lines[0] === 'Available:42.0(w) Used:25.5(w) Remaining:16.5(w)',
    'the summary line is the vendor budget: ' + lines[0]);
}

console.log('\nThe 42 W budget now binds on the second 30 W port:');
{
  const r = connectN(ULTRA, 3);
  ok(r.made === 1, 'only one PoE+ access point fits (' + r.made + ')');
  ok(!!r.refusal && r.refusal.code === 'E_POE_BUDGET',
    'the second is refused with E_POE_BUDGET (' + (r.refusal && r.refusal.code) + ')');
  ok(/2 powered ports draw 60 W of a 42 W budget/.test(String(r.refusal && r.refusal.message)),
    'and the message names the arithmetic: ' + (r.refusal && r.refusal.message));
}
{
  const r60 = connectN(ULTRA_60, 3);
  ok(r60.made === 1 && r60.refusal && r60.refusal.code === 'E_POE_BUDGET',
    'the 60 W adapter model also stops at the second (52 W budget)');
  const r210 = connectN(ULTRA_210, 8);
  ok(r210.made === 6, 'the 210 W model feeds six 30 W ports (' + r210.made + ')');
  ok(!!r210.refusal && /7 powered ports draw 210 W of a 202 W budget/.test(String(r210.refusal.message)),
    'and refuses the seventh: ' + (r210.refusal && r210.refusal.message));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
