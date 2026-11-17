'use strict';
// The LocPrf column is the LOCAL_PREF attribute, and that attribute only exists inside an AS.
//
// `show ip bgp` printed `100` in this column on every row - including rows learned over eBGP, where a box
// prints nothing at all. Cisco's own answer to the question says the same of both directions: "show ip bgp
// show values (100) for routes advertised via iBGP and no values (blank) for routes advertised via eBGP"
// (https://community.cisco.com/t5/routing/bgp-and-local-preference/td-p/1082270), and the sample table in
// BGP Case Studies prints an external route as `*> 192.208.10.0 192.208.10.5 0 <blank> 0 300 i`
// (http://www.cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/26634-bgp-toc.html).
//
// So the blank is the answer, not an omission: the attribute is not in the path. The column has to stay a
// column while it is blank, or the Weight, Path and Session cells slide left and the row stops parsing.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const eth = function (d) {
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
};

// Two routers, one cable - and the two AS numbers decide whether the session is eBGP or iBGP.
function lab(as1, as2) {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const r2 = t.addDevice(ROUTER, 'r2');
  t.connect('r1', eth(r1)[0].name, 'r2', eth(r2)[0].name);
  const sim = new Simulator(t);
  runCommands(r1, t, sim, ['configure terminal', 'interface ' + eth(r1)[0].name,
    'ip address 10.0.0.1 255.255.255.0', 'end', 'configure terminal',
    'router bgp ' + as1, 'neighbor 10.0.0.2 remote-as ' + as2, 'end']);
  runCommands(r2, t, sim, ['configure terminal', 'interface ' + eth(r2)[0].name,
    'ip address 10.0.0.2 255.255.255.0', 'end', 'configure terminal',
    'router bgp ' + as2, 'neighbor 10.0.0.1 remote-as ' + as1, 'end']);
  sim.ping('r1', '10.0.0.2', { count: 1 });
  return { t: t, sim: sim, r1: r1, r2: r2 };
}

function show(env, dev) {
  return ((new CliSession(dev, env.t, env.sim).run('show ip bgp').output) || []).map(String);
}

// The table, read the way a reader reads it: the header fixes where each column starts, so the test asks
// the same question the eye asks - is there anything under "LocPrf" on this row?
function table(lines) {
  const at = lines.findIndex(function (l) { return /^Network {2,}Next Hop/.test(l); });
  if (at === -1) return { header: null, rows: [] };
  const header = lines[at];
  const rows = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (!lines[i].trim()) break;
    rows.push(lines[i]);
  }
  return { header: header, rows: rows };
}

// A cell is the run of characters under a heading, up to where the next heading starts.
function cell(row, header, name) {
  const start = header.indexOf(name);
  if (start === -1) return null;
  const rest = header.slice(start + name.length);
  const gap = rest.search(/[^ ]/);
  const end = gap === -1 ? row.length : start + name.length + gap;
  return row.slice(start, end).trim();
}

console.log('');
console.log('A route learned over eBGP carries no LOCAL_PREF, so LocPrf is blank:');
{
  const env = lab(65001, 65002);
  const t = table(show(env, env.r2));
  ok(t.header !== null && /LocPrf/.test(t.header), 'the table has its header and a LocPrf column',
    JSON.stringify(t.header));
  ok(t.rows.length === 1, 'one prefix learned', JSON.stringify(t.rows));
  const row = t.rows[0] || '';
  ok(/^10.0.0.0\/24/.test(row), 'the row is the peer\'s prefix', row);
  ok(cell(row, t.header, 'LocPrf') === '', 'the LocPrf cell is empty - the attribute is not in the path', row);
  // The blank is a cell, not a missing field: the others must still be where the header says.
  ok(cell(row, t.header, 'Metric') === '0', 'and Metric still reads 0', row);
  ok(cell(row, t.header, 'Weight') === '0', 'Weight still reads 0, unmoved by the blank', row);
  ok(/65001 i/.test(String(cell(row, t.header, 'Path'))), 'Path still holds the AS path and the origin code', row);
  ok(/eBGP/.test(row), 'and the session column still says which kind of peer it came from', row);
}

console.log('');
console.log('A route learned over iBGP does carry it, and a box prints the default 100:');
{
  const env = lab(65001, 65001);
  const t = table(show(env, env.r2));
  ok(t.header !== null, 'the table is printed', t.header);
  ok(t.rows.length === 1, 'one prefix learned', JSON.stringify(t.rows));
  const row = t.rows[0] || '';
  ok(cell(row, t.header, 'LocPrf') === '100', 'the LocPrf cell reads 100', row);
  ok(cell(row, t.header, 'Weight') === '0', 'Weight still reads 0', row);
  ok(/iBGP/.test(row), 'and the session column says iBGP', row);
}

console.log('');
console.log('The rule is the session, not the column:');
{
  // The same prefix, learned two ways. A version that blanked the column outright, or one that went on
  // printing 100 for everything, would agree with one of these rows and disagree with the other.
  const envA = lab(65001, 65002);
  const envB = lab(65001, 65001);
  const a = table(show(envA, envA.r2));
  const b = table(show(envB, envB.r2));
  const eCell = cell(a.rows[0] || '', a.header, 'LocPrf');
  const iCell = cell(b.rows[0] || '', b.header, 'LocPrf');
  ok(eCell === '' && iCell === '100', 'blank over eBGP, 100 over iBGP - one prefix, two answers',
    JSON.stringify({ eBGP: eCell, iBGP: iCell }));
  ok(/10.0.0.0\/24/.test(String(a.rows[0] || '')) && /65001 i/.test(String(a.rows[0] || '')),
    'and the eBGP row is still a whole row: the blank is one field, not the line', JSON.stringify(a.rows));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
