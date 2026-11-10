'use strict';
// arp-attribution.test.js - the ARP table listed an address with no interface, and the port filter
// could not see it.
//
// After three successful pings from PC1 through SW1 to R1:
//
//   R1#show arp
//   Protocol  Address    Age (min)  Hardware Addr      Interface
//   Internet  10.0.0.10  -          02:00:00:00:02:00  -          <- learned one hop ago
//   R1#show arp Gi0/0
//   ... (none - no cached address resolves to this port)         <- and it was in Gi0/0's subnet
//
// The port was derived only for an address whose owner is *directly* peered, so a learner two hops
// away (behind a switch, which is the ordinary case) had no port at all. The subnet decides, exactly
// as it does for a hand-written entry. Along the way the table grew the Type column the single-address
// view already had, because "STATIC" was being smuggled into the Interface column and pushed that
// column out of line with its own header.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

// R1 -- SW1 -- PC1: the learner is two hops from the address it learns.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(find('generic-router')); r1.name = 'R1';
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const pc = t.addDevice(find('generic-pc')); pc.name = 'PC1';
  const rPort = Array.from(r1.interfaces.values())[0].name;
  const swPorts = Array.from(sw.interfaces.values()).filter(function (i) { return !i.svi; }).map(function (i) { return i.name; });
  const pcPort = Array.from(pc.interfaces.values())[0].name;
  t.connect(r1.id, rPort, sw.id, swPorts[0]);
  t.connect(sw.id, swPorts[1], pc.id, pcPort);
  const sim = new Simulator(t);
  const sr = new CliSession(r1, t, sim); sr.run('enable'); sr.run('configure terminal');
  sr.run('interface ' + rPort); sr.run('ip address 10.0.0.1 255.255.255.0'); sr.run('exit'); sr.run('end');
  const sp = new CliSession(pc, t, sim); sp.run('enable'); sp.run('configure terminal');
  sp.run('interface ' + pcPort); sp.run('ip address 10.0.0.10 255.255.255.0');
  sp.run('ip default-gateway 10.0.0.1'); sp.run('exit'); sp.run('end');
  return { t: t, sim: sim, r1: r1, sw: sw, pc: pc, sr: sr, sp: sp, rPort: rPort, pcPort: pcPort };
}
// A table row as a reader parses it: the cells between runs of two or more spaces.
function cells(line) { return line.trim().split(/\s{2,}/).map(function (c) { return c.trim(); }); }
function rowsOf(body) {
  return body.split('\n').filter(function (l) { return /^Internet/.test(l.trim()); }).map(cells);
}
function headerOf(body) {
  return body.split('\n').filter(function (l) { return /^Protocol/.test(l.trim()); })[0];
}

console.log('An address learned two hops away still has a port:');
{
  const env = lab();
  const ping = text(env.sp.run('ping 10.0.0.1 count 3'));
  ok(/100 percent \(3\/3\)/.test(ping), 'the ping answers');
  const all = text(env.sr.run('show arp'));
  const rows = rowsOf(all);
  ok(rows.length === 1, 'the router cached one address');
  ok(rows[0][4] === env.rPort, 'and names the port that would carry it (' + rows[0][4] + ')');
  const onPort = text(env.sr.run('show arp ' + env.rPort));
  ok(rowsOf(onPort).length === 1, 'the port filter sees its own row');
  ok(!/none - no cached address/.test(onPort), 'instead of saying the port has none');
  ok(rowsOf(onPort)[0][1] === '10.0.0.10', 'and it is the same address');
  // The host's own cache, one hop from its gateway.
  const host = rowsOf(text(env.sp.run('show arp')));
  ok(host.length === 1 && host[0][4] === env.pcPort, 'the host names its own port too');
  ok(rowsOf(text(env.sp.run('show arp ' + env.pcPort))).length === 1, 'and its filter agrees');
}

console.log('\nThe table has the columns its header promises:');
{
  const env = lab();
  env.sp.run('ping 10.0.0.1 count 2');
  env.sr.run('configure terminal'); env.sr.run('arp 10.0.0.5 00:11:22:33:44:55'); env.sr.run('end');
  const body = text(env.sr.run('show arp'));
  const header = cells(headerOf(body));
  ok(header.length === 6, 'the header has six columns (' + header.join('|') + ')');
  ok(header[5] === 'Type', 'with a Type column of its own');
  const rows = rowsOf(body);
  ok(rows.length === 2, 'two rows');
  for (const row of rows) ok(row.length === 6, 'every row has six cells: ' + row.join(' | '));
  const stat = rows.filter(function (r) { return r[5] === 'STATIC'; });
  const dyn = rows.filter(function (r) { return r[5] === 'DYNAMIC'; });
  ok(stat.length === 1, 'the hand-written entry is STATIC');
  ok(dyn.length === 1, 'the learned one is DYNAMIC');
  ok(!rows.some(function (r) { return /STATIC/.test(r[4]); }), 'and STATIC is not inside the Interface cell');
  // The single-address view is a slice of the same table.
  const one = text(env.sr.run('show arp 10.0.0.5'));
  ok(cells(headerOf(one)).length === 6, 'the single-address view uses the same six columns');
  const oneRow = rowsOf(one)[0];
  ok(oneRow && oneRow[5] === 'STATIC', 'and the same values');
}

console.log('\nThe Age column says what it can:');
{
  const env = lab();
  env.sp.run('ping 10.0.0.1 count 2');
  const body = text(env.sr.run('show arp'));
  ok(/Age is not tracked in this model/.test(body), 'a populated table explains the dash');
  ok(/clear arp/.test(body), 'and names what does empty it');
  // The cache is device state, so a fresh session sees the same rows: it is `clear arp` that empties
  // it, which also means the emptiness being tested is real rather than a new object.
  env.sr.run('clear arp');
  const empty = text(env.sr.run('show arp'));
  ok(!/Age is not tracked/.test(empty), 'an empty table does not explain ages to nobody');
  ok(!/^Internet/m.test(empty), 'and it is empty');
  // A port with no cached address: the router's second port, not the one the ping crossed.
  const other = Array.from(env.r1.interfaces.values()).filter(function (i) {
    return i.name !== env.rPort && !i.svi;
  })[0];
  const filtered = text(env.sr.run('show arp ' + (other ? other.name : env.rPort)));
  ok(!/Age is not tracked/.test(filtered), 'nor does a port filter that matched nothing');
  ok(/none - no cached address/.test(filtered), 'it says the port has none');
}

console.log('\nA port is not invented for an address that is not on a subnet here:');
{
  const env = lab();
  env.r1.arp.set('192.0.2.77', '02:00:00:00:00:77');
  const rows = rowsOf(text(env.sr.run('show arp')));
  const away = rows.filter(function (r) { return r[1] === '192.0.2.77'; })[0];
  ok(away && away[4] === '-', 'an off-subnet address keeps "-" rather than guessing a port');
  ok(rowsOf(text(env.sr.run('show arp ' + env.rPort)))
    .filter(function (r) { return r[1] === '192.0.2.77'; }).length === 0,
    'and the port filter does not claim it');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
