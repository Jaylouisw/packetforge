'use strict';
// A reopened lab forgot what its hardware was made of (#1459).
//
// The document states a device's identity, its ports and its configuration. `Topology.fromJSON` rebuilt the *spec* -
// the physical facts a device was built from - from a hand-picked handful of keys (vendor, model, label, category,
// capabilities, interfaces), and everything else was dropped on the floor. So a saved board came back with:
//
//   * a 1:32 splitter that split nothing, because `splitRatio` was gone - and with it the optical budget, so a
//     60 km run the console refuses to draw (`Path loss 31.3 dB exceeds the B+ budget of 28 dB by 3.3 dB`) sat in a
//     reopened lab as a clean board: `validateTopology()` reported no error at all;
//   * a passive tap that learned MAC addresses, because `passive` was gone and `isPassiveTap()` answered false.
//
// These are not decoration: they are the facts the rules read. A document has to state them, or the lab it describes
// is not the lab that was saved.
const path = require('path');
const { Topology } = require('../engine');
const { validateTopology } = require('../engine/validation');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const byModel = function (m) { return catalog.find(function (s) { return s.model === m; }); };

// Two PON ports so the door can be tried again on the reopened board without fighting a cable already in place.
const OLT = {
  vendor: 'generic', model: 'generic-olt', label: 'OLT', category: 'olt',
  capabilities: ['l3-forward', 'cli'],
  interfaces: [
    { name: 'gpon0/1', type: 'pon', speed: '2.5G', connector: 'sc-apc' },
    { name: 'gpon0/2', type: 'pon', speed: '2.5G', connector: 'sc-apc' }
  ]
};
const ONT = {
  vendor: 'generic', model: 'generic-ont', label: 'ONT', category: 'ont',
  capabilities: ['host'],
  interfaces: [{ name: 'pon', type: 'pon', speed: '2.5G', connector: 'sc-apc' }]
};
const SPLITTER = byModel('PON Splitter 1:32');

function pon(lengthM) {
  const t = new Topology();
  const olt = t.addDevice(OLT); const sp = t.addDevice(SPLITTER); const ont = t.addDevice(ONT);
  olt.name = 'OLT-1'; sp.name = 'SPL-1'; ont.name = 'ONT-1';
  const up = t.connect(olt.id, 'gpon0/1', sp.id, 'uplink', { lengthM: lengthM });
  t.connect(sp.id, 'leg1', ont.id, 'pon', { lengthM: lengthM });
  return { t: t, olt: olt, sp: sp, ont: ont, up: up };
}
function reopen(t, mutate) {
  const doc = JSON.parse(JSON.stringify(t.serialize()));
  if (mutate) mutate(doc);
  return { doc: doc, topo: Topology.fromJSON(doc) };
}
function opticalIssues(topo) {
  return validateTopology(topo).issues.filter(function (i) { return i.code === 'E_OPTICAL_BUDGET'; });
}

console.log('');
console.log('A saved board keeps the facts its rules read:');
{
  const L = pon(2000);
  const back = reopen(L.t).topo;
  const sp = back.getDevice(L.sp.id);
  ok(sp.spec.splitRatio === '1:32', 'the splitter still splits 1:32', String(sp.spec.splitRatio));
  ok(sp.spec.insertionLossDb === 17.5, 'and still declares its insertion loss', String(sp.spec.insertionLossDb));
  ok(sp.isSplitter() === true, 'and is still a splitter', String(sp.isSplitter()));
  ok(sp.isPassiveTap() === false, 'a splitter is not a passive tap', String(sp.isPassiveTap()));

  const docDevice = reopen(L.t).doc.devices.filter(function (d) { return d.id === L.sp.id; })[0];
  const docSpec = docDevice.spec || {};
  ok(docSpec.splitRatio === '1:32', 'the document states it', JSON.stringify(docSpec));
  ok(!docSpec.interfaces, 'the ports are not written twice', JSON.stringify(Object.keys(docSpec)));
  ok(!docSpec.description && !docSpec.notes && !docSpec.sourceUrl,
    'and the catalogue prose stays out of every board', JSON.stringify(Object.keys(docSpec)));
}
{
  // A CWDM mux carries its channel plan the same way, and it is the same class of fact.
  const mux = byModel('FMU-MDA0121');
  const t = new Topology();
  const a = t.addDevice(mux);
  const back = reopen(t).topo;
  ok(back.getDevice(a.id).spec.channelCount === mux.channelCount,
    'a CWDM mux keeps its channel count', String(back.getDevice(a.id).spec.channelCount));
  ok(back.getDevice(a.id).spec.channelPlan === mux.channelPlan,
    'and its channel plan', String(back.getDevice(a.id).spec.channelPlan));
}

