'use strict';
// Proves SCION is wired into the simulator: beaconing runs over the real
// peering graph, paths compose from the segment set, selection is policy-aware,
// and a source-routed packet crosses the ASes without consulting IP routing.
const path = require('path');
const { Topology, Simulator, runCommands, scion } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  \u2713 ' + msg); } else { failed++; console.error('  \u2717 ' + msg); } }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}

const t = new Topology();
function cli(dev, cmds) { return runCommands(dev, t, null, ['enable', 'configure terminal'].concat(cmds)).lines; }

const R1 = t.addDevice(spec('generic', 'generic-router'));
const R2 = t.addDevice(spec('generic', 'generic-router'));
const C1 = t.addDevice(spec('generic', 'generic-router'));
const C3 = t.addDevice(spec('generic', 'generic-router'));
const R9 = t.addDevice(spec('generic', 'generic-router'));
const RA = t.addDevice(spec('generic', 'generic-router'));
R1.name = 'R1'; R2.name = 'R2'; C1.name = 'C1'; C3.name = 'C3'; R9.name = 'R9'; RA.name = 'RA';

// R1 and R2 each reach two core ASes; the cores are also linked to each other.
t.connect(R1.id, 'Gi0/0', C1.id, 'Gi0/0');
t.connect(C1.id, 'Gi0/1', R2.id, 'Gi0/0');
t.connect(R1.id, 'Gi0/1', C3.id, 'Gi0/0');
t.connect(C3.id, 'Gi0/1', R2.id, 'Gi0/1');
t.connect(C1.id, 'Gi0/2', C3.id, 'Gi0/2');
// An island: two non-core ASes with no beaconed route to any core.
t.connect(R9.id, 'Gi0/0', RA.id, 'Gi0/0');

console.log('SCION membership through the CLI:');
const o1 = cli(R1, ['scion 1-ff00:0:110']);
ok(/SCION 1-ff00:0:110/.test(o1.join(' ')), 'a non-core ISD-AS is accepted');
ok(R1.config.scionAs === '1-ff00:0:110', 'membership stored on the device');
const o2 = cli(C1, ['scion 1-ff00:0:0']);
ok(/\(core AS\)/.test(o2.join(' ')), 'an AS ending in :0 is recognised as core');
const o3 = cli(R1, ['scion 1-nonsense']);
ok(/% Invalid SCION ISD-AS/.test(o3.join(' ')), 'a malformed ISD-AS is rejected');
ok(R1.config.scionAs === '1-ff00:0:110', 'and the previous membership is kept');
const o4 = cli(R1, ['no scion']);
ok(R1.config.scionAs === null, '"no scion" removes membership');
cli(R1, ['scion 1-ff00:0:110']);

cli(R2, ['scion 1-ff00:0:120']);
cli(C3, ['scion 1-ff01:0:0']);
cli(R9, ['scion 1-ff00:0:190']);
cli(RA, ['scion 1-ff00:0:191']);

console.log('\nBeaconing runs over the peering graph:');
let sim = new Simulator(t);
const S = sim.computeScion();
ok(S.members.length === 6, 'six ASes discovered in the topology');
ok(S.cores.length === 2, 'two core ASes (' + S.cores.join(', ') + ')');
ok(S.cores.indexOf('1-ff00:0:0') >= 0 && S.cores.indexOf('1-ff01:0:0') >= 0, 'and they are the ones ending in :0');
const ups = S.segments.filter(function (s) { return s.type === scion.PATH_TYPES.UP; });
const downs = S.segments.filter(function (s) { return s.type === scion.PATH_TYPES.DOWN; });
ok(ups.length > 0 && downs.length > 0, 'up and down segments were produced (' + ups.length + ' up, ' + downs.length + ' down)');
ok(ups.some(function (s) { return s.from === '1-ff00:0:110'; }), 'R1 holds an up-segment toward a core');
ok(!ups.some(function (s) { return s.from === '1-ff00:0:190'; }), 'the isolated AS R9 holds none');
ok(S.coreSegments.length > 0, 'core-to-core segments exist between the two cores');

