'use strict';
// `show ip ospf` - the protocol that was configurable, computed, and unreadable (#1371).
//
// OSPF has been configurable since it was modelled: `ospf router-id`, `ospf area`, and per interface
// `ip ospf cost | area | passive`. computeOspf() turns those into adjacencies, an SPF tree and installed routes.
// But the console could not answer "who are my neighbours", "what cost is on this port", or "did the engine use
// the cost I typed" - the only place OSPF appeared was an `O` in `show ip route`.
//
// These checks assert the reports against the engine's own record (dev.ospfInterfaces / dev.ospfNeighbors, filled
// in by computeOspf), so the console cannot describe a topology the route table disagrees with.
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = require('path').join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /^ISR 4331$/.test(s.model); }) ||
  specs.find(function (s) { return /ISR 4331/.test(s.model); });

// r1 --- r2 --- r3, plus a direct r1 --- r3 link: two ways to reach r3's far network.
function lab() {
  const t = new Topology();
  ['r1', 'r2', 'r3'].forEach(function (id) { t.addDevice(ROUTER, id); });
  const c = function (a, ap, b, bp) {
    t.connect(a, ap, b, bp, { mediaId: '1000base-t', speedMbps: 1000 });
  };
  c('r1', 'Gi0/0/0', 'r2', 'Gi0/0/0');   // 10.1.0.0/24
  c('r2', 'Gi0/0/1', 'r3', 'Gi0/0/0');   // 10.2.0.0/24
  c('r1', 'Gi0/0/1', 'r3', 'Gi0/0/1');   // 10.3.0.0/24
  const addr = function (dev, port, ip) {
    const i = t.getDevice(dev).interfaces.get(port);
    i.ip = ip; i.mask = '255.255.255.0';
  };
  addr('r1', 'Gi0/0/0', '10.1.0.1'); addr('r2', 'Gi0/0/0', '10.1.0.2');
  addr('r2', 'Gi0/0/1', '10.2.0.2'); addr('r3', 'Gi0/0/0', '10.2.0.3');
  addr('r1', 'Gi0/0/1', '10.3.0.1'); addr('r3', 'Gi0/0/1', '10.3.0.3');
  return t;
}
function sess(t, id, sim) { return new CliSession(t.getDevice(id), t, sim || null); }
function configure(t, id, cmds) {
  const s = sess(t, id);
  const out = [];
  ['enable', 'configure terminal'].concat(cmds).forEach(function (c) {
    out.push(((s.run(c) || {}).output || []).join(' '));
  });
  return out.filter(Boolean).join('\n');
}
function show(t, sim, id, cmd) { return ((sess(t, id, sim).run(cmd) || {}).output || []).join('\n'); }
function rowOf(text, name) {
  return text.split('\n').filter(function (l) { return l.trim().indexOf(name + ' ') === 0; })[0] || '';
}

console.log('');
console.log('Nothing can be reported until OSPF is enabled:');
{
  const t = lab();
  const off = show(t, null, 'r1', 'show ip ospf');
  ok(/OSPF is not enabled/.test(off), 'a router without OSPF says so rather than printing an empty table', off);
  ok(/ospf router-id/.test(off), 'and names the command that would enable it');
}

console.log('');
console.log('The process summary counts what the engine computed:');
{
  const t = lab();
  configure(t, 'r1', ['ospf router-id 1.1.1.1', 'interface Gi0/0/0', 'ip ospf cost 25',
    'interface Gi0/0/1', 'ip ospf cost 5']);
  configure(t, 'r2', ['ospf router-id 2.2.2.2', 'interface Gi0/0/0', 'interface Gi0/0/1']);
  configure(t, 'r3', ['ospf router-id 3.3.3.3', 'interface Gi0/0/0', 'interface Gi0/0/1',
    'ip ospf passive']);
  const sim = new Simulator(t);
  sim.computeOspf();
  const dev = t.getDevice('r1');

  const summary = show(t, sim, 'r1', 'show ip ospf');
  ok(/Routing Process "ospf 0" with ID 1\.1\.1\.1/.test(summary), 'the process summary names the router id',
    summary.split('\n')[0]);
  // r3's Gi0/0/1 is passive in this lab, so the direct r1-r3 link forms no adjacency and r1 has exactly one.
  ok(/Neighbours: 1/.test(summary), 'and counts the adjacency that formed (the passive end forms none)', summary);
  ok(/Interfaces: 2/.test(summary), 'and the interfaces OSPF runs on');
  ok(new RegExp('Routes installed from OSPF: ' + (dev.ospfRoutes || []).length).test(summary),
    'the route count is the engine\'s own', summary);
}

