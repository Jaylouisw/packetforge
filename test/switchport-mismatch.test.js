'use strict';
// Two ends of one cable that file frames differently (#1445).
//
// `framesCompatible()` in engine/vlan.js has been the rule for "do these two ports file a frame the same way" since the
// LAG rules landed, and nothing outside its own test ever called it. So two switches joined by trunks that disagree
// about the native VLAN passed every check the board makes - right medium, matching speed, both ports up - and the
// traffic died silently: `show interfaces` reported a clean link on both boxes, `validateTopology()` said ok with no
// warnings, and the only trace was a counter on one side reading "no egress ports in VLAN 10", which sends an operator
// looking for VLAN 10 members instead of at the other end of one cable.
//
// The rule is now asked in the two places that can say something: the cable inspector (a warning, not an error - a
// trunk carrying no untagged traffic may legitimately disagree) and the data plane (the drop names the mismatch, and
// says which end sent the frame under which number).
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { validateTopology } = require('../engine/validation');
const vlanLib = require('../engine/vlan');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }
const SWITCH = spec('generic-switch'), ROUTER = spec('ISR 4331'), PC = spec('generic-pc');

// Two switches, one trunk between them, one PC on each, addresses on the PCs.
function lab(cfgA, cfgB) {
  const t = new Topology();
  t.addDevice(SWITCH, 's1');
  t.addDevice(SWITCH, 's2');
  t.addDevice(PC, 'a');
  t.addDevice(PC, 'b');
  const link = t.connect('s1', 'Fa0/1', 's2', 'Fa0/1');
  t.connect('a', 'eth0', 's1', 'Fa0/2');
  t.connect('b', 'eth0', 's2', 'Fa0/2');
  const sim = new Simulator(t);
  const c1 = new CliSession(t.getDevice('s1'), t, sim);
  const c2 = new CliSession(t.getDevice('s2'), t, sim);
  const ca = new CliSession(t.getDevice('a'), t, sim);
  const cb = new CliSession(t.getDevice('b'), t, sim);
  [ [ca, '10.9.0.1'], [cb, '10.9.0.2'] ].forEach(function (pair) {
    pair[0].run('configure terminal');
    pair[0].run('interface eth0');
    pair[0].run('ip address ' + pair[1] + ' 255.255.255.0');
    pair[0].run('end');
  });
  const configure = function (cli, lines) {
    cli.run('configure terminal');
    lines.forEach(function (l) { cli.run(l); });
    cli.run('end');
  };
  configure(c1, cfgA);
  configure(c2, cfgB);
  return { t: t, sim: sim, c1: c1, c2: c2, link: link };
}

function warnings(topo) {
  return (validateTopology(topo).issues || []).filter(function (i) { return i.code === 'W_SWITCHPORT_MISMATCH'; });
}

const TRUNK = function (native) {
  return ['interface Fa0/1', 'switchport mode trunk', 'switchport trunk native vlan ' + native];
};

console.log('');
console.log('A trunk whose two ends disagree about the native VLAN is named on the cable:');
{
  const L = lab(TRUNK(1), TRUNK(10));
  const w = warnings(L.t);
  ok(w.length === 1, 'the cable carries one warning', JSON.stringify(w));
  ok(w[0] && /native VLAN 1 against native VLAN 10 on a trunk/.test(w[0].message),
    'and it names both numbers', w[0] && w[0].message);
  const v = validateTopology(L.t);
  ok(v.ok === true, 'it is a warning, not an error: a cable is not refused for a VLAN difference',
    'ok=' + v.ok + ' errors=' + v.errorCount);
  ok(v.warningCount === 1, 'and the topology counts it as one warning', String(v.warningCount));
}

console.log('');
console.log('The rule is asked only when both ends are switchports:');
{
  const L = lab(TRUNK(1), TRUNK(1));
  ok(warnings(L.t).length === 0, 'matching native VLANs raise nothing', JSON.stringify(warnings(L.t)));
  const sameAccess = lab(['interface Fa0/1', 'switchport mode access', 'switchport access vlan 5'],
    ['interface Fa0/1', 'switchport mode access', 'switchport access vlan 5']);
  ok(warnings(sameAccess.t).length === 0, 'two access ports in the same VLAN raise nothing too');
  const routerLab = (function () {
    const t = new Topology();
    t.addDevice(ROUTER, 'r1');
    t.addDevice(ROUTER, 'r2');
    t.connect('r1', 'Gi0/0/0', 'r2', 'Gi0/0/0');
    return { t: t };
  })();
  ok(warnings(routerLab.t).length === 0, 'a cable between two routed ports raises nothing');
}

