'use strict';
// bgp-table.test.js - `show ip bgp` answered the neighbour summary.
//
// The console had one table for two questions. "Are my peers up" is `show ip bgp summary`; "what did
// they give me, and which row forwards" is the BGP table - and that second view did not exist,
// although the model held every field it needs:
//
//   R1#show ip bgp
//   Neighbor  V  AS     State        Reason        <- the summary, under the other name
//   10.0.0.2  4  65002  Established  eBGP
//
// The table prints only what the engine holds: the prefix, the next hop, the AS path, and which row
// forwards. IOS's Metric/LocPrf/Weight/Origin columns are not modelled here, so printing `0 100 0 ?`
// on every row would be four invented numbers - the header says what is missing instead.
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
function cells(line) { return line.trim().split(/\s{2,}/).map(function (c) { return c.trim(); }); }

// R1 (AS 65001) -- R2 (AS 65002), R2 also holding 192.168.5.0/24.
function lab() {
  const t = new Topology();
  const a = t.addDevice(find('generic-router')); a.name = 'R1';
  const b = t.addDevice(find('generic-router')); b.name = 'R2';
  t.connect(a.id, 'Gi0/0', b.id, 'Gi0/0');
  const sim = new Simulator(t);
  const sa = new CliSession(a, t, sim); sa.run('enable'); sa.run('configure terminal');
  sa.run('interface Gi0/0'); sa.run('ip address 10.0.0.1 255.255.255.0'); sa.run('exit');
  sa.run('router bgp 65001'); sa.run('neighbor 10.0.0.2 remote-as 65002'); sa.run('exit'); sa.run('end');
  const sb = new CliSession(b, t, sim); sb.run('enable'); sb.run('configure terminal');
  sb.run('interface Gi0/0'); sb.run('ip address 10.0.0.2 255.255.255.0'); sb.run('exit');
  sb.run('interface Gi0/1'); sb.run('ip address 192.168.5.1 255.255.255.0'); sb.run('exit');
  sb.run('router bgp 65002'); sb.run('neighbor 10.0.0.1 remote-as 65001'); sb.run('exit');
  sb.run('network 192.168.5.0 mask 255.255.255.0'); sb.run('end');
  return { t: t, sim: sim, a: a, b: b, sa: sa, sb: sb };
}

console.log('The bare command is the BGP table:');
{
  const env = lab();
  const body = text(env.sa.run('show ip bgp'));
  ok(/Network\s+Next Hop\s+Path/.test(body), 'the header names the columns it fills');
  ok(!/Neighbor\s+V\s+AS\s+State/.test(body), 'and it is not the neighbour summary');
  const rows = body.split('\n').filter(function (l) { return /^\s*[*>]+\s+\d/.test(l); }).map(cells);
  ok(rows.length === 2, 'both received prefixes are listed (' + rows.length + ')');
  ok(rows.some(function (r) { return r.indexOf('192.168.5.0/24') !== -1; }), 'the far subnet is one of them');
  ok(rows.some(function (r) { return r.indexOf('10.0.0.0/24') !== -1; }), 'and the transit subnet the peer sent');
  // Alignment is checked here rather than in table-layout: that lab has no received prefixes, and a
  // table with no rows proves nothing. The header's first column is the status marker and is blank
  // there, so the row is one cell wider than the header's visible cells.
  for (const row of rows) {
    ok(row.length === 4, 'the row carries status, prefix, next hop and path: ' + row.join(' | '));
    ok(/^[*>]+$/.test(row[0]), 'with the status marker in its own column: ' + row[0]);
  }
}

