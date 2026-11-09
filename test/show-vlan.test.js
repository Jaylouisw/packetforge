'use strict';
// `show vlan` printed two tables under one header, and one of them was nonsense (#1261).
//
// A trunk with `allowedVlans: 'all'` was pushed into VLAN 1 under a pseudo-key `all`, which was then
// *rendered* as VLAN 1 — so VLAN 1 appeared twice with identical ports, and a trunk carrying every VLAN
// was reported as a member of VLAN 1 and of nothing else. Every other row carried `(n)`/`(t)`/`(trunk)`
// decorations that real `show vlan` does not print and that disagreed with what the switch forwarded.
//
// Membership is now decided by `classifyEgress()` — the rule the data plane uses — so the table cannot
// list a port the switch would drop for, or omit one it would forward to.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const vlanLib = require('../engine/vlan');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];

function rows(env, cmd) {
  const lines = ((new CliSession(env.sw, env.t, env.sim).run(cmd || 'show vlan').output) || []).map(String);
  const body = lines.slice(1).filter(function (l) { return l.trim(); });
  return {
    header: lines[0] || '',
    lines: lines,
    body: body,
    fields: body.map(function (l) {
      // Ports are the last column and may be a long comma-separated list, so split on the first
      // whitespace groups and keep the remainder whole.
      const m = l.match(/^(\S+)\s+(.{33})\s+(\S+)\s*(.*)$/);
      return m ? { vlan: m[1], name: m[2].trim(), status: m[3], ports: m[4].trim() } : { raw: l };
    })
  };
}

// sw with: Fa0/1 access VLAN 20, Fa0/2 trunk allowed 20,30, Fa0/3 trunk (all), rest default access 1
function lab() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const other = t.addDevice(SWITCH, 'sw2');
  const pc = t.addDevice(PC, 'pc');
  t.connect('pc', 'eth0', 'sw', 'Fa0/1');
  t.connect('sw', 'Fa0/2', 'sw2', 'Fa0/1');
  const sim = new Simulator(t);
  runCommands(sw, t, sim, ['configure terminal',
    'vlan 20 twenty', 'vlan 30 thirty',
    'interface Fa0/1', 'switchport access vlan 20',
    'interface Fa0/2', 'switchport mode trunk', 'switchport trunk allowed vlan 20,30',
    'interface Fa0/3', 'switchport mode trunk',
    'end']);
  return { t: t, sim: sim, sw: sw, other: other, pc: pc };
}

console.log('');
console.log('One row per VLAN, not two:');
{
  const env = lab();
  const out = rows(env);
  ok(/VLAN/.test(out.header) && /Name/.test(out.header) && /Ports/.test(out.header),
    'the header names the columns', out.header);
  const ones = out.fields.filter(function (f) { return f.vlan === '1'; });
  ok(ones.length === 1, 'VLAN 1 appears exactly once - the old table printed it twice', String(ones.length));
  ok(out.fields.every(function (f) { return f.vlan && f.name; }),
    'every row parses into VLAN, Name, Status, Ports', JSON.stringify(out.fields));
  const ids = out.fields.map(function (f) { return Number(f.vlan); });
  ok(JSON.stringify(ids) === JSON.stringify(ids.slice().sort(function (a, b) { return a - b; })),
    'rows are in VLAN order', ids.join(','));
  ok(out.body.every(function (l) { return !/\((n|t|trunk)\)/.test(l); }),
    'and none of them carries the (n)/(t)/(trunk) decorations that disagreed with the data plane',
    out.body.join(' | '));
}

console.log('');
console.log('Membership is what the switch would actually forward to:');
{
  const env = lab();
  const out = rows(env);
  const rowFor = function (id) {
    return out.fields.filter(function (f) { return Number(f.vlan) === id; })[0] || { ports: '' };
  };
  const listed = function (id, port) {
    return rowFor(id).ports.split(',').map(function (s) { return s.trim(); }).indexOf(port) !== -1;
  };

  ok(listed(20, 'Fa0/1'), 'an access port is in its access VLAN', rowFor(20).ports);
  ok(!listed(1, 'Fa0/1'), 'and not in VLAN 1 any more', rowFor(1).ports);
  ok(listed(20, 'Fa0/2') && listed(30, 'Fa0/2'),
    'a trunk is in both VLANs its allowed list names', rowFor(20).ports + ' / ' + rowFor(30).ports);
  ok(!listed(1, 'Fa0/2'),
    'and NOT in VLAN 1, which its allowed list excludes - a trunk is not "in VLAN 1" by default',
    rowFor(1).ports);
  ok(listed(1, 'Fa0/3') && listed(20, 'Fa0/3') && listed(30, 'Fa0/3'),
    'a trunk carrying all VLANs is in every row, which the old table got wrong',
    rowFor(1).ports + ' / ' + rowFor(20).ports);

  // The load-bearing one: for every port and every VLAN, listed <=> the egress rule forwards it.
  let disagreements = [];
  for (const id of out.fields.map(function (f) { return Number(f.vlan); })) {
    for (const iface of env.sw.interfaces.values()) {
      const carries = vlanLib.classifyEgress(iface.vlan, id).action !== 'drop';
      if (carries !== listed(id, iface.name)) {
        disagreements.push(iface.name + ' in VLAN ' + id + ': table=' + listed(id, iface.name) +
          ' data plane=' + carries);
      }
    }
  }
  ok(disagreements.length === 0, 'the table and the data plane agree for every port and VLAN',
    disagreements.join(' | '));
}

