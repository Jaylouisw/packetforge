'use strict';
// `show ip route` has to be readable by someone who wants to know two things: which route is installed,
// and why (#1234).
//
// It answered neither. The legend named C and S while the table could also print O and B; the default
// gateway was labelled `S`, identical to a configured static default route even though the engine
// treats them as different sources (distance 254 against 1); and the administrative distance - half of
// the rule that picks the installed route - was not shown at all. `via -` on a connected row read as
// "no next hop" rather than "directly connected".
//
// The last section is the part that matters: for every prefix in the printed table, the row the engine
// would actually install has to be the one the table makes obvious.
const path = require('path');
const { Device } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const net = require('../engine/net');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];

function build() {
  const dev = new Device('r1', ROUTER);
  const ports = [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  ports[0].ip = '10.1.2.3'; ports[0].mask = '255.255.255.0';
  ports[1].ip = '10.9.0.1'; ports[1].mask = '255.255.255.0';
  dev.config.routes = [{ dest: '0.0.0.0', mask: '0.0.0.0', gw: '10.1.2.1', iface: null }];
  dev.config.defaultGateway = '10.1.2.254';
  dev.ospfRoutes = [{ dest: '10.77.0.0', mask: '255.255.0.0', nextHop: '10.1.2.9', iface: ports[0].name }];
  dev.bgpRoutes = [
    { dest: '203.0.113.0', mask: '255.255.255.0', nextHop: '10.1.2.2', iface: ports[0].name, ad: 20 },
    { dest: '198.18.0.0', mask: '255.255.0.0', nextHop: '10.9.0.2', iface: ports[1].name, ad: 200 }
  ];
  const cli = new CliSession(dev, null, null);
  return { dev: dev, cli: cli, ports: ports };
}

function show(s) {
  const r = s.cli.run('show ip route');
  return ((r && r.output) || []).map(String);
}

function rowFor(lines, destPrefix) {
  return lines.filter(function (l) {
    return l.indexOf(destPrefix) !== -1 && !/^Codes:/.test(l) && !/^Gateway of last resort/.test(l);
  });
}

console.log('');
console.log('The legend names every code the table can print:');
{
  const s = build();
  const lines = show(s);
  const legend = lines[0];
  ok(/C\b.*connected/.test(legend), 'the legend explains C', legend);
  ok(/S\b.*static/.test(legend), 'the legend explains S', legend);
  ok(/O\b.*OSPF/.test(legend), 'the legend explains O - the table emits OSPF rows', legend);
  ok(/B\b.*BGP/.test(legend), 'the legend explains B - the table emits BGP rows', legend);

  // Every code that actually appears in the body must be in the legend.
  const body = lines.slice(1);
  const codes = new Set();
  for (const l of body) {
    const m = /^([A-Z]\*?)\s/.exec(l);
    if (m) codes.add(m[1].replace('*', ''));
  }
  const unexplained = [...codes].filter(function (c) { return legend.indexOf(c + ' -') === -1; });
  ok(unexplained.length === 0, 'and nothing in the body uses a code the legend does not define',
    unexplained.join(','));
}

console.log('');
console.log('A connected route reads as a connected route:');
{
  const lines = show(build());
  const connected = rowFor(lines, '10.1.2.0');
  ok(connected.length === 1, 'one row for the connected subnet', JSON.stringify(connected));
  ok(/is directly connected,/.test(connected[0] || ''), 'it says "is directly connected"', connected[0]);
  ok(!/via -/.test(connected[0] || ''), 'and it does not print a meaningless "via -"', connected[0]);
  ok(/Gi0|Gi0\/0\/0/.test(connected[0] || ''), 'naming the interface', connected[0]);
}

console.log('');
console.log('The default gateway is not a static route:');
{
  const s = build();
  const lines = show(s);
  const zero = rowFor(lines, '0.0.0.0');
  ok(zero.length === 2, 'both defaults are printed', JSON.stringify(zero));
  const candidate = zero.filter(function (l) { return /^S\*/.test(l); })[0];
  const stat = zero.filter(function (l) { return /^S\s/.test(l); })[0];
  ok(!!candidate, 'the gateway is marked as the candidate default (S*)', JSON.stringify(zero));
  ok(!!stat, 'the configured static default is still a plain S', JSON.stringify(zero));
  ok(/\[254\/0\]/.test(candidate || ''), 'the gateway carries distance 254', candidate);
  ok(/\[1\/0\]/.test(stat || ''), 'the static carries distance 1', stat);
  ok(candidate !== stat, 'so the two rows are no longer identical looking');

  const gatewayLine = lines.filter(function (l) { return /^Gateway of last resort is/.test(l); })[0];
  ok(!!gatewayLine, 'a "Gateway of last resort" line names the gateway', gatewayLine);
  ok(gatewayLine.split(' ').indexOf('10.1.2.1') !== -1,
    'naming the default that is installed (the static one), not the configured gateway', gatewayLine);

  // With no static default, the configured gateway is the installed default and must be named.
  const only = build();
  only.dev.config.routes = [];
  const onlyLines = show(only);
  const onlyLine = onlyLines.filter(function (l) { return /^Gateway of last resort is/.test(l); })[0] || '';
  ok(/10\.1\.2\.254/.test(onlyLine), 'a device with only a configured gateway names it', onlyLine);
  ok(/^S\*\s+0\.0\.0\.0/m.test(onlyLines.join('\n')), 'and the row is the candidate default');
}

console.log('');
console.log('Distances are the ones the engine actually uses:');
{
  const lines = show(build());
  ok(/\[110\/0\]/.test(rowFor(lines, '10.77.0.0')[0] || ''), 'OSPF is 110', rowFor(lines, '10.77.0.0')[0]);
  ok(/\[20\/0\]/.test(rowFor(lines, '203.0.113.0')[0] || ''), 'eBGP is 20', rowFor(lines, '203.0.113.0')[0]);
  ok(/\[200\/0\]/.test(rowFor(lines, '198.18.0.0')[0] || ''), 'iBGP defaults to 200', rowFor(lines, '198.18.0.0')[0]);
}

console.log('');
console.log('A device with no default prints no gateway line:');
{
  const s = build();
  s.dev.config.defaultGateway = null;
  s.dev.config.routes = [];
  const lines = show(s);
  ok(!lines.some(function (l) { return /^Gateway of last resort/.test(l); }), 'no stale gateway line');
  ok(!lines.some(function (l) { return /^S\*/.test(l); }), 'and no candidate default row');
}

console.log('');
console.log('The printed table agrees with the data plane:');
{
  // For every prefix in the table, the row the engine would install must be the one the table makes
  // look best: longest prefix, then lowest distance. This is the property that makes the distances
  // worth printing at all.
  const s = build();
  const lines = show(s);
  const rows = [];
  for (const l of lines.slice(1)) {
    const m = /^([A-Z]\*?)\s+(\d+\.\d+\.\d+\.\d+)\s+\/(\d+)\s+.*\[(\d+)\/\d+\]/.exec(l);
    if (m) rows.push({ code: m[1], dest: m[2], prefix: Number(m[3]), distance: Number(m[4]) });
  }
  ok(rows.length >= 4, 'the table parsed into rows (' + rows.length + ')');

  function maskFor(prefix) {
    return net.intToIp(prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0);
  }
  const TYPE_OF_CODE = { C: 'connected', S: 'static', 'S*': 'default', O: 'ospf', B: 'bgp' };

  const problems = [];
  for (const r of rows) {
    // A sample address inside this prefix: the network address plus one.
    const probe = net.intToIp(((net.ipToInt(r.dest) >>> 0) + 1) >>> 0);
    const contenders = rows
      .filter(function (x) { return net.ipInSubnet(probe, x.dest, maskFor(x.prefix)); })
      .sort(function (a, b) { return b.prefix - a.prefix || a.distance - b.distance; });
    const best = contenders[0];
    if (!best) continue;
    const verdict = s.dev.routeTo(probe);
    if (!verdict) { problems.push(probe + ': engine cannot route it, but the table lists ' + best.code); continue; }
    if (verdict.type !== TYPE_OF_CODE[best.code]) {
      problems.push(probe + ': engine says ' + verdict.type + ', table best is ' + best.code);
    }
    // And when the engine hands the packet on, the next hop is the one the winning row names.
    if (best.code !== 'C' && verdict.via && best && r.dest === best.dest) {
      const rowForBest = rowFor(lines, best.dest + ' ')[0] || '';
      if (verdict.via !== best.dest && !rowForBest.includes(verdict.via)) {
        problems.push(probe + ': engine uses ' + verdict.via + ', winning row ' + best.dest);
      }
    }
  }
  ok(problems.length === 0, 'every prefix is routed the way the table makes it look', problems.slice(0, 3).join(' | '));

  // A destination nothing covers leaves by the *installed* default: the static route at distance 1,
  // not the configured gateway at 254. Both are printed, and the distances are what make the winner
  // visible - which is the whole reason for printing them.
  const verdict = s.dev.routeTo('8.8.8.8');
  const installed = rows.filter(function (x) { return x.dest === '0.0.0.0'; })
    .sort(function (a, b) { return a.distance - b.distance; })[0];
  ok(verdict && verdict.type === 'static', 'an uncovered destination uses the static default',
    JSON.stringify(verdict));
  ok(!!installed && installed.distance === 1 && installed.code === 'S',
    'and that is the row the table shows winning', JSON.stringify(installed));

  const gatewayLine = lines.filter(function (l) { return /^Gateway of last resort is/.test(l); })[0] || '';
  ok(gatewayLine.indexOf('10.1.2.1') !== -1,
    'the gateway line names the installed default, not the losing configured gateway', gatewayLine);
  ok(gatewayLine.indexOf('10.1.2.254') === -1, 'and it does not name the one no packet uses', gatewayLine);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