console.log('\nThe status column follows the routing table, not a second opinion:');
{
  const env = lab();
  const body = text(env.sa.run('show ip bgp'));
  const rows = body.split('\n').filter(function (l) { return /^\s*[*>]+\s+\d/.test(l); });
  const far = rows.filter(function (l) { return /192\.168\.5\.0\/24/.test(l); })[0];
  const transit = rows.filter(function (l) { return /10\.0\.0\.0\/24/.test(l); })[0];
  ok(/^\s*\*>/.test(far), 'the far subnet is the row that forwards (*>)');
  ok(/^\s*\*\s/.test(transit), 'the transit subnet is only a candidate (*)');
  ok(/also connected here, which is closer than BGP/.test(body),
    'and the answer says why, naming the closer route');
  // The two views must agree row for row.
  const rib = text(env.sa.run('show ip route'));
  const ribRow = rib.split('\n').filter(function (l) { return /^\s*\*\s+B\s+192\.168\.5\.0\/24/.test(l); })[0];
  ok(!!ribRow, 'show ip route marks the same prefix as installed');
}

console.log('\nWhat is not modelled is said, not printed as zero:');
{
  const env = lab();
  const body = text(env.sa.run('show ip bgp'));
  ok(/Not modelled here: MED, local preference, weight and the origin attribute/.test(body),
    'the header names the attributes this engine does not have');
  ok(!/\bLocPrf\b/.test(body), 'and no column claims to show one');
  ok(!/\bWeight\b/.test(body), 'nor a weight');
}

console.log('\nOne prefix, with the reason it is or is not forwarding:');
{
  const env = lab();
  const best = text(env.sa.run('show ip bgp 192.168.5.0/24'));
  ok(/routing table entry for 192\.168\.5\.0\/24/.test(best), 'the entry is named');
  ok(/Received from\s+10\.0\.0\.2 \(AS 65002, eBGP\)/.test(best), 'with the peer and the session type');
  ok(/AS path\s+65002/.test(best), 'the AS path');
  ok(/Status\s+best/.test(best), 'and that it forwards');
  const lost = text(env.sa.run('show ip bgp 10.0.0.0/24'));
  ok(/Status\s+not installed/.test(lost), 'the candidate says it does not forward');
  ok(/connected route to 10\.0\.0\.0\/24 is closer/.test(lost), 'and names what beat it');
  // An address with no length is the longest match containing it, which is what an operator asks.
  ok(/routing table entry for 192\.168\.5\.0\/24/.test(text(env.sa.run('show ip bgp 192.168.5.7'))),
    'an address resolves to the longest match containing it');
}

console.log('\nA prefix that is not there is refused with the ones that are:');
{
  const env = lab();
  const gone = text(env.sa.run('show ip bgp 10.9.9.0/24'));
  ok(/not in the BGP table on R1/.test(gone), 'the absence is stated');
  ok(/The prefixes here are: 10\.0\.0\.0\/24, 192\.168\.5\.0\/24/.test(gone), 'with the ones present');
  const word = text(env.sa.run('show ip bgp bogus'));
  ok(/takes summary, neighbors or a prefix/.test(word), 'a word that is neither is refused by name');
  ok(/show ip bgp 192\.168\.5\.0\/24/.test(word), 'and the prefix form is shown');
}

console.log('\nAn empty table says why it is empty:');
{
  const t = new Topology();
  const a = t.addDevice(find('generic-router')); a.name = 'R1';
  const b = t.addDevice(find('generic-router')); b.name = 'R2';
  t.connect(a.id, 'Gi0/0', b.id, 'Gi0/0');
  const sim = new Simulator(t);
  const sa = new CliSession(a, t, sim); sa.run('enable'); sa.run('configure terminal');
  sa.run('interface Gi0/0'); sa.run('ip address 10.0.0.1 255.255.255.0'); sa.run('exit');
  sa.run('router bgp 65001'); sa.run('neighbor 10.0.0.9 remote-as 65002'); sa.run('exit'); sa.run('end');
  const body = text(sa.run('show ip bgp'));
  ok(/Network\s+Next Hop\s+Path/.test(body), 'the header is still there');
  ok(/no prefix has been received - 1 neighbour\(s\) configured, see "show ip bgp summary"/.test(body),
    'and the empty answer points at the view that says whether the peer is up');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