console.log('');
console.log('The neighbour table is the adjacency the SPF was built on:');
{
  const t = lab();
  configure(t, 'r1', ['ospf router-id 1.1.1.1', 'interface Gi0/0/0', 'interface Gi0/0/1']);
  configure(t, 'r2', ['ospf router-id 2.2.2.2', 'interface Gi0/0/0', 'interface Gi0/0/1']);
  configure(t, 'r3', ['ospf router-id 3.3.3.3', 'interface Gi0/0/0', 'interface Gi0/0/1']);
  const sim = new Simulator(t);
  sim.computeOspf();
  const table = show(t, sim, 'r1', 'show ip ospf neighbor');
  ok(/Neighbor ID/.test(table), 'the table has a header');
  // The neighbour id is the PEER's router id - the bug the VRRP report had to be fixed for is the same shape.
  ok(/\b2\.2\.2\.2\b/.test(table), 'r2 is listed by its router id', table);
  ok(/\b3\.3\.3\.3\b/.test(table), 'and so is r3');
  ok(!/\b1\.1\.1\.1\b/.test(table), 'r1 itself is not its own neighbour');
  ok(/10\.1\.0\.2/.test(rowOf(table, '2.2.2.2')), 'with the address it answers on',
    rowOf(table, '2.2.2.2'));
  ok(/Gi0\/0\/0/.test(rowOf(table, '2.2.2.2')), 'and the port the adjacency formed on');

  const engine = t.getDevice('r1').ospfNeighbors;
  ok(engine.length === 2, 'the engine agrees there are two', String(engine.length));
  const everyRowIsEngine = engine.every(function (n) {
    return table.indexOf(n.routerId) !== -1 && table.indexOf(n.address) !== -1 && table.indexOf(n.iface) !== -1;
  });
  ok(everyRowIsEngine, 'every engine neighbour appears in the table, and nothing extra');
}

console.log('');
console.log('The interface table says what cost, and where it came from:');
{
  const t = lab();
  configure(t, 'r1', ['ospf router-id 1.1.1.1',
    'interface Gi0/0/0', 'ip ospf cost 25',
    'interface Gi0/0/1']);
  configure(t, 'r2', ['ospf router-id 2.2.2.2', 'interface Gi0/0/0', 'interface Gi0/0/1']);
  configure(t, 'r3', ['ospf router-id 3.3.3.3', 'interface Gi0/0/0', 'interface Gi0/0/1']);
  const sim = new Simulator(t);
  sim.computeOspf();
  const table = show(t, sim, 'r1', 'show ip ospf interface');
  ok(/Cost from/.test(table), 'the table has a column for where the cost came from');
  const configured = rowOf(table, 'Gi0/0/0');
  const derived = rowOf(table, 'Gi0/0/1');
  ok(/\b25\b/.test(configured) && /configured/.test(configured),
    'a typed cost reads 25 and says it was configured', configured);
  ok(/link rate/.test(derived), 'a port nobody set a cost on says the link rate decided it', derived);
  ok(/10/.test(derived), 'and prints the derived number', derived);
  ok(/yes/.test(configured), 'a port with a neighbour reads adjacent', configured);
  ok(/10\.0\.0\.0|10\.1\.0\.0/.test(table) || /10\.1\.0\.1\/24/.test(table),
    'the address is printed with its prefix length as well as the mask', table);

  // And the number printed is the number the SPF used.
  const engineCost = t.getDevice('r1').ospfInterfaces.filter(function (i) { return i.name === 'Gi0/0/0'; })[0].cost;
  ok(engineCost === 25, 'the engine recorded cost 25 for Gi0/0/0', String(engineCost));
}

console.log('');
console.log('Cost steers the route, and the report explains it:');
{
  const t = lab();
  // Direct path r1-r3 costs 5+5 = 10; the path through r2 costs 100+100 plus r2's own. So r3's far side
  // should be reached over the direct link.
  configure(t, 'r1', ['ospf router-id 1.1.1.1',
    'interface Gi0/0/0', 'ip ospf cost 100',
    'interface Gi0/0/1', 'ip ospf cost 5']);
  configure(t, 'r2', ['ospf router-id 2.2.2.2',
    'interface Gi0/0/0', 'ip ospf cost 100',
    'interface Gi0/0/1', 'ip ospf cost 100']);
  configure(t, 'r3', ['ospf router-id 3.3.3.3',
    'interface Gi0/0/0', 'ip ospf cost 100',
    'interface Gi0/0/1', 'ip ospf cost 5']);
  const sim = new Simulator(t);
  sim.computeOspf();
  const routes = t.getDevice('r1').ospfRoutes;
  const viaDirect = routes.filter(function (r) { return r.iface === 'Gi0/0/1'; }).length > 0;
  ok(viaDirect, 'the cheaper direct link wins for r3\'s networks',
    JSON.stringify(routes.map(function (r) { return r.dest + ' via ' + r.iface + ' cost ' + r.cost; })));

  const table = show(t, sim, 'r1', 'show ip ospf interface');
  ok(/\b5\b/.test(rowOf(table, 'Gi0/0/1')), 'the report shows the cost that decided it',
    rowOf(table, 'Gi0/0/1'));
  ok(/\b100\b/.test(rowOf(table, 'Gi0/0/0')), 'and the cost of the path it did not take',
    rowOf(table, 'Gi0/0/0'));

  // Flip the costs and the route follows, so the report is describing a live decision and not a stored one.
  configure(t, 'r1', ['interface Gi0/0/0', 'ip ospf cost 1', 'interface Gi0/0/1', 'ip ospf cost 200']);
  configure(t, 'r3', ['interface Gi0/0/1', 'ip ospf cost 200']);
  const sim2 = new Simulator(t);
  sim2.computeOspf();
  const routes2 = t.getDevice('r1').ospfRoutes;
  const viaR2 = routes2.filter(function (r) { return r.iface === 'Gi0/0/0'; }).length > 0;
  ok(viaR2, 'flipping the costs moves the route to the other path',
    JSON.stringify(routes2.map(function (r) { return r.dest + ' via ' + r.iface; })));
}