console.log('');
console.log('Names are the configured ones, and a VLAN with no name says so honestly:');
{
  const env = lab();
  const out = rows(env);
  const nameOf = function (id) {
    const r = out.fields.filter(function (f) { return Number(f.vlan) === id; })[0];
    return r ? r.name : null;
  };
  ok(nameOf(20) === 'twenty' && nameOf(30) === 'thirty',
    'configured names are printed', String(nameOf(20)) + '/' + String(nameOf(30)));
  ok(nameOf(1) === 'default', 'VLAN 1 is "default"', String(nameOf(1)));

  runCommands(env.sw, env.t, env.sim, ['configure terminal', 'interface Fa0/4',
    'switchport access vlan 44', 'end']);
  const after = rows(env);
  const r44 = after.fields.filter(function (f) { return f.vlan === '44'; })[0];
  ok(!!r44, 'a VLAN that exists only because a port uses it gets a row', JSON.stringify(after.fields.map(function (f) { return f.vlan; })));
  ok(r44 && r44.name === 'VLAN0044', 'with the generated name, not an invented one', r44 && r44.name);
  // The all-VLAN trunk carries VLAN 44 too, so it is a member as well - the row is the access port that
  // created the VLAN plus that trunk, and nothing else.
  ok(r44 && r44.ports === 'Fa0/3, Fa0/4',
    'and the ports that really carry it: the access port, plus the trunk that carries every VLAN',
    r44 && r44.ports);
}

console.log('');
console.log('The table follows the port when it moves:');
{
  const env = lab();
  runCommands(env.sw, env.t, env.sim, ['configure terminal', 'interface Fa0/1',
    'switchport access vlan 30', 'end']);
  const out = rows(env);
  const ports = function (id) {
    const r = out.fields.filter(function (f) { return Number(f.vlan) === id; })[0];
    return r ? r.ports.split(',').map(function (s) { return s.trim(); }) : [];
  };
  ok(ports(20).indexOf('Fa0/1') === -1, 'the port leaves the VLAN it left', ports(20).join(','));
  ok(ports(30).indexOf('Fa0/1') !== -1, 'and appears in the one it joined', ports(30).join(','));
  ok(ports(20).indexOf('Fa0/2') !== -1 && ports(20).indexOf('Fa0/3') !== -1,
    'while the trunks in VLAN 20 stay', ports(20).join(','));
}

console.log('');
console.log('`show vlan brief` is the same answer, and an empty VLAN says nothing rather than everything:');
{
  const env = lab();
  const brief = rows(env, 'show vlan brief');
  const full = rows(env, 'show vlan');
  ok(JSON.stringify(brief.fields) === JSON.stringify(full.fields),
    'brief and the full form agree row for row');
  runCommands(env.sw, env.t, env.sim, ['configure terminal', 'vlan 99 ninetynine', 'end']);
  const with99 = rows(env).fields.filter(function (f) { return f.vlan === '99'; })[0];
  // Nothing is *configured* into VLAN 99, so the only ports that carry it are the trunks that carry
  // everything - and no access port is invented for it.
  ok(!!with99, 'a VLAN created by config but used by no access port still gets a row', JSON.stringify(with99));
  const accessIn99 = with99.ports.split(',').map(function (s) { return s.trim(); }).filter(function (name) {
    const iface = env.sw.interfaces.get(name);
    return iface && iface.vlan.mode !== 'trunk';
  });
  ok(accessIn99.length === 0, 'with no access port invented into it', accessIn99.join(','));
}

console.log('');
console.log('`show spanning-tree` distinguishes "no loop" from "nothing has looked":');
{
  const env = lab();
  const noRun = ((new CliSession(env.sw, env.t, null).run('show spanning-tree').output) || [])
    .map(String).join('\n');
  ok(/Not measured \(no simulation run\)/.test(noRun),
    'with no run it says nothing has computed the tree, rather than claiming a loop-free device',
    noRun);
  ok(!/not part of any L2 loop/.test(noRun), 'and does not make the claim it cannot support', noRun);

  env.sim.ping('pc', '10.0.0.1', { count: 1 });
  const ran = ((new CliSession(env.sw, env.t, env.sim).run('show spanning-tree').output) || [])
    .map(String).join('\n');
  ok(!/Not measured/.test(ran), 'after a run it reports what it computed', ran);
  ok(/Port\s+Role\s+State/.test(ran), 'with the per-port table', ran);
}

console.log('');
console.log('A blocking port is reported as blocking, and its frames are really dropped:');
{
  const t = new Topology();
  const s1 = t.addDevice(SWITCH, 's1');
  const s2 = t.addDevice(SWITCH, 's2');
  t.connect('s1', 'Fa0/1', 's2', 'Fa0/1');
  t.connect('s1', 'Fa0/2', 's2', 'Fa0/2');            // a loop
  const sim = new Simulator(t);
  sim.ping('s1', '10.0.0.1', { count: 1 });
  const tables = [s1, s2].map(function (d) {
    return ((new CliSession(d, t, sim).run('show spanning-tree').output) || []).map(String).join('\n');
  }).join('\n');
  const blocking = /blocking/.test(tables);
  ok(blocking, 'one of the two switches reports a blocking port for the loop', tables);
  const blockedPorts = [s1, s2].some(function (d) {
    return d.stp && d.stp.states && Object.keys(d.stp.states).some(function (p) { return d.stp.states[p] === 'blocking'; });
  });
  ok(blockedPorts, 'and the device model has the same port blocked, so the table is not decoration');
  ok(/traffic dropped/.test(tables), 'the row says what blocking means for traffic', tables);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
