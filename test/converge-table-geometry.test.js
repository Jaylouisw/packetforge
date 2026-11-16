'use strict';
// `converge` - three columns laid out from fixed widths that no device name was allowed to exceed.
//
// The table was built as pad(process, 10) + pad(deviceName, 23) + pad(readyAt + ' ms', 10) + basis. `pad` right-pads
// and never truncates, so a name of 24 characters or more did not widen the column - it ran straight into the next
// one. Every default catalogue name is `label + '-' + last four characters of the id`, and 1475 of the 2329 specs in
// devices/ have a label long enough to cross 23 characters that way; the ISR 4331 the other converge suites use is
// one of them ('ISR 4331 branch router-r1', 25), so this is what the console prints for an untouched lab:
//
//     ospf      ISR 4331 branch router-r116000 ms  hello 10 s + exchange, then SPF hold  (pending)
//
// 'router-r1' followed by '16000 ms' with no gap reads as the instant 'r116000 ms' on a device called 'router-r1' -
// the Ready column cannot be found by eye, and a row cannot be read field by field. `show lldp neighbors` had exactly
// this defect and was fixed by taking the widths from the data (#1265); this is the same table with the same rule:
// header and rows laid out from one set of widths, so they cannot drift apart.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const specs = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const R = specs.find(function (s) { return /ISR 4331/.test(s.model); });

// Two routers with OSPF, so there is a real `ospf` row at 16000 ms and a real window in which it is pending. Names
// are left at their defaults unless renamed, because that is what a lab nobody renamed anything in has.
function lab(ids, rename) {
  const t = new Topology();
  for (const id of ids) t.addDevice(R, id);
  (rename || []).forEach(function (pair) { t.getDevice(pair[0]).name = pair[1]; });
  t.connect(ids[0], 'Gi0/0/0', ids[1], 'Gi0/0/0', { mediaId: '1000base-t', speedMbps: 1000 });
  const a = t.getDevice(ids[0]), b = t.getDevice(ids[1]);
  a.interfaces.get('Gi0/0/0').ip = '10.0.0.1'; a.interfaces.get('Gi0/0/0').mask = '255.255.255.0';
  b.interfaces.get('Gi0/0/0').ip = '10.0.0.2'; b.interfaces.get('Gi0/0/0').mask = '255.255.255.0';
  const sim = new Simulator(t);
  const s = new CliSession(a, t, sim);
  s.run('enable'); s.run('configure terminal');
  s.run('ospf router-id 1.1.1.1');
  s.run('interface Gi0/0/0'); s.run('ip ospf area 0'); s.run('exit'); s.run('end');
  return { topo: t, sim: sim, s: s };
}
function say(s, cmd) { return (s.run(cmd).output || []).map(String); }
function isRow(l) { return /^(ospf|stp|bgp|vrrp|change)\s/.test(l); }

// One reader for the header and for the rows: a row is well formed when its instant starts exactly under `Ready`
// and the word after it starts exactly under `Basis`.
function geometry(lines) {
  const header = lines[0] || '';
  const readyAt = header.indexOf('Ready');
  const basisAt = header.indexOf('Basis');
  const rows = lines.slice(1).filter(isRow).map(function (l) {
    const m = /\b(\d+) ms\b/.exec(l);
    const after = m ? m.index + m[0].length : -1;
    const rest = after === -1 ? '' : l.slice(after);
    const tail = rest.search(/\S/);
    return { line: l, instantAt: m ? m.index : -1, basisAt: tail === -1 ? -1 : after + tail };
  });
  return { header: header, readyAt: readyAt, basisAt: basisAt, rows: rows };
}