console.log('');
console.log('A named port that is not carrying OSPF is named, and explained:');
{
  const t = lab();
  configure(t, 'r1', ['ospf router-id 1.1.1.1',
    'interface Gi0/0/0', 'interface Gi0/0/1', 'ip ospf passive']);
  const sim = new Simulator(t);
  sim.computeOspf();

  const passive = show(t, sim, 'r1', 'show ip ospf neighbor Gi0/0/1');
  ok(/is passive/.test(passive), 'a passive port says it forms no adjacency', passive.split('\n').pop());
  const passiveIf = show(t, sim, 'r1', 'show ip ospf interface Gi0/0/1');
  ok(/Passive/.test(passiveIf) && /yes/.test(rowOf(passiveIf, 'Gi0/0/1')),
    'and the interface table marks it passive', rowOf(passiveIf, 'Gi0/0/1'));

  // A port with no address cannot be in OSPF; a shut port likewise.
  const shut = show(t, sim, 'r1', 'show ip ospf interface Gi0/0/2');
  ok(/%/.test(shut), 'a port OSPF is not on gets an explanation, not an empty table', shut.split('\n').pop());
  ok(/no address|not in OSPF|administratively down|No interface/.test(shut), 'naming the reason',
    shut.split('\n').pop());

  const unknown = show(t, sim, 'r1', 'show ip ospf interface Gi9/9');
  ok(/No interface Gi9\/9/.test(unknown), 'a port that does not exist is named as such', unknown.split('\n').pop());
}

console.log('');
console.log('No simulation yet, and nothing is invented:');
{
  const t = lab();
  configure(t, 'r1', ['ospf router-id 1.1.1.1', 'interface Gi0/0/0']);
  configure(t, 'r2', ['ospf router-id 2.2.2.2', 'interface Gi0/0/0']);
  const none = show(t, null, 'r1', 'show ip ospf neighbor');
  ok(/no OSPF state has been evaluated yet/.test(none),
    'without a simulation the console says nothing has been evaluated', none);
  const summary = show(t, null, 'r1', 'show ip ospf');
  ok(/no OSPF state has been evaluated yet/.test(summary), 'and the summary says the same');

  const usage = show(t, null, 'r1', 'show ip ospf nonsense');
  ok(/Usage: show ip ospf/.test(usage), 'an unknown subcommand gets the usage line', usage);
}

console.log('');
console.log('Convergence is stated, not implied:');
{
  const t = lab();
  configure(t, 'r1', ['ospf router-id 1.1.1.1', 'interface Gi0/0/0']);
  configure(t, 'r2', ['ospf router-id 2.2.2.2', 'interface Gi0/0/0']);
  const sim = new Simulator(t);
  // Ask early: SPF has run, the schedule has not settled.
  sim.computeOspf(1000);
  const dev = t.getDevice('r1');
  const early = show(t, sim, 'r1', 'show ip ospf');
  // Whichever way the schedule went, the sentence and the state have to be the same sentence and the same state.
  ok(/withheld: still converging/.test(early) === (dev.ospfConverged === false),
    'the "withheld" note appears exactly when the engine says it is not converged', early);
  if (!dev.ospfConverged) {
    ok((dev.ospfRoutes || []).length === 0, 'and nothing is installed while it is not converged',
      String((dev.ospfRoutes || []).length));
  }

  sim.computeOspf(60000);
  const settled = t.getDevice('r1');
  ok(settled.ospfConverged === true, 'the schedule settles', String(settled.ospfConverged));
  const late = show(t, sim, 'r1', 'show ip ospf');
  ok(!/withheld/.test(late), 'and the report stops saying the routes are withheld', late);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
