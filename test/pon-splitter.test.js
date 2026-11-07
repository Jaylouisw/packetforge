'use strict';
// The passive optical layer: splitters as couplers, and the PON loss budget.
//
// A PON is not a point-to-point link. One OLT port drives a passive coupler, and
// every ONT on the branch sees the downstream as a broadcast while sharing the
// upstream in time slots. The coupler has no MAC table and no power, so modelling
// it as a switch would be wrong - and the insertion loss it imposes is what makes
// a branch possible or impossible in the field.
const path = require('path');
const { Topology, Simulator, optical } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
// The ONT is synthetic for the same reason the OLT is: these legs are SC/APC, and an
// ONT with an LC/UPC port (the SDX 611, correctly) cannot be cabled to them. Pinning
// the test to a catalogue part would make a wiring fact look like an optical one.
const ontSpec = {
  vendor: 'generic', model: 'generic-ont', label: 'ONT', category: 'ont',
  capabilities: ['host'],
  interfaces: [{ name: 'pon', type: 'pon', speed: '2.5G', connector: 'sc-apc' }]
};

const oltSpec = {
  vendor: 'generic', model: 'generic-olt', label: 'OLT', category: 'olt',
  capabilities: ['l3-forward', 'cli'],
  interfaces: [{ name: 'gpon0/1', type: 'pon', speed: '2.5G', connector: 'sc-apc' }]
};

function buildBranch(ratio, ontCount) {
  const t = new Topology();
  const splitter = catalog.find(function (s) { return s.model === 'PON Splitter ' + ratio; });
  const ont = ontSpec;
  const olt = t.addDevice(oltSpec);
  const sp = t.addDevice(splitter);
  olt.name = 'OLT-1'; sp.name = 'SPL-1';
  olt.interfaces.get('gpon0/1').ip = '10.100.0.1';
  olt.interfaces.get('gpon0/1').mask = '255.255.255.0';
  t.connect(olt.id, 'gpon0/1', sp.id, 'uplink');
  const onts = [];
  for (let i = 1; i <= ontCount; i++) {
    const o = t.addDevice(ont);
    o.name = 'ONT-' + i;
    o.interfaces.get('pon').ip = '10.100.0.' + (10 + i);
    o.interfaces.get('pon').mask = '255.255.255.0';
    t.connect(sp.id, 'leg' + i, o.id, 'pon');
    onts.push(o);
  }
  return { t: t, olt: olt, sp: sp, onts: onts };
}

console.log('A splitter is a coupler, not a switch:');
{
  const lab = buildBranch('1:8', 3);
  const sim = new Simulator(lab.t);
  const r = sim.ping(lab.olt.id, '10.100.0.11', { count: 1 });
  ok(r.success, 'an OLT reaches an ONT through the splitter');
  const splits = r.events.filter(function (e) { return e.type === 'split'; });
  ok(splits.length > 0, 'frames are replicated at the coupler (' + splits.length + ' split events)');
  ok(lab.sp.macTable.size === 0, 'and it never learns a MAC address (footprint: ' + lab.sp.macTable.size + ')');
  ok(!splits.some(function (e) { return e.type === 'switch'; }),
    'a coupler is not reported as switching');
}

console.log('\nOne OLT port serves every ONT on the branch:');
{
  for (const n of [1, 2, 4]) {
    const lab = buildBranch('1:8', n);
    const sim = new Simulator(lab.t);
    let up = 0;
    for (let i = 1; i <= n; i++) {
      if (sim.ping(lab.olt.id, '10.100.0.' + (10 + i), { count: 1 }).success) up++;
    }
    ok(up === n, n + ' ONT(s) on one splitter all answer (' + up + '/' + n + ')');
  }
}

console.log('\nA splitter only takes fibre, with the right polish:');
{
  const lab = buildBranch('1:4', 1);
  const uplink = lab.sp.interfaces.get('uplink');
  ok(uplink.hardware.cage === 'sc-apc', 'splitter legs are SC/APC (' + uplink.hardware.cage + ')');
  ok(uplink.hardware.media.indexOf('gpon-sc-apc') !== -1, 'and carry GPON medium');

  const switchSpec = catalog.find(function (s) {
    return s.vendor === 'aruba' && s.model === '2930F 24G 4SFP+';
  });
  const t = new Topology();
  const sp = t.addDevice(catalog.find(function (s) { return s.model === 'PON Splitter 1:4'; }));
  const sw = t.addDevice(switchSpec);
  const verdict = t.validateLink(sp.id, 'leg1', sw.id, '1');
  ok(verdict && verdict.ok === false, 'an RJ45 switch port cannot be cabled to a splitter leg');

  const upc = { vendor: 'generic', model: 'upc-ont', label: 'UPC ONT', category: 'ont',
    capabilities: ['host'], interfaces: [{ name: 'pon', type: 'pon', speed: '2.5G', connector: 'sc-upc' }] };
  const t2 = new Topology();
  const sp2 = t2.addDevice(catalog.find(function (s) { return s.model === 'PON Splitter 1:4'; }));
  const o2 = t2.addDevice(upc);
  const v2 = t2.validateLink(sp2.id, 'leg1', o2.id, 'pon');
  const codes = (v2 && v2.errors ? v2.errors.map(function (e) { return e.code; }) : []);
  ok(v2 && v2.ok === false && codes.indexOf('E_POLISH_MISMATCH') !== -1,
    'an SC/UPC ONT cannot join an SC/APC splitter (' + codes.join(',') + ')');
}

