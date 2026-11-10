'use strict';
// nat-show.test.js — `show ip nat translations` / `show ip nat statistics`.
//
// NAT has no CLI verb: rules come from the topology, so these two shows are the
// only way an operator can see what the data path did with those rules. The point
// of the test is that the answer is the *run's own* answer — the same entry the
// packet path wrote, not a recomputation from the rules that might disagree with it.
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

const t = new Topology();
const pc = t.addDevice(model('generic-pc'));
const r1 = t.addDevice(model('generic-router'));
const srv = t.addDevice(model('generic-server'));
pc.name = 'PC1'; r1.name = 'R1'; srv.name = 'WEB';
t.connect(pc.id, 'eth0', r1.id, 'Gi0/0');
t.connect(r1.id, 'Gi0/1', srv.id, 'eth0');
const sim = new Simulator(t);

function run(dev, commands) { return runCommands(dev, t, sim, commands).lines; }
function show(dev, command) {
  return run(dev, ['enable', command]).filter(function (l) {
    return !/^[A-Za-z0-9._()\/-]*[>#]/.test(l);      // drop the echoed prompt line
  });
}

run(pc, ['configure terminal', 'interface eth0', 'ip address 192.168.1.10 255.255.255.0',
  'exit', 'ip default-gateway 192.168.1.1', 'hostname PC1']);
run(r1, ['configure terminal', 'interface Gi0/0', 'ip address 192.168.1.1 255.255.255.0',
  'exit', 'interface Gi0/1', 'ip address 203.0.113.1 255.255.255.0', 'hostname R1']);
run(srv, ['configure terminal', 'interface eth0', 'ip address 203.0.113.9 255.255.255.0',
  'exit', 'ip default-gateway 203.0.113.1', 'hostname WEB']);

console.log('A device with no NAT rules says so, and says where rules come from:');
{
  const lines = show(pc, 'show ip nat translations').join('\n');
  ok(lines.indexOf('NAT translations on PC1:') !== -1, 'the heading names the device');
  ok(/\(none - no NAT rules/.test(lines), 'an unconfigured device reports no rules');
  ok(/configured from the topology/.test(lines), 'and points at where NAT is configured');
}

// PAT is how a lab out to the internet actually works, so it is the rule under test.
r1.config.nat = { rules: [{ type: 'pat', insideLocal: '192.168.1.0/24', insideGlobal: '203.0.113.1' }] };

console.log('\nConfigured but idle is a different answer from unconfigured:');
{
  const lines = show(r1, 'show ip nat translations').join('\n');
  ok(/none yet - 1 rule configured, but no traffic has been translated/.test(lines),
    'an idle router reports the rule count and that nothing has hit it');
  ok(lines.indexOf('Inside global') === -1, 'no table header appears when there is no table to show');

  const stats = show(r1, 'show ip nat statistics').join('\n');
  ok(/rules\s+1\s+\(pat 1\)/.test(stats), 'statistics count the rule and its type');
  ok(/translations\s+0/.test(stats), 'statistics report zero entries before traffic');
}

const flow = sim.openFlow({ proto: 'tcp', srcDevice: pc.id, dstDevice: srv.id, dstPort: 80, bytes: 500 });
eq(flow.ok, true, 'a TCP flow from the inside host through the PAT router opens');

console.log('\nAfter traffic the table is the one the packet path wrote:');
const rows = show(r1, 'show ip nat translations');
const header = rows[1];                       // rows[0] names the device
const body = rows.slice(2);   // heading, column header, then one row per translation
{
  eq(body.length, 1, 'one conversation leaves one translation');
  ok(body[0].indexOf('203.0.113.1:') !== -1, 'the global address is the PAT address');
  ok(body[0].indexOf('192.168.1.10:') !== -1, 'the inside host is named');
  ok(/^Pro\s+Inside global\s+Inside local\s+Outside local\s+Outside global\s+Type$/.test(header),
    'the header is the classic five columns plus the rule type');
  eq(header.indexOf('Type'), body[0].indexOf('pat'),
    'the Type label sits over the type value, not beside it');

  // The claim worth pinning: the CLI shows what crossed the wire, not a replay of
  // the rules. Compare against the event the data path emitted.
  const outbound = sim.events.filter(function (e) { return e.type === 'nat-outbound'; })[0];
  ok(body[0].indexOf(':' + outbound.globalPort) !== -1,
    'the global port in the table is the one the packet carried (:' + outbound.globalPort + ')');
}

console.log('\nStatistics count what the table shows:');
{
  const stats = show(r1, 'show ip nat statistics').join('\n');
  ok(/translations\s+1/.test(stats), 'one translation');
  ok(/dynamic entries\s+1/.test(stats), 'counted as dynamic, because PAT is not static');
  const hits = Number((/hits\s+(\d+)/.exec(stats) || [])[1]);
  ok(hits >= 1, 'the entry has been hit at least once (' + hits + ')');
}

console.log('\nThe console and the API are one table, not two renderings of it:');
{
  const nat = require('../engine/nat');
  const table = sim._natTableOf(r1);
  const apiLines = nat.formatTable(table);
  const cliLines = show(r1, 'show ip nat translations').slice(2);   // drop heading + column header
  eq(cliLines.length, apiLines.length, 'both doors print the same number of rows');
  const same = cliLines.every(function (l, i) { return l === apiLines[i]; });
  ok(same, 'and each row is character-for-character the same' +
    (same ? '' : ' (' + JSON.stringify(cliLines[0]) + ' vs ' + JSON.stringify(apiLines[0]) + ')'));

  // The header is derived from the same column list, so it cannot drift from the rows.
  // It is *not* byte-identical to the live header: `TABLE_HEADER` is the columns with no
  // data behind them, and a value wider than its column name ("203.0.113.1:1024" against
  // "Inside global") legitimately widens the live table. Same source, different data.
  const live = show(r1, 'show ip nat translations');
  const header = live[1];
  eq(header.trim().split(/\s{2,}/).join('|'), nat.TABLE_COLUMNS.join('|'),
    'the live header is the same column list, in the same order');
  eq(nat.TABLE_HEADER.trim().split(/\s{2,}/).join('|'), nat.TABLE_COLUMNS.join('|'),
    'and so is the exported TABLE_HEADER');
  const body = live[2];
  ok(nat.TABLE_COLUMNS.every(function (name) {
    const at = header.indexOf(name);
    return at !== -1 && body.length > at && body.slice(at).length > 0;
  }), 'every column name sits over its value');
  eq(header.indexOf('Type'), body.indexOf('pat'),
    'including the Type label, which used to need a hand-computed offset');
}

console.log('\nA second conversation is a second row, ordered by global port:');
{
  sim.openFlow({ proto: 'udp', srcDevice: pc.id, dstDevice: srv.id, dstPort: 53, bytes: 100 });
  const body2 = show(r1, 'show ip nat translations').slice(2);
  eq(body2.length, 2, 'two conversations, two translations');
  const ports = body2.map(function (l) {
    return Number((/:(\d+)\s/.exec(l) || [])[1]);
  });
  ok(ports[0] <= ports[1], 'rows are sorted by global port (' + ports.join(' <= ') + ')');
  const again = show(r1, 'show ip nat translations').slice(2);
  eq(again.join('\n'), body2.join('\n'), 'the same query renders identically (nothing random in it)');
}

console.log('\nA typo is refused by name, with the two verbs that exist:');
{
  const lines = show(r1, 'show ip nat foo');
  eq(lines.length, 2, 'two lines: what was refused, and what to try');
  ok(/^% Unknown nat show: show ip nat foo/.test(lines[0]), 'the refusal quotes the bad word');
  ok(/show ip nat translations \| statistics/.test(lines[1]), 'the hint lists both sub-commands');
}

console.log('\nA static rule is reported as static, not as dynamic:');
{
  const t2 = new Topology();
  const a = t2.addDevice(model('generic-pc'));
  const b = t2.addDevice(model('generic-router'));
  const c = t2.addDevice(model('generic-server'));
  a.name = 'PC9'; b.name = 'R9'; c.name = 'SRV9';
  t2.connect(a.id, 'eth0', b.id, 'Gi0/0');
  t2.connect(b.id, 'Gi0/1', c.id, 'eth0');
  const sim2 = new Simulator(t2);
  function run2(dev, cmds) { return runCommands(dev, t2, sim2, cmds).lines; }
  function show2(dev, cmd) {
    return run2(dev, ['enable', cmd]).filter(function (l) {
      return !/^[A-Za-z0-9._()\/-]*[>#]/.test(l);
    });
  }
  run2(a, ['configure terminal', 'interface eth0', 'ip address 10.9.0.5 255.255.255.0',
    'exit', 'ip default-gateway 10.9.0.1', 'hostname PC9']);
  run2(b, ['configure terminal', 'interface Gi0/0', 'ip address 10.9.0.1 255.255.255.0',
    'exit', 'interface Gi0/1', 'ip address 198.51.100.1 255.255.255.0', 'hostname R9']);
  run2(c, ['configure terminal', 'interface eth0', 'ip address 198.51.100.7 255.255.255.0',
    'exit', 'ip default-gateway 198.51.100.1', 'hostname SRV9']);
  b.config.nat = { rules: [{ type: 'static', insideLocal: '10.9.0.5', insideGlobal: '198.51.100.5' }] };
  sim2.openFlow({ proto: 'udp', srcDevice: a.id, dstDevice: c.id, dstPort: 53, bytes: 64 });
  const lines = show2(b, 'show ip nat translations').join('\n');
  ok(/static/.test(lines), 'the static rule shows its own type');
  ok(/198\.51\.100\.5/.test(lines), 'the global address is the static mapping');
  const stats = show2(b, 'show ip nat statistics').join('\n');
  ok(/dynamic entries\s+0/.test(stats), 'a static-only table has no dynamic entries');
  ok(/\(static 1\)/.test(stats), 'statistics name the static rule');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
