'use strict';
// A saved lab reopens with its conversations still in it (#1435).
//
// The flow table lives on the topology, so it is runtime state of the board - but `serialize()` never wrote it, and
// `fromJSON()` never read it. So a lab with an established TCP flow saved to disk and reopened came back with an
// empty flow table: the board said nothing was connected, while the document the user was looking at said a
// conversation existed. One more surface that had the fact and one that did not.
//
// The ghost case matters as much as the round trip: a hand-written or older document carrying a flow whose endpoints
// are not on the board must not be adopted - it is reported in `loadIssues`, like a cable that could not be restored,
// and the board still opens.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Topology, Simulator, runCommands } = require('../engine');
const flowLib = require('../engine/flow');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) { return catalog.find(function (x) { return x.vendor === v && x.model === m; }); }

function lab() {
  const t = new Topology();
  const r1 = t.addDevice(spec('cisco', 'ISR 4331')); r1.name = 'R1';
  const sw = t.addDevice(spec('generic', 'generic-switch')); sw.name = 'SW';
  const a = t.addDevice(spec('generic', 'generic-pc')); a.name = 'PC';
  t.connect(r1.id, 'Gi0/0/0', sw.id, 'Fa0/1');
  t.connect(sw.id, 'Fa0/2', a.id, 'eth0');
  const cfg = function (d, lines) { runCommands(d, t, null, ['configure terminal'].concat(lines)); };
  cfg(r1, ['interface Gi0/0/0', 'ip address 10.91.0.1 255.255.255.0', 'no shutdown', 'end']);
  cfg(a, ['interface eth0', 'ip address 10.91.0.10 255.255.255.0', 'end']);
  return { t: t, r1: r1, sw: sw, a: a, cfg: cfg };
}

console.log('');
console.log('A board with a live conversation serializes it:');
{
  const L = lab();
  const s = new Simulator(L.t, { flowState: L.t.flowState });
  const opened = s.openFlow({ proto: 'tcp', srcDevice: L.a.id, dstDevice: L.r1.id, srcPort: 50000, dstPort: 22, bytes: 100 });
  ok(opened.ok === true, 'the flow opens', JSON.stringify(opened).slice(0, 120));
  const doc = L.t.serialize();
  ok(Array.isArray(doc.flows) && doc.flows.length === 1, 'serialize() writes the flow table',
    JSON.stringify(doc.flows));
  const f = doc.flows[0];
  ok(f.id === opened.flow.id && f.state === 'established', 'with its id and state', JSON.stringify({ id: f.id, state: f.state }));
  ok(Array.isArray(f.hops) && JSON.stringify(f.hops) === JSON.stringify([L.a.id, L.sw.id, L.r1.id]),
    'and the path it took', JSON.stringify(f.hops));
}

console.log('');
console.log('And a reloaded board comes back with it:');
{
  const L = lab();
  const s = new Simulator(L.t, { flowState: L.t.flowState });
  const opened = s.openFlow({ proto: 'tcp', srcDevice: L.a.id, dstDevice: L.r1.id, srcPort: 50000, dstPort: 22, bytes: 100 });
  const doc = L.t.serialize();
  const t2 = Topology.fromJSON(JSON.parse(JSON.stringify(doc)));
  const flows = flowLib.listFlows(t2.flowState);
  ok(flows.length === 1, 'fromJSON() restores the flow', JSON.stringify(flows.map(function (f) { return f.id; })));
  ok(flows[0] && flows[0].id === opened.flow.id && flows[0].state === 'established', 'with the same id and state',
    JSON.stringify(flows[0] && { id: flows[0].id, state: flows[0].state }));
  ok(flows[0] && JSON.stringify(flows[0].hops) === JSON.stringify([L.a.id, L.sw.id, L.r1.id]),
    'and the same hops, so a later removal still knows the path', JSON.stringify(flows[0] && flows[0].hops));
  // the id allocator must not collide with the restored flow
  ok(flowLib.nextFlowId(t2.flowState) !== opened.flow.id, 'and the next flow id does not collide',
    flowLib.nextFlowId(t2.flowState) + ' vs ' + opened.flow.id);
  // a reloaded flow still dies with its path
  t2.removeDevice(L.sw.id);
  const rec = flowLib.listFlows(t2.flowState)[0];
  // (the server sweeps on delete; here the engine-side record simply still has its hops)
  ok(JSON.stringify(rec.hops) === JSON.stringify([L.a.id, L.sw.id, L.r1.id]), 'the reloaded flow still knows its path');
}

console.log('');
console.log('A document with a ghost endpoint is refused the flow, not the board:');
{
  const L = lab();
  const doc = L.t.serialize();
  doc.flows = [
    { id: 'flow-9', state: 'established', srcDevice: 'ghost', dstDevice: L.r1.id, hops: ['ghost', L.r1.id] },
    { id: 'flow-10', state: 'established', srcDevice: L.a.id, dstDevice: 'alsogone', hops: [L.a.id] },
    { id: 'flow-11', state: 'established', srcDevice: L.a.id, dstDevice: L.r1.id, hops: [L.a.id, L.r1.id] },
    { state: 'established' }
  ];
  const t2 = Topology.fromJSON(JSON.parse(JSON.stringify(doc)));
  const flows = flowLib.listFlows(t2.flowState);
  ok(flows.length === 1 && flows[0].id === 'flow-11', 'only the flow whose endpoints are on the board is restored',
    JSON.stringify(flows.map(function (f) { return f.id; })));
  const issues = (t2.loadIssues || []).filter(function (i) { return i.code === 'E_FLOW_GHOST_ENDPOINT'; });
  ok(issues.length === 2, 'and both ghosts are reported', JSON.stringify(issues.map(function (i) { return i.flowId; })));
  ok(issues.every(function (i) { return /not on this board/.test(i.message); }), 'saying why', JSON.stringify(issues));
  const bad = (t2.loadIssues || []).filter(function (i) { return i.code === 'E_FLOW_BAD_RECORD'; });
  ok(bad.length === 1, 'and a record with no id is reported too', JSON.stringify(bad));
  ok((t2.devices.size) === 3, 'and the board itself still opened', String(t2.devices.size));
}

console.log('');
console.log('A board with no flows serializes an empty list, not a missing key:');
{
  const L = lab();
  const doc = L.t.serialize();
  ok(Array.isArray(doc.flows) && doc.flows.length === 0, 'flows is present and empty', JSON.stringify(doc.flows));
  const t2 = Topology.fromJSON(JSON.parse(JSON.stringify(doc)));
  ok(flowLib.listFlows(t2.flowState).length === 0, 'and reloads empty', JSON.stringify(flowLib.listFlows(t2.flowState)));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
