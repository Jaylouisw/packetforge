'use strict';
// What `show vlan` lists, and what it must not: access ports only, out of the switch's VLAN database.
//
// An earlier pass (#1261) fixed a genuinely broken table - VLAN 1 printed twice, `(n)`/`(t)`/`(trunk)`
// decorations a device never prints - by deciding membership with `classifyEgress()`, the data plane's
// rule. That is the right rule for forwarding and the wrong rule for this table: a trunk forwards every
// VLAN it carries and appears in no row of `show vlan`.
//
// The vendor's command reference states it for the form this console prints - one line per VLAN for the
// whole database: "When displaying multiple VLANs only non-trunk ports are displayed" (Cisco IOS LAN
// Switching Command Reference, `show vlan`, lsw-cr-book/lsw-s2.html), and `show vlan all-ports` exists
// only because the default view leaves trunks out. The table is the VLAN database: a VLAN that only a
// trunk's allowed list names was never created and gets no row. Evidence and the one contradiction
// (unconnected trunks, single-vendor field report) are in research/vlan-brief-trunk-ports.md.
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

// A Ports list longer than its 32-column window continues on the next line, indented back to column 48, and the
// break carries no comma - that is how a box prints it (research/show-vlan-columns.md). A row is therefore one or
// more printed lines; the joiner here is ", " so that a caller splitting on commas still sees two ports.
function fold(body) {
  const out = [];
  for (const l of body) {
    const continuation = !l.slice(0, 4).trim() && !l.slice(5, 37).trim() && !l.slice(38, 47).trim();
    if (continuation && out.length) out[out.length - 1] += ', ' + l.slice(48).trim();
    else out.push(l);
  }
  return out;
}

function rows(env, cmd) {
  const lines = ((new CliSession(env.sw, env.t, env.sim).run(cmd || 'show vlan').output) || []).map(String);
  // Row 0 is the header and row 1 is the rule line the device draws under it (`---- ---- ----- -----`),
  // so the rows start at 2. The rule is skipped by its shape rather than by its index, so a table whose
  // header grew a line cannot silently parse the rule as a VLAN.
  const body = lines.slice(1).filter(function (l) { return l.trim() && !/^-{4}/.test(l); });
  return {
    header: lines[0] || '',
    lines: lines,
    body: body,
    // Read by the column positions the device prints in (`VLAN` 4 wide, `Name` 32, `Status` 9, Ports from
    // column 48), not by whitespace runs: a four-character id leaves a single space before the name, and a
    // 32-character name leaves a single space before the status, so a regex that needs two spaces fails on
    // exactly the rows the table is supposed to align.
    fields: fold(body).map(function (l) {
      return {
        vlan: l.slice(0, 4).trim(),
        name: l.slice(5, 37).trim(),
        status: l.slice(38, 47).trim(),
        ports: l.slice(48).trim()
      };
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
console.log('Membership is access membership, and a trunk is in no row:');
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
  ok(!listed(20, 'Fa0/2') && !listed(30, 'Fa0/2') && !listed(1, 'Fa0/2'),
    'a trunk is in no row at all, though its allowed list names 20 and 30',
    rowFor(1).ports + ' / ' + rowFor(20).ports + ' / ' + rowFor(30).ports);
  ok(!listed(1, 'Fa0/3') && !listed(20, 'Fa0/3') && !listed(30, 'Fa0/3'),
    'nor is a trunk that allows every VLAN', rowFor(1).ports + ' / ' + rowFor(20).ports);
  ok(listed(1, 'Fa0/4'), 'the untouched default access ports stay in VLAN 1', rowFor(1).ports);

  // The load-bearing one: listed <=> this is an access port that belongs to the VLAN. The data plane's
  // answer is deliberately not the test - a trunk carrying the VLAN is exactly the case they disagree on.
  let disagreements = [];
  for (const id of out.fields.map(function (f) { return Number(f.vlan); })) {
    for (const iface of env.sw.interfaces.values()) {
      const access = !(iface.vlan && iface.vlan.mode === 'trunk');
      const belongs = access && vlanLib.classifyEgress(iface.vlan, id).action !== 'drop';
      if (belongs !== listed(id, iface.name)) {
        disagreements.push(iface.name + ' in VLAN ' + id + ': table=' + listed(id, iface.name) +
          ' access membership=' + belongs);
      }
    }
  }
  ok(disagreements.length === 0, 'every row lists exactly the access ports that belong to that VLAN',
    disagreements.join(' | '));
}

console.log('');
console.log('The row set is the VLAN database, not the VLANs a trunk mentions:');
{
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const other = t.addDevice(SWITCH, 'sw2');
  t.connect('sw', 'Fa0/2', 'sw2', 'Fa0/1');
  const sim = new Simulator(t);
  runCommands(sw, t, sim, ['configure terminal', 'interface Fa0/2',
    'switchport mode trunk', 'switchport trunk allowed vlan 20,30', 'end']);
  const out = rows({ t: t, sim: sim, sw: sw });
  const ids = out.fields.map(function (f) { return Number(f.vlan); });
  ok(ids.indexOf(20) === -1 && ids.indexOf(30) === -1,
    'a trunk that allows VLANs nobody created puts no row in the table - they do not exist',
    ids.join(','));
  ok(ids.indexOf(1) !== -1, 'while VLAN 1, which does exist, is still there', ids.join(','));
  const one = out.fields.filter(function (f) { return f.vlan === '1'; })[0];
  ok(one && one.ports === 'Fa0/1, Fa0/3, Fa0/4, Fa0/5, Fa0/6, Fa0/7, Fa0/8',
    "and the trunk is gone from VLAN 1's Ports cell", one && one.ports);
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
  // The all-VLAN trunk carries VLAN 44, and that is not a membership: the row is the access port alone.
  ok(r44 && r44.ports === 'Fa0/4',
    'and the only port in it is the access port that put it there, not the trunk that carries it',
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
  ok(ports(20).filter(Boolean).length === 0 && ports(30).join(',') === 'Fa0/1',
    'and the trunks that carry those VLANs are still in neither row',
    ports(20).join(',') + ' / ' + ports(30).join(','));
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
  // Nothing is *configured* into VLAN 99, so no port is a member of it - not even the trunk that
  // carries every VLAN, which is precisely the port the old rule would have invented here.
  ok(!!with99, 'a VLAN created by config but used by no access port still gets a row', JSON.stringify(with99));
  ok(with99.ports === '', 'with an empty Ports cell, because a trunk is not an access member', with99.ports);
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