console.log('');
console.log('The other three ways two ends can disagree are named as well:');
{
  const accessDiff = lab(['interface Fa0/1', 'switchport mode access', 'switchport access vlan 5'],
    ['interface Fa0/1', 'switchport mode access', 'switchport access vlan 7']);
  ok(/access VLAN 5 against access VLAN 7/.test((warnings(accessDiff.t)[0] || {}).message || ''),
    'two access ports in different VLANs name both', (warnings(accessDiff.t)[0] || {}).message);

  const modeDiff = lab(TRUNK(1), ['interface Fa0/1', 'switchport mode access']);
  ok(/one end is a trunk port and the other is an access port/.test((warnings(modeDiff.t)[0] || {}).message || ''),
    'a trunk against an access port names the modes', (warnings(modeDiff.t)[0] || {}).message);

  const listDiff = lab(TRUNK(1).concat(['switchport trunk allowed vlan 10,20']),
    TRUNK(1).concat(['switchport trunk allowed vlan 10']));
  ok(/different allowed VLAN lists \(10 against 10,20\)/.test((warnings(listDiff.t)[0] || {}).message || ''),
    'different allowed lists name both lists, smallest first', (warnings(listDiff.t)[0] || {}).message);
}

console.log('');
console.log('One rule, so the cable warning and the drop cannot describe it differently:');
{
  const L = lab(TRUNK(1), TRUNK(10));
  const reason = vlanLib.mismatchReason({ mode: 'trunk', nativeVlan: 1 }, { mode: 'trunk', nativeVlan: 10 });
  ok(reason === 'native VLAN 1 against native VLAN 10 on a trunk', 'the shared rule writes the phrase', String(reason));
  const cable = (warnings(L.t)[0] || {}).message || '';
  ok(cable.indexOf(reason) !== -1, 'the cable warning contains it verbatim', cable);
  const p = L.sim.ping('a', '10.9.0.2', { count: 1 });
  ok(String(p.replies[0].reason).indexOf(reason) !== -1,
    'and so does the reason the ping reports', String(p.replies[0].reason));
}

console.log('');
console.log('And the frame that died says which end put it in which VLAN:');
{
  const L = lab(TRUNK(1), TRUNK(10));
  const p = L.sim.ping('a', '10.9.0.2', { count: 1 });
  const why = String(p.replies[0].reason);
  ok(/^switchport mismatch:/.test(why), 'the ping names the mismatch first', why);
  ok(/filed under VLAN 10 here/.test(why), 'naming the VLAN this box filed it under', why);
  ok(/sent it as VLAN 1/.test(why), 'and the VLAN the sending end put it in', why);
  ok(/s1 Fa0\/1/.test(why), 'and the port that sent it', why);
  ok(why.indexOf('no ARP reply') === -1,
    'the recorded cause is reported instead of the inference drawn from it', why);

  const counters = L.c2.run('show interfaces Fa0/1').output.join('\n');
  ok(/1 drop \("?switchport mismatch:/.test(counters),
    'the dropping box counts exactly one drop, under the same sentence', counters);
  const reasons = L.c2.run('show interfaces').output.join('\n');
  ok(reasons.indexOf('switchport mismatch') !== -1 || counters.indexOf('switchport mismatch') !== -1,
    'the same sentence is on the port view', reasons.slice(0, 120));
}

console.log('');
console.log('A matching trunk is untouched by all of this:');
{
  const L = lab(TRUNK(1), TRUNK(1));
  const p = L.sim.ping('a', '10.9.0.2', { count: 2 });
  ok(p.replies.every(function (r) { return r.success; }), 'the ping crosses',
    JSON.stringify(p.replies.map(function (r) { return r.success ? 'ok' : r.reason; })));
  ok(warnings(L.t).length === 0, 'and nothing is warned about the cable');
  const counters = L.c2.run('show interfaces Fa0/1').output.join('\n');
  ok(counters.indexOf('switchport mismatch') === -1, 'and no drop of that kind is recorded', counters);
}

console.log('');
console.log('`framesCompatible` still answers the question it always did:');
ok(vlanLib.framesCompatible({ mode: 'trunk', nativeVlan: 1 }, { mode: 'trunk', nativeVlan: 1 }) === true,
  'compatible trunks are still compatible');
ok(vlanLib.framesCompatible({ mode: 'trunk', nativeVlan: 1 }, { mode: 'trunk', nativeVlan: 10 }) === false,
  'and mismatched ones are still not');
ok(vlanLib.mismatchReason({ mode: 'trunk', nativeVlan: 1 }, { mode: 'trunk', nativeVlan: 1 }) === null,
  'the reason is null exactly when the answer is yes');

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
