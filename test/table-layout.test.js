'use strict';
// table-layout.test.js — operator output must not glue columns, and must not print
// internal ids.
//
// Both defects came from fixed-width columns meeting text an operator controls. A
// device called "branch-office-edge-router-01" is 29 characters, and every table that
// printed it with `pad(name, 12)` ran the next column straight on: `Master` into the
// virtual IP, `Device` into `Bytes in`, a neighbour's name into its port. `show arp`
// had the opposite problem - an `Interface` column in the header that no row filled -
// and `show interfaces` printed `peer: d1/eth0`, a device id nobody outside the engine
// has ever seen.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) +
    ', want ' + JSON.stringify(expected) + ')'));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function model(name) { return catalog.find(function (x) { return x.model === name; }); }

const LONG = 'branch-office-edge-router-01';          // 29 characters
const PCNAME = 'workstation-in-the-dmz-07';           // 25
const SRVNAME = 'web-frontend-cluster-09';            // 23
const R2NAME = 'core-distribution-switch-02';         // 27

const t = new Topology();
const pc = t.addDevice(model('generic-pc'));
const r1 = t.addDevice(model('generic-router'));
const r2 = t.addDevice(model('generic-router'));
const srv = t.addDevice(model('generic-server'));
pc.name = PCNAME; r1.name = LONG; r2.name = R2NAME; srv.name = SRVNAME;
t.connect(pc.id, 'eth0', r1.id, 'Gi0/0');
t.connect(r1.id, 'Gi0/1', r2.id, 'Gi0/1');
t.connect(r2.id, 'Gi0/0', srv.id, 'eth0');
const sim = new Simulator(t);
function run(dev, cmds) { return runCommands(dev, t, sim, cmds).lines; }
function show(dev, cmd) {
  return run(dev, ['enable', cmd]).filter(function (l) {
    return !/^[A-Za-z0-9._()\/-]*[>#]/.test(l);
  });
}

run(pc, ['configure terminal', 'interface eth0', 'ip address 10.0.1.10 255.255.255.0',
  'exit', 'ip default-gateway 10.0.1.1', 'hostname ' + PCNAME]);
run(r1, ['configure terminal', 'interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0',
  'vrrp 1 ip 10.0.1.100', 'vrrp 1 priority 200', 'exit',
  'interface Gi0/1', 'ip address 10.0.12.1 255.255.255.0', 'exit',
  'ospf router-id 1.1.1.1', 'ospf area 0', 'hostname ' + LONG]);
run(r2, ['configure terminal', 'interface Gi0/1', 'ip address 10.0.12.2 255.255.255.0', 'exit',
  'interface Gi0/0', 'ip address 10.0.2.1 255.255.255.0', 'exit',
  'ospf router-id 2.2.2.2', 'ospf area 0', 'hostname ' + R2NAME]);
run(srv, ['configure terminal', 'interface eth0', 'ip address 10.0.2.20 255.255.255.0',
  'exit', 'ip default-gateway 10.0.2.1', 'hostname ' + SRVNAME]);

sim.ping(pc.id, '10.0.2.20', { count: 1 });
sim.openFlow({ proto: 'tcp', srcDevice: pc.id, dstDevice: srv.id, dstPort: 80, bytes: 500 });

// A column boundary is glued when a value runs into the next one with no space at all.
// Every table here ends a cell with "]" or a digit or a dotted/hex token, so the check
// is: no hex-pair or digit immediately followed by a capital letter or "/" that starts
// the next cell, and no "ms" followed by a digit (the converging-table case).
function gluedLines(lines) {
  return lines.filter(function (l) {
    return /\d[A-Z]/.test(l) && !/^\s*\d+\.\s/.test(l) ||
           /ms\d/.test(l) ||
           /[0-9a-f]{2}:[0-9a-f]{2}[A-Za-z]/.test(l);
  });
}

console.log('Long hostnames do not run into the next column:');
{
  const checks = [
    ['show vrrp', function (l) { return /^Gi0\/0/.test(l.trim()); }],
    ['show lldp neighbors', function (l) { return /workstation|core-dist/.test(l); }],
    ['show flows counters', function (l) { return /workstation|branch|core|web/.test(l); }],
    ['show arp', function (l) { return /^Internet/.test(l.trim()); }],
    ['converge', function (l) { return /^vrrp|^ospf|^stp/.test(l.trim()); }]
  ];
  for (const [command, pick] of checks) {
    const rows = show(r1, command).filter(pick);
    ok(rows.length > 0, command + ': there is a row to check');
    const bad = gluedLines(rows);
    ok(bad.length === 0, command + ': no cell runs into the next one' +
      (bad.length ? ' - ' + JSON.stringify(bad[0]) : ''));
  }
}

console.log('\nThe vrrp Master column is as wide as the name it prints:');
{
  const lines = show(r1, 'show vrrp');
  const row = lines.filter(function (l) { return /^Gi0\/0/.test(l.trim()); })[0];
  ok(row.indexOf(LONG) !== -1, 'the hostname is printed in full');
  ok(/branch-office-edge-router-01\s+10\.0\.1\.100/.test(row),
    'and at least one space separates it from the virtual IP');
}

console.log('\nThe lldp neighbour column is measured from the announcement:');
{
  const lines = show(r1, 'show lldp neighbors');
  const row = lines.filter(function (l) { return l.indexOf(PCNAME) !== -1; })[0];
  ok(!!row, 'the neighbour is listed');
  ok(new RegExp(PCNAME + '\\s+Gi0/0').test(row), 'its name does not touch the local port');
}

console.log('\nThe convergence table measures its own columns:');
{
  const lines = show(r1, 'converge');
  const header = lines[0];
  const rows = lines.slice(1).filter(function (l) { return /^\S/.test(l) && l.indexOf('Fully') === -1; });
  ok(/^Process\s+Device\s+Ready\s+Basis$/.test(header), 'the header columns are separated by spaces');
  const bad = rows.filter(function (l) { return /ms\d/.test(l); });
  ok(bad.length === 0, 'a decimal ready time ("3218.75 ms") keeps a space before its basis');
  ok(/branch-office-edge-router-01\s+3218\.75 ms/.test(lines.join('\n')),
    'and a long device name keeps a space before its ready time');
}

console.log('\nshow arp fills the Interface column it advertises:');
{
  const lines = show(r1, 'show arp');
  // The header gained a Type column: STATIC used to be appended inside the Interface cell, which
  // pushed that column out of line with its own header. The rule this block is about is unchanged -
  // the Interface column is filled, with a port - so the shape it checks moved by one column.
  ok(/\bInterface\b\s+Type$/.test(lines[0]), 'the header ends with Interface and Type');
  const rows = lines.slice(1).filter(function (l) { return /^Internet/.test(l); });
  ok(rows.length > 0, 'there are ARP entries after a ping');
  for (const row of rows) {
    const cells = row.trim().split(/\s+/);
    eq(cells.length, 6, 'every row carries six cells: ' + JSON.stringify(cells));
    ok(/^(Gi\d\/\d|eth\d|-|\(self\))$/.test(cells[4]), 'the Interface cell is a port, not nothing: ' + cells[4]);
    ok(/^(STATIC|DYNAMIC)$/.test(cells[5]), 'and the Type cell says which kind: ' + cells[5]);
  }
  // The entry for the host must name the port the host is actually on.
  const host = rows.filter(function (l) { return l.indexOf('10.0.1.10') !== -1; })[0];
  ok(/\bGi0\/0\s+DYNAMIC$/.test(host), 'the host 10.0.1.10 is reached through Gi0/0: ' + host.trim());
}

console.log('\nInternal ids never reach the operator:');
{
  const all = [];
  for (const command of ['show interfaces', 'show lldp neighbors', 'show arp', 'show flows',
    'show flows counters', 'show vrrp', 'converge', 'links', 'show ip route']) {
    all.push.apply(all, show(r1, command));
  }
  // Device ids look like d1, d12 - they only ever appear inside the engine.
  const leaks = all.filter(function (l) { return /\bd\d+\//.test(l); });
  ok(leaks.length === 0, 'no output contains a raw device id' +
    (leaks.length ? ' - ' + JSON.stringify(leaks[0]) : ''));

  const peer = show(r1, 'show interfaces').filter(function (l) { return /^\s+peer:/.test(l); });
  ok(peer.length > 0, 'show interfaces reports peers');
  ok(peer.some(function (l) { return l.indexOf(PCNAME + '/eth0') !== -1; }),
    'and names the device, not its id: ' + peer[0].trim());
}

console.log('\nThe renderer refuses to lose a column:');
{
  const { renderTable } = require('../engine/table');
  const lines = renderTable(['A', 'B'], [['1', '2']]);
  eq(lines.length, 2, 'a header and one row');
  eq(lines[0].trimEnd(), 'A  B', 'two columns, padded by measured width');

  ok((function () {
    try { renderTable(['A', 'B'], [['1', '2', '3']]); return false; }
    catch (e) { return /cells but the header has 2 columns/.test(e.message); }
  })(), 'a row with an extra cell throws instead of dropping it');

  ok((function () {
    try { renderTable(['A', 'B', 'C'], [['1']]); return true; }
    catch (e) { return false; }
  })(), 'a short row is padded, not refused');

  const short = renderTable(['A', 'B', 'C'], [['1']]);
  eq(short[1].trimEnd(), '1', 'and its missing cells leave no trailing spaces');
}

console.log('\nEvery table keeps its columns aligned to its own header:');
{
  // A generic sweep, not a list of hand-checked tables: for each table, the header's
  // column starts are measured once, and every row must start its cells at exactly
  // those offsets. A glued cell merges two cells into one, so the count drops and the
  // offsets shift - either way this fails. Adding a new table cannot skip the check.
  //
  // A second lab carries the feature-specific state a table needs to have rows at all
  // (VRRP groups, a DNS zone, a BGP session, an L2 loop with a LAG), because an empty
  // table proves nothing about alignment.
  const t2 = new Topology();
  const a1 = t2.addDevice(model('generic-switch'));
  const a2 = t2.addDevice(model('generic-switch'));
  const gw = t2.addDevice(model('generic-router'));
  a1.name = 'access-switch-with-a-long-name-01';
  a2.name = 'access-switch-with-a-long-name-02';
  gw.name = 'gateway-for-the-sweep-lab-0001';
  a1.config = a1.config || {};
  a1.config.vlans = { 1: { name: 'default' }, 20: { name: 'a-vlan-name-that-is-deliberately-long' } };
  // Two links between the switches is a loop, so spanning tree has something to block.
  t2.connect(a1.id, 'Fa0/1', a2.id, 'Fa0/1');
  t2.connect(a1.id, 'Fa0/2', a2.id, 'Fa0/2');
  t2.connect(a1.id, 'Fa0/3', gw.id, 'Gi0/0');
  const sim2 = new Simulator(t2);
  function run2(dev, cmds) { return runCommands(dev, t2, sim2, cmds).lines; }
  function show2(dev, cmd) {
    return run2(dev, ['enable', cmd]).filter(function (l) { return !/^[A-Za-z0-9._()\/-]*[>#]/.test(l); });
  }
  run2(a1, ['configure terminal', 'interface Fa0/1', 'channel-group 1 mode active', 'exit',
    'interface Fa0/2', 'channel-group 1 mode active', 'exit', 'vlan 20',
    'name a-vlan-name-that-is-deliberately-long', 'exit',
    'interface Fa0/3', 'switchport mode trunk', 'exit',
    'hostname access-switch-with-a-long-name-01']);
  // VRRP belongs to an interface, so it goes inside the interface block; a stray `exit`
  // here would drop out of config mode and the router-bgp lines after it would be refused.
  const gwConfig = run2(gw, ['configure terminal',
    'interface Gi0/0', 'ip address 10.9.9.1 255.255.255.0',
    'vrrp 5 ip 10.9.9.254', 'vrrp 5 priority 150', 'exit',
    'dns zone lab.test', 'dns add www.lab.test A 10.9.9.50',
    'hostname gateway-for-the-sweep-lab-0001']);
  const refused = gwConfig.filter(function (l) { return /^%/.test(l); });
  ok(refused.length === 0, 'the sweep lab config is accepted' +
    (refused.length ? ' - ' + refused[0] : ''));
  // The bgp table needs a peer that actually answers, so it uses the routed lab's two
  // routers (directly connected, already running OSPF). This runs after the assertions
  // above, so adding BGP here cannot change their results.
  run(r1, ['configure terminal', 'router bgp 65001',
    'neighbor 10.0.12.2 remote-as 65002', 'network 10.0.1.0 mask 255.255.255.0', 'exit']);
  run(r2, ['configure terminal', 'router bgp 65002',
    'neighbor 10.0.12.1 remote-as 65001', 'network 10.0.2.0 mask 255.255.255.0', 'exit']);
  sim.computeBgp();

  // A switch with no traffic has an empty MAC table, and an empty table proves nothing.
  sim2.ping(gw.id, '10.9.9.99', { count: 1 });
  sim2.computeStp();
  sim2.computeVrrp();
  sim2.computeBgp();

  // A fibre pair, so the transceiver table has real rows: two module bays with the
  // medium, reach and cable length filled in.
  const t3 = new Topology();
  const sfpModels = catalog.filter(function (d) {
    return (d.interfaces || []).some(function (i) { return String(i.connector || i.cage || '') === 'sfp+'; });
  });
  const f1 = t3.addDevice(sfpModels[0]);
  const f2 = t3.addDevice(sfpModels[1]);
  f1.name = 'fibre-switch-with-a-long-name-01';
  f2.name = 'fibre-switch-with-a-long-name-02';
  const fp1 = Array.from(f1.interfaces.values()).filter(function (i) { return i.hardware.cage === 'sfp+'; })[0];
  const fp2 = Array.from(f2.interfaces.values()).filter(function (i) { return i.hardware.cage === 'sfp+'; })[0];
  t3.connect(f1.id, fp1.name, f2.id, fp2.name, { lengthM: 1200 });
  const sim3 = new Simulator(t3);
  function show3(dev, cmd) {
    return runCommands(dev, t3, sim3, ['enable', cmd]).lines.filter(function (l) {
      return !/[>#](enable|show\b|$)/.test(l);
    });
  }

  // A NAT lab: the translation table only has rows after a run has translated something,
  // and it is the one table the CLI does not build itself - the rows come from nat.js.
  const t4 = new Topology();
  const npc = t4.addDevice(model('generic-pc'));
  const nr = t4.addDevice(model('generic-router'));
  const nsrv = t4.addDevice(model('generic-server'));
  npc.name = 'pc-inside-the-lab-with-a-long-name';
  nr.name = 'nat-border-router-with-a-long-name';
  nsrv.name = 'public-web-server-long-name-01';
  t4.connect(npc.id, 'eth0', nr.id, 'Gi0/0');
  t4.connect(nr.id, 'Gi0/1', nsrv.id, 'eth0');
  const sim4 = new Simulator(t4);
  const run4 = function (d, c) { return runCommands(d, t4, sim4, c).lines; };
  run4(npc, ['configure terminal', 'interface eth0', 'ip address 192.168.1.10 255.255.255.0',
    'exit', 'ip default-gateway 192.168.1.1']);
  run4(nr, ['configure terminal', 'interface Gi0/0', 'ip address 192.168.1.1 255.255.255.0',
    'exit', 'interface Gi0/1', 'ip address 203.0.113.1 255.255.255.0']);
  run4(nsrv, ['configure terminal', 'interface eth0', 'ip address 203.0.113.9 255.255.255.0',
    'exit', 'ip default-gateway 203.0.113.1']);
  nr.config.nat = { rules: [{ type: 'pat', insideLocal: '192.168.1.0/24', insideGlobal: '203.0.113.1' }] };
  // A ping is ICMP, and ICMP is never translated - the translation table only gets rows
  // from a conversation the flow model opened.
  sim4.openFlow({ proto: 'tcp', srcDevice: npc.id, dstDevice: nsrv.id, dstPort: 80, bytes: 500 });
  function show4(cmd) {
    return run4(nr, ['enable', cmd]).filter(function (l) {
      return !/[>#](enable|show\b|$)/.test(l);
    });
  }

  const tables = [
    ['links', 'Link'],
    ['show ip interface brief', 'Interface'],
    ['show vlan', 'VLAN'],
    ['show spanning-tree', 'Port'],
    ['show etherchannel', 'Group'],
    ['show arp', 'Protocol'],
    ['show mac address-table', 'Vlan'],
    ['show ip ospf neighbor', 'Neighbor ID'],
    ['show vrrp', 'Interface'],
    ['show lldp neighbors', 'Neighbour'],
    ['show flows', 'Id'],
    ['show flows counters', 'Device'],
    ['show interfaces transceiver', 'Port'],
    ['show ip nat translations', 'Pro'],
    ['converge', 'Process'],
    ['traceroute 10.0.2.20', 'Hop'],
    ['show dns', 'Name'],
    // `show ip bgp` is the BGP table now; the neighbour summary keeps its own header. This lab has
    // no received prefixes, so the table itself is aligned-checked in test/bgp-table.test.js, where
    // there are rows to check.
    ['show ip bgp summary', 'Neighbor']
  ];
  let exercised = 0;
  for (const [command, headerStart] of tables) {
    // Each table is read from whichever lab can populate it.
    const WHERE = [
      [/spanning-tree|etherchannel|vlan|mac address-table/, function (c) { return show2(a1, c); }],
      [/vrrp|dns/, function (c) { return show2(gw, c); }],
      [/transceiver/, function (c) { return show3(f1, c); }],
      [/nat/, function (c) { return show4(c); }]
    ];
    const hand = (WHERE.filter(function (w) { return w[0].test(command); })[0] ||
      [null, function (c) { return show(r1, c); }])[1];
    const lines = hand(command);
    const at = lines.findIndex(function (l) { return l.trim().startsWith(headerStart); });
    ok(at !== -1, command + ': the table has a header starting with "' + headerStart + '"');
    if (at === -1) continue;
    exercised++;
    const header = lines[at];
    const cols = header.trimEnd().split(/\s{2,}/);
    const offsets = [];
    let cursor = 0;
    for (const c of cols) {
      const idx = header.indexOf(c, cursor);
      offsets.push(idx);
      cursor = idx + c.length;
    }
    ok(cols.length > 1, command + ': the header has more than one column');
    // A table's rows sit at exactly the header's indentation: anything shallower is a
    // summary line ("Name servers: ..."), anything deeper is a nested note.
    const headerIndent = header.match(/^\s*/)[0].length;
    const rows = [];
    for (let i = at + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) { if (rows.length) break; continue; }   // a blank line ends the table
      // Which lines belong to the table - ordinary control flow, not an exemption from
      // any check: a line at another indent is a summary or a nested note, and the
      // markers below are prose the table does not contain a column for.
      if ((line.match(/^\s*/)[0].length) !== headerIndent) continue;
      if (/^\s*(\(|%|Fully |Path:|\* )/.test(line)) continue;
      rows.push(line);
    }
    ok(rows.length > 0, command + ': there is at least one row to check');
    const bad = [];
    for (const row of rows) {
      // "(destination)" is a marker on the last cell, not a column of its own.
      const norm = row.replace(/\s{2,}\(destination\)$/, ' (destination)').trimEnd();
      const cells = norm.split(/\s{2,}/);
      if (cells.length !== cols.length) { bad.push('cell count ' + cells.length + ' != ' + cols.length + ': ' + JSON.stringify(row)); continue; }
      let c2 = 0;
      for (let c = 0; c < cells.length; c++) {
        const idx = norm.indexOf(cells[c], c2);
        if (idx !== offsets[c]) { bad.push('column ' + c + ' at ' + idx + ' not ' + offsets[c] + ': ' + JSON.stringify(row)); break; }
        c2 = idx + cells[c].length;
      }
    }
    ok(bad.length === 0, command + ': every row is aligned to the header' +
      (bad.length ? ' - ' + bad[0] : ''));
  }
  ok(exercised >= tables.length - 1, 'the sweep exercised ' + exercised + ' of ' + tables.length +
    ' tables (an unexercised table would silently pass)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
