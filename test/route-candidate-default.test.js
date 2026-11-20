'use strict';
// The asterisk in `show ip route` marks a candidate default, and it belongs to the prefix
// (research/show-ip-route-candidate-default.md).
//
// The table printed `S*` on the one row this engine invents - the configured gateway at distance 254 -
// and printed a default an operator actually types, `ip route 0.0.0.0 0.0.0.0 <next hop>`, as a plain
// `S`. That is the reverse of the device: Cisco's own gateway-of-last-resort note prints that route as
// `S* 0.0.0.0/0 [1/0] via 10.108.99.2`, and the same note prints two starred candidates in one table -
// `S* 0.0.0.0/0` and `S* 192.168.1.0/24` - so the star is not a one-per-box title and does not mean
// "the one that lost". It is the legend's own sentence: `* - candidate default`.
const path = require('path');
const { Device } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];

// One router, two addressed ports, and whatever routes the case is about.
function build(routes, opts) {
  opts = opts || {};
  const dev = new Device('r1', ROUTER);
  const ports = [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  ports[0].ip = '10.1.2.3'; ports[0].mask = '255.255.255.0';
  ports[1].ip = '10.9.0.1'; ports[1].mask = '255.255.255.0';
  dev.config.routes = (routes || []).slice();
  // A second default at distance 254. It used to be a configured `ip default-gateway`, which this engine
  // turned into a row of its own; a routing box installs no route for that command
  // (research/ip-default-gateway-when-routing.md), so the shape is produced the way a box produces it - a
  // static default carrying an explicit distance.
  if (opts.secondDefault) {
    dev.config.routes.push({ dest: '0.0.0.0', mask: '0.0.0.0', gw: opts.secondDefault, iface: null, distance: 254 });
  }
  if (opts.ospfRoutes) dev.ospfRoutes = opts.ospfRoutes;
  return { dev: dev, ports: ports, cli: new CliSession(dev, null, null) };
}

function show(env) {
  const r = env.cli.run('show ip route');
  return ((r && r.output) || []).map(String);
}
function rowsFor(lines, dest) {
  return lines.filter(function (l) {
    return l.indexOf(dest) !== -1 && !/^Codes:/.test(l) && !/^Gateway of last resort/.test(l);
  });
}
// The block is nine lines, not one (research/show-ip-route-codes-legend.md); `* - candidate default` lives on
// the sixth, so reading `lines[0]` alone cannot see the mark this suite is about.
function legendText(lines) {
  const block = [];
  for (const l of lines) {
    if (l.indexOf('Codes: ') === 0 || (block.length && l.indexOf('       ') === 0)) block.push(l);
    else break;
  }
  return block.join('\n');
}
const DEFAULT_ROUTE = [{ dest: '0.0.0.0', mask: '0.0.0.0', gw: '10.1.2.1', iface: null }];

console.log('A default an operator types is a candidate default:');
{
  const env = build(DEFAULT_ROUTE);
  const lines = show(env);
  const row = rowsFor(lines, '0.0.0.0')[0] || '';
  ok(/^S\*/.test(row), 'the row carries S*, the shape Cisco prints', row);
  ok(/\[1\/0\]/.test(row), 'at distance 1, which the star does not change', row);
  const data = env.dev.routesTable().filter(function (r) { return r.dest === '0.0.0.0'; })[0];
  ok(!!data && data.candidateDefault === true, 'and the row says so as data, not only as prose',
    JSON.stringify(data && data.candidateDefault));
  ok(!!data && data.displayCode === 'S*', 'the code every surface prints is the starred one',
    data && data.displayCode);
}

console.log('');
console.log('A static route to a real network is not a candidate default:');
{
  const env = build([{ dest: '192.0.2.0', mask: '255.255.255.0', gw: '10.1.2.1', iface: null }]);
  const lines = show(env);
  const row = rowsFor(lines, '192.0.2.0')[0] || '';
  ok(/^S\s/.test(row), 'it prints a bare S', row);
  ok(!/\*/.test(row.split('  ')[0]), 'with no asterisk anywhere in its code or address', row);
  const data = env.dev.routesTable().filter(function (r) { return r.dest === '192.0.2.0'; })[0];
  ok(!!data && data.candidateDefault === false, 'and it is not marked as a candidate',
    JSON.stringify(data && data.candidateDefault));
}

console.log('');
console.log('Two candidates in one table are both starred, and the distance separates them:');
{
  // Two defaults in one table at different distances: the typed route at 1 and a second one at 254. Both are
  // candidates for the default, and the distance is what separates them.
  const env = build(DEFAULT_ROUTE, { secondDefault: '10.1.2.254' });
  const lines = show(env);
  const zero = rowsFor(lines, '0.0.0.0');
  ok(zero.length === 2, 'both defaults are printed', JSON.stringify(zero));
  ok(zero.every(function (l) { return /^S\*/.test(l); }), 'and both carry the star', JSON.stringify(zero));
  ok(/\b10\.1\.2\.1\b/.test(zero.filter(function (l) { return /\[1\/0\]/.test(l); })[0] || ''),
    'the typed default is the [1/0] row, via its own next hop',
    zero.filter(function (l) { return /\[1\/0\]/.test(l); })[0]);
  ok(/\b10\.1\.2\.254\b/.test(zero.filter(function (l) { return /\[254\/0\]/.test(l); })[0] || ''),
    'the distance-254 default is the [254/0] row',
    zero.filter(function (l) { return /\[254\/0\]/.test(l); })[0]);
  const gwLine = lines.filter(function (l) { return /^Gateway of last resort is/.test(l); })[0] || '';
  ok(gwLine.indexOf('10.1.2.1') !== -1 && gwLine.indexOf('10.1.2.254') === -1,
    'and the gateway-of-last-resort line still names the one packets leave by', gwLine);
}

console.log('');
console.log('A learned default keeps its own code and takes the star:');
{
  // OSPF default origination is not modelled here, so this is the row-level rule only: a /0 route that
  // arrives from a protocol is printed with that protocol's code and the candidate-default star, which
  // is what `O*E2 0.0.0.0/0` is on a device (the E2 suffix is the part this engine cannot reproduce).
  const env = build([], { ospfRoutes: [{ dest: '0.0.0.0', mask: '0.0.0.0', nextHop: '10.1.2.9', iface: 'Gi0', cost: 2 }] });
  const lines = show(env);
  const row = rowsFor(lines, '0.0.0.0')[0] || '';
  ok(/^O\*/.test(row), 'the OSPF default prints as O*', row);
  ok(/\[110\//.test(row), 'with the OSPF distance, since the code alone does not say where it came from', row);
  const data = env.dev.routesTable().filter(function (r) { return r.type === 'ospf'; })[0];
  ok(!!data && data.candidateDefault === true && data.displayCode === 'O*',
    'and the data carries the same two facts', data && (data.displayCode + ' ' + data.candidateDefault));
}

console.log('');
console.log('The legend defines the mark the rows use:');
{
  const env = build(DEFAULT_ROUTE, { secondDefault: '10.1.2.254' });
  const lines = show(env);
  const legend = legendText(lines);
  const legendLines = legend.split('\n');
  ok(legend.indexOf('* - candidate default') !== -1, 'the legend names the asterisk',
    legendLines[5]);
  ok(legend.indexOf('C - connected') !== -1 && legend.indexOf('S - static') !== -1,
    'and still names every letter code the table prints', legendLines[0]);
  const body = lines.slice(legendLines.length).join('\n');
  const firstRow = lines.findIndex(function (l) { return /^[A-Z]\*?\s/.test(l); });
  // The gateway sentence sits between the block and the first row, so "after the legend" is the property,
  // not "immediately after it".
  ok(body.indexOf('S*') !== -1 && firstRow > legendLines.length - 1,
    'the legend comes first, before any row that uses it', lines.slice(0, 11).join(' | '));
}

console.log('');
console.log('Every 0.0.0.0/0 row is starred, and nothing else is:');
{
  const env = build([
    { dest: '0.0.0.0', mask: '0.0.0.0', gw: '10.1.2.1', iface: null },
    { dest: '192.0.2.0', mask: '255.255.255.0', gw: '10.1.2.1', iface: null },
    { dest: '172.16.0.0', mask: '255.255.0.0', gw: null, iface: 'Gi1' }
  ], { secondDefault: '10.1.2.254' });
  const rows = env.dev.routesTable();
  const wrong = rows.filter(function (r) {
    const isDefault = r.dest === '0.0.0.0' && r.mask === '0.0.0.0';
    const starred = /\*$/.test(String(r.displayCode));
    return isDefault !== starred || r.candidateDefault !== isDefault;
  });
  ok(rows.length >= 5, 'the table covers connected, static, interface-only and both defaults (' + rows.length + ')');
  ok(wrong.length === 0, 'the star is exactly the set of routes to 0.0.0.0/0',
    wrong.map(function (r) { return r.displayCode + ' ' + r.dest + '/' + r.mask; }).join(' | '));
  const printed = show(env).filter(function (l) { return /^[A-Z]/.test(l); });
  const starredLines = printed.filter(function (l) { return /^[A-Z]\*/.test(l); });
  const starredRows = rows.filter(function (r) { return r.candidateDefault; });
  ok(starredLines.length === starredRows.length,
    'and the console prints a star on exactly those rows, no more and no fewer',
    starredLines.length + ' lines vs ' + starredRows.length + ' rows');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