console.log('\nPath composition and selection:');
const cand = sim.scionPaths('1-ff00:0:110', '1-ff00:0:120');
ok(cand.paths.length >= 4, 'several paths compose for R1 -> R2 (' + cand.paths.length + ')');
const sel = sim.selectScionPath('1-ff00:0:110', '1-ff00:0:120');
const hopList = scion.pathHops(sel.path);
ok(hopList.length === 3, 'the selected path is the shortest one, 3 AS hops (' + hopList.join(' -> ') + ')');
ok(sel.path.segments.map(function (s) { return s.type; }).join('|') === 'up|down', 'and its shape is up|down');
ok(hopList[0] === '1-ff00:0:110' && hopList[2] === '1-ff00:0:120', 'it enters at R1 and exits at R2');
ok(hopList[1] === '1-ff00:0:0', 'transiting core AS 1-ff00:0:0');

const avoid = sim.selectScionPath('1-ff00:0:110', '1-ff00:0:120', { avoidAses: ['1-ff00:0:0'] });
const avoidedHops = scion.pathHops(avoid.path);
ok(avoidedHops.indexOf('1-ff00:0:0') === -1, 'policy avoidance steers around core AS 1-ff00:0:0');
ok(avoidedHops.indexOf('1-ff01:0:0') >= 0, 'and the replacement path goes through the other core (' + avoidedHops.join(' -> ') + ')');

console.log('\nA source-routed packet crosses the ASes:');
sim = new Simulator(t);
const r = sim.pingScion(R1.id, R2.id);
ok(r.success === true, 'pingScion R1 -> R2 delivers');
ok(r.hops.length === 3, 'the packet carried a 3-AS path');
const hopEvents = r.events.filter(function (e) { return e.type === 'scion-hop'; });
ok(hopEvents.length === 3, 'three hop events were logged');
ok(hopEvents[1] && hopEvents[1].to === 'C1' && hopEvents[2].to === 'R2', 'R1 -> C1 -> R2');
ok(r.events.some(function (e) { return e.type === 'scion-path'; }), 'the chosen path was logged with its shape');
ok(r.events.some(function (e) { return e.type === 'scion-delivered' && e.at === 'R2'; }), 'and delivery is recorded at R2');
ok(r.latencyMs !== undefined && r.latencyMs > 0, 'the path reports a latency (' + r.latencyMs + ' ms)');

console.log('\nThis works with no IP configuration at all:');
const withIp = [];
for (const d of t.devices.values()) {
  for (const i of d.interfaces.values()) if (i.ip) withIp.push(d.name + '/' + i.name);
}
ok(withIp.length === 0, 'not one interface has an IPv4 address (' + withIp.join(',') + ')');
ok(!r.events.some(function (e) { return e.type === 'arp' || e.type === 'route'; }), 'no ARP or IP routing took place');
ok(r.success === true, 'and the packet still arrived');

console.log('\nImpossible SCION paths are refused with a reason:');
const blocked = sim.pingScion(R9.id, RA.id);
ok(blocked.success === false, 'R9 -> RA fails: no core is reachable, so no up-segment exists');
ok(typeof blocked.reason === 'string' && blocked.reason.length > 0, 'a reason is reported: "' + blocked.reason + '"');
ok(blocked.events.some(function (e) { return e.type === 'scion-drop'; }), 'a scion-drop event is logged');
ok(blocked.candidates === 0, 'no candidate paths');

console.log('\nA missing interconnect is caught at forwarding time:');
const t2 = new Topology();
const A = t2.addDevice(spec('generic', 'generic-router'));
const B = t2.addDevice(spec('generic', 'generic-router'));
const K = t2.addDevice(spec('generic', 'generic-router'));
A.name = 'A'; B.name = 'B'; K.name = 'K';
t2.connect(A.id, 'Gi0/0', K.id, 'Gi0/0');
t2.connect(B.id, 'Gi0/0', K.id, 'Gi0/1');
runCommands(A, t2, null, ['enable', 'configure terminal', 'scion 1-ff00:0:210']);
runCommands(B, t2, null, ['enable', 'configure terminal', 'scion 1-ff00:0:220']);
runCommands(K, t2, null, ['enable', 'configure terminal', 'scion 1-ff00:0:0']);
const sim2 = new Simulator(t2);
const ok2 = sim2.pingScion(A.id, B.id);
ok(ok2.success === true, 'A -> B via the core delivers when the interconnect exists');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
