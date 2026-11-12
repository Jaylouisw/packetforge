'use strict';
// A reopened lab announced nothing: every link read "no LLDP has been heard on any port" (#1467).
//
//   sw> show lldp neighbors          save, reopen, ask again
//   Neighbour  Local port  Port ID  Mgmt address        Neighbour  Local port  Port ID  Mgmt address
//   Router-r1  Fa0/1       Gi0/0    10.0.0.1            (none - no LLDP has been heard on any port)
//   PC-p1      Fa0/3       eth0     10.0.0.12
//
// Neighbour rows are not stored state: they are announced. The board announces when a cable is plugged
// (`refreshNeighbours()`, the call the UI makes after `addLink`), and a load is the same event - every cable in the
// document is being added right now. `Topology.fromJSON()` marked nothing, so the simulator built on a reopened lab
// never announced, and every port claimed its far end had never been heard from, with the cables all in place.
//
// What this does NOT invent: the MAC table stays empty after a reopen. A MAC entry is learned from a frame, so an
// empty table on a board that has carried no frames is the truth, and the view says so.
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
const MODEL = function (m) { return catalog.find(function (s) { return s.model === m; }); };
const ROUTER = MODEL('generic-router'), SWITCH = MODEL('generic-switch'), PC = MODEL('generic-pc');

function wire() {
  const t = new Topology();
  t.addDevice(SWITCH, 'sw'); t.addDevice(ROUTER, 'r1'); t.addDevice(PC, 'p1');
  t.connect('r1', 'Gi0/0', 'sw', 'Fa0/1');
  t.connect('p1', 'eth0', 'sw', 'Fa0/3');
  return t;
}

function cfg(t, sim, id, lines) {
  const c = new CliSession(t.getDevice(id), t, sim);
  c.run('configure terminal');
  lines.forEach(function (l) { return c.run(l); });
  c.run('end');
}

