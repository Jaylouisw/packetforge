'use strict';
// A document's cables are restored through the same name resolver the console uses (#1519).
//
// `Topology.connect()` has resolved port names through engine/iface-name.js since #39, so
// `ether1` and `eth1` are one socket. The loader's pre-check did not: it asked
// `dev.interfaces.has(end.iface)` - an exact map lookup - so a cable whose end needed the
// resolver was refused *before* connect() ever saw it, and the board came back with the
// cables missing and a report saying the port did not exist. It did exist; the spelling
// differed. An older lab file carries the spelling the catalogue used at the time, which is
// exactly the case #39 exists for.
//
// What this file pins:
//   * a document naming a port in a spelling the resolver knows loads with every cable, and
//     the cable ends up on the port the resolver named, with `peer` set on both sides;
//   * a document naming a port the device genuinely does not have keeps the cables it can
//     rebuild, and reports each loss as a warning naming the cable id and the port that
//     failed;
//   * every cable the document declares is either restored or explained - the counts have to
//     account for each other, so a loss cannot be quiet.
const path = require('path');
const { Topology } = require('../engine/topology');
const { Device } = require('../engine/device');
const { resolvePortName } = require('../engine/iface-name');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const MIKROTIK = catalog.filter(function (s) { return /mikrotik/i.test(s.vendor || '') && s.model === 'CCR1009-7G-1C-1S+'; })[0];
const SWITCH = catalog.filter(function (s) { return /s5130s-28p-ei/i.test(s.model || ''); })[0];

// A device document as `serialize()` writes one, with no cables, twice over: what a saved
// two-box lab looks like before its links are read.
function devicesDoc(spec) {
  const one = Device.hydrate('d1', Object.assign({}, spec), { id: 'd1', spec: spec }).serialize();
  const two = JSON.parse(JSON.stringify(one));
  two.id = 'd2';
  return { format: 'packetforge-topology', version: 1, seq: 3, devices: [one, two], links: [] };
}

function withLinks(spec, pairs) {
  const doc = devicesDoc(spec);
  doc.links = pairs.map(function (p, i) {
    return { id: 'l' + (i + 1), a: { deviceId: 'd1', iface: p[0] }, b: { deviceId: 'd2', iface: p[1] } };
  });
  return doc;
}

function issuesOf(t) { return t.loadIssues || []; }
function ends(t, id) {
  const l = t.links.get(id);
  if (!l) return null;
  const a = t.devices.get(l.a.deviceId).interfaces.get(l.a.iface);
  const b = t.devices.get(l.b.deviceId).interfaces.get(l.b.iface);
  return { a: l.a.iface, b: l.b.iface, aPeer: a && a.peer, bPeer: b && b.peer };
}

console.log('');
console.log('A cable naming a port in a spelling that needs the resolver still loads:');
{
  // `eth1` is what the panel says; `ether1` is what RouterOS calls it, and what a lab file
  // written before the catalogue was renamed to the panel spelling carries (#39).
  const panel = Device.hydrate('probe', Object.assign({}, MIKROTIK), { id: 'probe', spec: MIKROTIK });
  ok(resolvePortName(panel, 'ether1') === 'eth1',
    'the resolver maps the console spelling ether1 onto the panel port eth1', String(resolvePortName(panel, 'ether1')));
  ok(resolvePortName(panel, 'ether1') !== null && !panel.interfaces.has('ether1'),
    'and the document spelling is not literally a port name, so an exact lookup cannot find it');

  const t = Topology.fromJSON(withLinks(MIKROTIK, [['ether1', 'ether1'], ['ether2', 'ether2']]));
  ok(t.links.size === 2, 'a document with two console-spelled cables loads both of them', String(t.links.size));
  ok(issuesOf(t).length === 0, 'and says nothing, because nothing was lost', JSON.stringify(issuesOf(t)));

  const first = ends(t, 'l1');
  ok(!!first && first.a === 'eth1' && first.b === 'eth1',
    'the cable is stored on the port the resolver named, not the spelling in the document',
    JSON.stringify(first));
  ok(!!first && !!first.aPeer && first.aPeer.iface === 'eth1' && first.aPeer.deviceId === 'd2',
    'and iface.peer points at the far end, which only connect() sets', JSON.stringify(first && first.aPeer));
  ok(!!first && !!first.bPeer && first.bPeer.deviceId === 'd1',
    'on both ends', JSON.stringify(first && first.bPeer));
}
{
  // Case is the other spelling the resolver folds: a document written by a person, or by a
  // tool that lower-cases names, is the same lab.
  const t = Topology.fromJSON(withLinks(SWITCH, [['gigabitethernet1/0/25', 'GIGABITETHERNET1/0/26']]));
  ok(t.links.size === 1, 'a cable naming GigabitEthernet ports in a different case loads', String(t.links.size));
  const e = ends(t, 'l1');
  ok(!!e && e.a === 'GigabitEthernet1/0/25' && e.b === 'GigabitEthernet1/0/26',
    'on the ports the catalogue spells that way', JSON.stringify(e));
  ok(issuesOf(t).length === 0, 'with nothing to report', JSON.stringify(issuesOf(t)));
}
{
  // The spelling the catalogue itself uses still works, and is the common case: every lab
  // file written since the catalogue was last renamed names its ports this way.
  const t = Topology.fromJSON(withLinks(SWITCH, [['GigabitEthernet1/0/25', 'GigabitEthernet1/0/26']]));
  ok(t.links.size === 1 && issuesOf(t).length === 0,
    'the exact catalogue spelling keeps loading, and quietly', String(t.links.size) + ' ' + JSON.stringify(issuesOf(t)));
}