console.log('');
console.log('The default ISR 4331 name is longer than the column the table gives it:');
{
  const a = lab(['r1', 'r2']);
  const name = String(a.topo.getDevice('r1').name);
  const out = say(a.s, 'converge 1000');
  const g = geometry(out);
  ok(name.length > 23,
    'nothing here renamed anything and the name is still ' + name.length + ' characters', JSON.stringify(name));
  ok(g.rows.length > 0, 'converge prints a row for the OSPF process', JSON.stringify(out));
  for (const r of g.rows) {
    ok(r.instantAt === g.readyAt,
      'the instant starts under the Ready heading, not inside the device name',
      JSON.stringify({ row: r.line, readyAt: g.readyAt, instantAt: r.instantAt }));
    ok(r.basisAt === g.basisAt,
      'and the basis starts under the Basis heading',
      JSON.stringify({ row: r.line, basisAt: g.basisAt, got: r.basisAt }));
  }
}

console.log('');
console.log('A name far longer than any fixed column still leaves the table readable:');
{
  const long = 'router-in-the-far-corner-of-building-three';
  const a = lab(['r1', 'r2'], [['r1', long]]);
  const out = say(a.s, 'converge');
  const g = geometry(out);
  ok(g.rows.some(function (r) { return r.line.indexOf(long) !== -1; }),
    'the long name is printed in full rather than truncated', JSON.stringify(out));
  for (const r of g.rows) {
    ok(r.instantAt === g.readyAt, 'its instant still starts under the Ready heading', JSON.stringify(r.line));
    ok(r.basisAt === g.basisAt, 'and its basis under the Basis heading', JSON.stringify(r.line));
  }
  const widths = g.rows.map(function (r) { return r.instantAt; });
  ok(widths.every(function (w) { return w === widths[0]; }), 'every row agrees on the column', JSON.stringify(widths));
}

console.log('');
console.log('A short name does not pull the headings together:');
{
  const a = lab(['r1', 'r2'], [['r1', 'r1'], ['r2', 'r2']]);
  const out = say(a.s, 'converge');
  const g = geometry(out);
  ok(g.readyAt >= 'Process'.length + 3, 'the process column keeps a gap after its word', JSON.stringify(g.header));
  ok(g.rows.every(function (r) { return r.instantAt === g.readyAt; }),
    'the short-name rows line up with the header', JSON.stringify(out));
  ok(g.rows.every(function (r) { return r.line.slice(0, g.readyAt).trim().length > 0; }),
    'the name cell is not empty', JSON.stringify(out));
}

console.log('');
console.log('The pending mark rides on the row and never moves a column:');
{
  const a = lab(['r1', 'r2']);
  const pending = say(a.s, 'converge 1000');
  const converged = say(a.s, 'converge');
  const gp = geometry(pending), gc = geometry(converged);
  ok(pending.some(function (l) { return /\(pending\)/.test(l); }), 'at 1000 ms the OSPF row is still pending');
  ok(gp.readyAt === gc.readyAt && gp.basisAt === gc.basisAt,
    'the two answers share one set of widths', JSON.stringify({ pending: gp.header, converged: gc.header }));
  for (const r of gp.rows.concat(gc.rows)) {
    ok(r.instantAt === gp.readyAt, 'and every row in both answers uses them', JSON.stringify(r.line));
  }
}

console.log('');
console.log('A lab of short names prints the transcript the docs already show:');
{
  const a = lab(['r1', 'r2'], [['r1', 'SW1'], ['r2', 'SW2']]);
  const out = say(a.s, 'converge');
  // The heading the docs printed had `Basis` two columns left of the basis text its own rows print - a heading is a
  // row like any other, so it comes from the same widths. Widening a column for a long name must not move the short
  // ones either, or every sample in the docs becomes a transcript of something the console no longer says.
  ok(out[0] === 'Process   Device                 Ready     Basis',
    'the heading lines up with the rows under it, and with the transcript in docs/CONVERGENCE.md', JSON.stringify(out[0]));
  const row = out.filter(isRow)[0] || '';
  ok(/^ospf {6}SW1 {20}16000 ms {2}hello/.test(row),
    'and the row keeps the same three widths for a twenty-three-character-or-shorter name', JSON.stringify(row));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