// A board that has been wired and announced, the way the UI leaves it after the last cable.
function liveLab() {
  const t = wire();
  const sim = new Simulator(t);
  cfg(t, sim, 'r1', ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown']);
  cfg(t, sim, 'p1', ['interface eth0', 'ip address 10.0.0.12 255.255.255.0']);
  sim.refreshNeighbours();
  return { t: t, sim: sim };
}

function show(t, sim, id, cmd) {
  return new CliSession(t.getDevice(id), t, sim).run(cmd).output;
}
function rows(out) {
  return out.filter(function (l) { return /^\s{2}\S/.test(l) && !/^  (Neighbour|\(none)/.test(l); })
    .map(function (l) { return l.trim().replace(/\s+/g, ' '); });
}

console.log('');
console.log('Before the save, the board knows its neighbours:');
let before = null;
{
  const L = liveLab();
  before = rows(show(L.t, L.sim, 'sw', 'show lldp neighbors'));
  ok(before.length === 2, 'two neighbours on the switch', JSON.stringify(before));
  ok(before.some(function (r) { return /Router-r1 Fa0\/1 Gi0\/0 10\.0\.0\.1/.test(r); }),
    'the router, with the management address it advertises', JSON.stringify(before));
  ok(before.some(function (r) { return /PC-p1 Fa0\/3 eth0 10\.0\.0\.12/.test(r); }),
    'and the host', JSON.stringify(before));
}

console.log('');
console.log('A reopened lab knows them straight away:');
{
  const L = liveLab();
  const doc = JSON.parse(JSON.stringify(L.t.serialize()));
  const re = Topology.fromJSON(JSON.parse(JSON.stringify(doc)));
  const sim = new Simulator(re);
  const after = rows(show(re, sim, 'sw', 'show lldp neighbors'));
  ok(after.length === 2, 'the same two neighbours, with nothing plugged and no ping sent', JSON.stringify(after));
  ok(JSON.stringify(after) === JSON.stringify(before), 'port for port, identical to before the save',
    JSON.stringify(after) + '  vs  ' + JSON.stringify(before));
  const text = show(re, sim, 'sw', 'show lldp neighbors').join('\n');
  ok(text.indexOf('no LLDP has been heard') === -1, 'and nothing claims the link is silent', text);

  const p1 = rows(show(re, sim, 'p1', 'show lldp neighbors'));
  ok(p1.length === 1 && /SW1|Switch/.test(p1[0]), 'the far end of the cable knows too', JSON.stringify(p1));
}

console.log('');
console.log('The mark is what does it - a fresh board is unchanged:');
{
  const t = wire();
  const sim = new Simulator(t);
  ok(t.loadedFromDocument === undefined, 'a board built in code is not marked as a document', String(t.loadedFromDocument));
  const fresh = rows(show(t, sim, 'sw', 'show lldp neighbors'));
  ok(fresh.length === 0, 'and announces nothing until something asks it to (as before)', JSON.stringify(fresh));
  const text = show(t, sim, 'sw', 'show lldp neighbors').join('\n');
  ok(/no LLDP has been heard|\(none/.test(text), 'the view still says how it knows nothing', text);
  const L = liveLab();
  const re = Topology.fromJSON(JSON.parse(JSON.stringify(L.t.serialize())));
  ok(re.loadedFromDocument === true, 'a document-built board is marked', String(re.loadedFromDocument));
}

console.log('');
console.log('It announces once, not once per simulator:');
{
  const L = liveLab();
  const re = Topology.fromJSON(JSON.parse(JSON.stringify(L.t.serialize())));
  const first = new Simulator(re);            // this one announces
  const afterFirst = JSON.stringify(first.payload ? first.payload() : null);
  const second = new Simulator(re);           // and this one must not
  const afterSecond = JSON.stringify(second.payload ? second.payload() : null);
  ok(!!afterFirst, 'the first simulator on a loaded board publishes a payload', '');
  ok(afterSecond === afterFirst,
    'a second simulator on the same board announces nothing, so the payload does not move',
    String(afterFirst && afterFirst.length) + ' -> ' + String(afterSecond && afterSecond.length));
  const rowsAgain = rows(show(re, second, 'sw', 'show lldp neighbors'));
  ok(rowsAgain.length === 2, 'and the neighbours are still there, from the first announcement', JSON.stringify(rowsAgain));
}

console.log('');
console.log('Announcing on load does not change the document:');
{
  const L = liveLab();
  const first = JSON.stringify(L.t.serialize());
  const re = Topology.fromJSON(JSON.parse(first));
  const sim = new Simulator(re);       // this announces
  sim.refreshNeighbours();             // and so does this
  const second = JSON.stringify(re.serialize());
  ok(second === first, 'save -> load -> save is byte-identical', second.length + ' vs ' + first.length);
    const saved = JSON.parse(first);
  ok((saved.devices || []).every(function (d) { return !d.lldp || Object.keys(d.lldp).length === 0; }),
    'the document never carried neighbour rows to begin with', JSON.stringify((saved.devices || []).map(function (d) { return d.lldp; })));
}

console.log('');
console.log('What a reopen still does not invent:');
{
  const L = liveLab();
  const re = Topology.fromJSON(JSON.parse(JSON.stringify(L.t.serialize())));
  const sim = new Simulator(re);
    // The MAC table is *derived from the announcement*, not restored: whatever the switch learns from the frames the
  // board has just sent is what a live board learns when a cable is plugged, and nothing more.
  const loadedRows = rows(show(re, sim, 'sw', 'show mac address-table'));
  const liveRows = rows(show(L.t, L.sim, 'sw', 'show mac address-table'));
  const freshBoard = wire();
  const freshRows = rows(show(freshBoard, new Simulator(freshBoard), 'sw', 'show mac address-table'));
  ok(freshRows.length === 0, 'a board that has announced nothing has learned nothing', JSON.stringify(freshRows));
  ok(JSON.stringify(loadedRows) === JSON.stringify(liveRows),
    'and a reopened board holds exactly the table a live one holds after the same announcement',
    JSON.stringify(loadedRows) + '  vs  ' + JSON.stringify(liveRows));
  const iface = show(re, sim, 'p1', 'show interfaces eth0').join('\n');
  ok(/packets input/.test(iface), 'the counters are a fresh run, and say so plainly', iface.split('\n').filter(function (l) { return /packets/.test(l); })[0]);
  // The announcement itself is still counted, which is the rule #1457 settled.
  ok(/packets output/.test(iface), 'including what the announcement put on the wire', '');
}

console.log('');
console.log('A trunk that carries one VLAN still describes both its ends:');
{
  const t = new Topology();
  t.addDevice(SWITCH, 'sw'); t.addDevice(ROUTER, 'r1'); t.addDevice(PC, 'p1');
  t.connect('r1', 'Gi0/0', 'sw', 'Fa0/1');
  t.connect('p1', 'eth0', 'sw', 'Fa0/3');
  const sim = new Simulator(t);
  cfg(t, sim, 'sw', ['vlan 10', 'exit', 'interface Fa0/1', 'switchport mode trunk',
    'switchport trunk allowed vlan 10', 'interface Fa0/3', 'switchport mode trunk', 'switchport trunk allowed vlan 10']);
  cfg(t, sim, 'r1', ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown']);
  sim.refreshNeighbours();
  const re = Topology.fromJSON(JSON.parse(JSON.stringify(t.serialize())));
  const sim2 = new Simulator(re);
  const swRows = rows(show(re, sim2, 'sw', 'show lldp neighbors'));
  ok(swRows.length >= 1, 'the switch still describes the router across the trunk', JSON.stringify(swRows));
  const r1Rows = rows(show(re, sim2, 'r1', 'show lldp neighbors'));
  ok(r1Rows.length >= 1, 'and the router describes the switch', JSON.stringify(r1Rows));
  ok(show(re, sim2, 'sw', 'show interfaces Fa0/1').join('\n').indexOf('not allowed on egress') === -1,
    'without a drop logged against the link protocol', '');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