console.log('');
console.log('A cable that cannot be rebuilt is a warning naming the cable and the port:');
{
  const doc = withLinks(SWITCH, [
    ['GigabitEthernet1/0/25', 'GigabitEthernet1/0/26'],
    ['GigabitEthernet1/0/99', 'GigabitEthernet1/0/27'],
    ['GigabitEthernet1/0/26', 'GigabitEthernet1/0/28']
  ]);
  const t = Topology.fromJSON(doc);
  ok(doc.links.length === 3, 'the document declares three cables', String(doc.links.length));
  ok(t.links.size === 2, 'the two that can be rebuilt are restored', String(t.links.size));

  const warnings = issuesOf(t);
  ok(warnings.length === 1, 'and exactly one thing is reported', JSON.stringify(warnings));
  const w = warnings[0] || {};
  ok(w.severity === 'warning', 'the report is a warning - the board loaded, one cable did not',
    JSON.stringify(w.severity));
  ok(w.code === 'E_LINK_ENDPOINT_MISSING', 'with the endpoint code the docs table gives', String(w.code));
  ok(w.linkId === 'l2', 'naming the cable that failed', String(w.linkId));
  ok(/l2/.test(w.message || ''), 'and the cable id is in the sentence a person reads', String(w.message));
  ok(/GigabitEthernet1\/0\/99/.test(w.message || ''), 'with the port that failed', String(w.message));
  ok(/d1/.test(w.message || ''), 'and the device it was looked for on', String(w.message));

  // The count has to account for itself: every declared cable is restored or explained.
  ok((doc.links.length - t.links.size) === warnings.length,
    'declared minus restored equals the number of cables reported: nothing is lost quietly',
    doc.links.length + ' - ' + t.links.size + ' vs ' + warnings.length);
  ok(!!ends(t, 'l3'), 'a later cable is still restored after an earlier one fails', JSON.stringify(ends(t, 'l3')));
}
{
  // A port nobody has, named on the b end, is reported as the b end - the resolver is asked
  // about both ends, and the report names the one that failed rather than the first cable.
  const doc = withLinks(MIKROTIK, [['eth1', 'nosuchport']]);
  const t = Topology.fromJSON(doc);
  ok(t.links.size === 0, 'a cable naming a port nobody has is not restored', String(t.links.size));
  const w = issuesOf(t)[0] || {};
  ok(/nosuchport/.test(w.message || '') && /d2/.test(w.message || ''),
    'and the report names the port and the device it was not found on', String(w.message));
}
{
  // A cable the engine itself refuses is reported the same way: the board loaded, one cable of
  // it did not, so it is a warning on the document and not a reason to refuse the lab.
  const doc = withLinks(SWITCH, [
    ['GigabitEthernet1/0/25', 'GigabitEthernet1/0/26'],
    ['GigabitEthernet1/0/25', 'GigabitEthernet1/0/27']
  ]);
  const t = Topology.fromJSON(doc);
  ok(t.links.size === 1, 'two cables into one port leave the first one in place', String(t.links.size));
  const w = issuesOf(t)[0] || {};
  ok(w.code === 'E_LINK_NOT_RESTORED' && w.severity === 'warning',
    'and the refusal is a warning naming the cable', JSON.stringify(w));
  ok(/l2/.test(w.message || '') && /already connected/.test(w.message || ''),
    'with the cable id and the engine sentence that says why', String(w.message));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