console.log('\nSplitter hardware adds up:');
{
  for (const [ratio, legs] of [['1:2', 2], ['1:8', 8], ['1:32', 32], ['1:64', 64]]) {
    const spec = catalog.find(function (s) { return s.model === 'PON Splitter ' + ratio; });
    const d = new Topology().addDevice(spec);
    ok(d.interfaces.size === legs + 1, ratio + ' has one uplink plus ' + legs + ' legs (' + d.interfaces.size + ' ports)');
  }
}

console.log('\nThe loss budget decides reach:');
{
  const fits = optical.ponBudget({ lengthM: 20000, wavelengthNm: 1490, splitters: ['1:32'], ponClass: 'B+' });
  ok(fits.ok, 'a 1:32 split at 20 km fits a B+ budget downstream (' + fits.lossDb + ' of ' + fits.budgetDb + ' dB)');
  ok(fits.breakdown.splitters[0].lossDb === 17.5, 'the splitter is charged its real 17.5 dB, not the ideal 15.05');

  // The same physical branch fails in the other direction, because 1310 nm is
  // lossier than 1490 nm. This is what actually limits PON reach in the field.
  const down = optical.ponBudget({ lengthM: 20000, wavelengthNm: 1490, splitters: ['1:64'], ponClass: 'B+' });
  const up = optical.ponBudget({ lengthM: 20000, wavelengthNm: 1310, splitters: ['1:64'], ponClass: 'B+' });
  ok(down.ok, 'a 1:64 split at 20 km still fits downstream (' + down.lossDb + ' dB)');
  ok(!up.ok, 'but not upstream at 1310 nm (' + up.lossDb + ' dB)');
  ok(up.code === 'E_OPTICAL_BUDGET', 'and it is refused as a budget failure (' + up.code + ')');
  ok(/splitting costs/.test(up.message), 'the refusal names the splitter as the cost');
  ok(/Reduce the split ratio|higher class/.test(up.message), 'and says what to do about it');

  const shortRun = optical.ponBudget({ lengthM: 5000, wavelengthNm: 1310, splitters: ['1:64'], ponClass: 'B+' });
  ok(shortRun.ok, 'shortening the run to 5 km brings it back in budget (' + shortRun.lossDb + ' dB)');
  const higher = optical.ponBudget({ lengthM: 20000, wavelengthNm: 1310, splitters: ['1:64'], ponClass: 'C+' });
  ok(higher.ok, 'or moving to class C+ (' + higher.lossDb + ' of ' + higher.budgetDb + ' dB)');
}

console.log('\nAn over-budget branch is refused at cabling time, not left silently dead:');
{
  function cable(ratio, km) {
    const t = new Topology();
    const olt = t.addDevice(oltSpec);
    const sp = t.addDevice(catalog.find(function (s) { return s.model === 'PON Splitter ' + ratio; }));
    return t.validateLink(olt.id, 'gpon0/1', sp.id, 'uplink', { lengthM: km * 1000 });
  }
  const ok5 = cable('1:8', 5);
  ok(ok5.ok === true, 'a 1:8 split over 5 km is accepted');
  const bad = cable('1:64', 20);
  ok(bad.ok === false, 'a 1:64 split over 20 km is refused');
  const codes = (bad.errors || []).map(function (e) { return e.code; });
  ok(codes.indexOf('E_OPTICAL_BUDGET') !== -1, 'and the verdict is E_OPTICAL_BUDGET (' + codes.join(',') + ')');
  const msgE = (bad.errors || []).filter(function (e) { return e.code === 'E_OPTICAL_BUDGET'; })[0].message;
  ok(/upstream at 1310 nm|downstream at 1490 nm/.test(msgE), 'the refusal names the direction that fails');
  ok(/budget/.test(msgE), 'and the budget it broke');
}

console.log('\nCascaded splitters accumulate, and bad input is rejected:');
{
  const cascaded = optical.ponBudget({ lengthM: 1000, wavelengthNm: 1490, splitters: ['1:4', '1:8'], ponClass: 'B+' });
  ok(cascaded.breakdown.splitters.length === 2, 'both stages are counted');
  ok(cascaded.breakdown.splitterTotalDb === 18.4, 'and their loss adds up (' + cascaded.breakdown.splitterTotalDb + ' dB)');
  const bad = optical.ponBudget({ lengthM: 1000, splitters: ['1:7'] });
  ok(!bad.ok && bad.code === 'E_UNKNOWN_SPLITTER', 'an impossible split ratio is rejected');
  const badClass = optical.ponBudget({ lengthM: 1000, splitters: ['1:8'], ponClass: 'Z9' });
  ok(!badClass.ok && badClass.code === 'E_UNKNOWN_PON_CLASS', 'and so is an unknown PON class');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