console.log('');
console.log('The optical budget is live on a reopened board:');
{
  // Refused at the door, so the number it refuses with is the number to expect later.
  let refusal = '';
  try { pon(60000); } catch (e) { refusal = e.message; }
  ok(/exceeds the B\+ budget/.test(refusal), 'a 60 km run is refused when it is drawn', refusal.slice(0, 120));

  const over = reopen(pon(2000).t, function (doc) {
    doc.links.forEach(function (l) { l.lengthM = 60000; });
  }).topo;
  const issues = opticalIssues(over);
  // Both cables of the branch are over budget once every run is 60 km, and each is judged on its own path, so the
  // count is not the claim - the sentence is.
  ok(issues.length >= 1, 'and the same run in a document is reported', JSON.stringify(issues.length));
  ok(issues.every(function (i) { return /exceeds the B\+ budget/.test(i.message); }),
    'every one of them naming the budget it blew', JSON.stringify(issues.map(function (i) { return i.message.slice(0, 60); })));
  ok(issues[0] && issues[0].severity === 'error', 'as an error, not a warning', issues[0] && issues[0].severity);
  const uplinkIssue = issues.filter(function (i) { return /gpon0\/1/.test(i.message); })[0] || issues[0];
  ok(uplinkIssue && /Path loss 31\.3 dB exceeds the B\+ budget of 28 dB by 3\.3 dB/.test(uplinkIssue.message),
    'with the numbers the door used', uplinkIssue && uplinkIssue.message);
  ok(issues[0] && /splitting costs 17\.5 dB/.test(issues[0].message),
    'naming the splitter as the cost', issues[0] && issues[0].message);
  ok(validateTopology(over).ok === false, 'so the board is not called clean', String(validateTopology(over).ok));

  const fine = reopen(pon(2000).t).topo;
  ok(opticalIssues(fine).length === 0, 'a run inside the budget stays clean', String(opticalIssues(fine).length));
  ok(validateTopology(fine).ok === true, 'and the board is clean', String(validateTopology(fine).ok));
}

console.log('');
console.log('The door is still a door after the lab is reopened:');
{
  const L = pon(2000);
  const back = reopen(L.t).topo;
  let refusal = null;
  try {
    back.connect(back.getDevice(L.olt.id).id, 'gpon0/2', back.getDevice(L.sp.id).id, 'leg2', { lengthM: 60000 });
  } catch (e) { refusal = e.message; }
  ok(refusal !== null, 'a 60 km run drawn on the reopened board is refused', String(refusal));
  ok(/exceeds the B\+ budget/.test(String(refusal)), 'with the budget sentence, not a shrug', String(refusal).slice(0, 120));
  ok(back.links.size === 2, 'and no cable was made', String(back.links.size));
}

console.log('');
console.log('A passive tap does not come back as a box that learns:');
{
  const tap = byModel('P1GCCB');
  ok(!!tap && tap.passive === true, 'the catalogue still has a passive tap to test with', tap && String(tap.passive));
  const t = new Topology();
  const dev = t.addDevice(tap);
  const back = reopen(t).topo;
  const loaded = back.getDevice(dev.id);
  ok(loaded.spec.passive === true, 'the file still says the tap is passive', String(loaded.spec.passive));
  ok(loaded.isPassiveTap() === true, 'so it is still a passive tap', String(loaded.isPassiveTap()));
  const fresh = t.getDevice(dev.id);
  ok(fresh.isPassiveTap() === loaded.isPassiveTap(),
    'the reopened device answers the same question the saved one did',
    String(fresh.isPassiveTap()) + ' vs ' + String(loaded.isPassiveTap()));
}

console.log('');
console.log('Documents written before this rule still open:');
{
  const L = pon(2000);
  const back = reopen(L.t, function (doc) {
    doc.devices.forEach(function (d) { delete d.spec; });   // an older board: no spec anywhere
  });
  ok(back.topo.links.size === 2, 'every cable is restored', String(back.topo.links.size));
  ok(back.topo.devices.size === 3, 'every device is restored', String(back.topo.devices.size));
  ok((back.topo.loadIssues || []).length === 0, 'with nothing to report', JSON.stringify(back.topo.loadIssues));
  const sp = back.topo.getDevice(L.sp.id);
  ok(sp.interfaces.size === L.sp.interfaces.size, 'its ports are all there',
    sp.interfaces.size + ' vs ' + L.sp.interfaces.size);
  ok(sp.spec.splitRatio === undefined, 'and it simply has no ratio to read, rather than a wrong one',
    String(sp.spec.splitRatio));

  // The rest of the device is untouched by the change: name, address, configuration, links.
  const withSpec = reopen(L.t).topo;
  const ont = withSpec.getDevice(L.ont.id);
  ok(ont.name === 'ONT-1', 'a device keeps its name', ont.name);
  ok(ont.interfaces.get('pon').cage === L.ont.interfaces.get('pon').cage,
    'and its port hardware', String(ont.interfaces.get('pon').cage));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
