'use strict';
// `show ip dhcp pool` printed a block this console invented (#fidelity: show ip dhcp pool layout).
//
// A real box prints a fixed set of labels - `Utilization mark (high/low)`, `Subnet size (first/next)`,
// `Total addresses`, `Leased addresses`, `Excluded addresses`, `Pending event` - over a one-row subnet
// table headed `Current index  IP address range  Leased/Excluded/Total`
// (research/show-ip-dhcp-pool-layout.md). This console printed `Network:`, `Range:`, `Default router:`,
// `DNS servers:`, `Lease:`, `Excluded:`, `Reservations:` and `In use:` - eight fields no router has, about
// a configuration that `show running-config` already prints.
//
// What is asserted here is the shape: the labels, their order, the colons in one column, the arithmetic of
// the three counts, and the one value that is a claim about allocation (`Current index`, `0.0.0.0` when the
// pool has nothing left).
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const dhcp = require('../engine/dhcp');
const { CliSession } = require('../engine/cli');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = require('path').join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /^ISR 4331$/.test(s.model); }) ||
  specs.find(function (s) { return /ISR 4331/.test(s.model); });
const HOST = specs.find(function (s) {
  return /^(pc|host|endpoint|workstation)/i.test(s.category || '') && s.model;
}) || specs.find(function (s) { return /endpoint|host|PC/i.test((s.category || '') + s.model); });

const MAC_A = '02:00:00:00:00:0a';
const MAC_B = '02:00:00:00:00:0b';

function lab(poolCmds) {
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  t.addDevice(HOST, 'h1');
  t.addDevice(HOST, 'h2');
  const firstFree = function (id) {
    return Array.from(t.getDevice(id).interfaces.keys()).filter(function (n) {
      return !/^(mgmt|console|aux)/i.test(n);
    })[0];
  };
  t.connect('r1', 'Gi0/0/1', 'h1', firstFree('h1'), { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('r1', 'Gi0/0/2', 'h2', firstFree('h2'), { mediaId: '1000base-t', speedMbps: 1000 });
  // Both server ports sit in the pool's subnet: a server answers for a pool only on an interface inside it.
  ['Gi0/0/1', 'Gi0/0/2'].forEach(function (name) {
    const port = t.getDevice('r1').interfaces.get(name);
    port.ip = '192.168.10.1'; port.mask = '255.255.255.0';
  });
  t.getDevice('h1').interfaces.get(firstFree('h1')).mac = MAC_A;
  t.getDevice('h2').interfaces.get(firstFree('h2')).mac = MAC_B;
  t.getDevice('h1').interfaces.get(firstFree('h1')).dhcp = true;
  t.getDevice('h2').interfaces.get(firstFree('h2')).dhcp = true;
  const s = new CliSession(t.getDevice('r1'), t, null);
  ['enable', 'configure terminal'].concat(poolCmds || []).forEach(function (c) { s.run(c); });
  return t;
}
const show = function (t, sim, cmd) {
  return ((new CliSession(t.getDevice('r1'), t, sim).run(cmd) || {}).output || []);
};
const POOL = ['ip dhcp pool lan', 'network 192.168.10.0 255.255.255.0', 'default-router 192.168.10.1',
  'dns-server 1.1.1.1', 'range 192.168.10.100 192.168.10.110', 'excluded-address 192.168.10.102',
  'lease 0 0 1', 'exit'];
const lineWith = function (lines, re) { return lines.filter(function (l) { return re.test(l); })[0] || ''; };
const valueOf = function (lines, label) {
  const head = ' ' + label;
  for (const line of lines) {
    if (line.slice(0, head.length) !== head) continue;
    const at = line.indexOf(': ');
    return at === -1 ? '' : line.slice(at + 2).trim();
  }
  return '';
};

// --- appended ---

console.log('');
console.log('The block a real box prints, label for label, in its order:');
{
  const t = lab(POOL);
  const lines = show(t, null, 'show ip dhcp pool lan');
  const labels = ['Utilization mark (high/low)', 'Subnet size (first/next)', 'Total addresses',
    'Leased addresses', 'Excluded addresses', 'Pending event'];
  ok(/^Pool lan :$/.test(lines[0]), 'the pool header carries the space IOS prints before the colon', lines[0]);
  const inOrder = labels.every(function (l, i) {
    return (lines[i + 1] || '').slice(0, l.length + 1) === ' ' + l;
  });
  ok(inOrder, 'six fields, in IOS order: ' + labels.join(', '), lines.slice(0, 8).join(' | '));
  const colons = lines.slice(1, 7).map(function (l) { return l.indexOf(':'); });
  ok(colons.every(function (c) { return c === colons[0]; }), 'and their colons sit in one column',
    JSON.stringify(colons));
  ok(valueOf(lines, 'Utilization mark (high/low)') === '100 / 0', 'the marks are the defaults every capture prints');
  ok(valueOf(lines, 'Subnet size (first/next)') === '0 / 0', 'no on-demand subnet, so 0 / 0');
  ok(valueOf(lines, 'Pending event') === 'none', 'and no pending event');
  ok(/^ 1 subnet is currently in the pool :$/.test(lines[7]), 'the subnet count line, singular for one', lines[7]);
  ok(/^ Current index\s+IP address range\s+Leased\/Excluded\/Total$/.test(lines[8]), 'the table header', lines[8]);
  ['Network:', 'Range:', 'Default router:', 'DNS servers:', 'Lease:', 'Reservations:', 'In use:'].forEach(function (f) {
    ok(lines.join('\n').indexOf(f) === -1, 'no invented field ' + f);
  });
}

console.log('');
console.log('The counts are the subnet, and they add up:');
{
  const t = lab(POOL);
  const lines = show(t, null, 'show ip dhcp pool lan');
  // A /24 has 254 usable addresses however narrow the range is. The eleven-address range leaves 243 outside it,
  // the exclusion removes one more, so 244 of the 254 are addresses this pool will never offer.
  ok(valueOf(lines, 'Total addresses') === '254', 'total is the subnet, not the range',
    valueOf(lines, 'Total addresses'));
  ok(valueOf(lines, 'Excluded addresses') === '244', 'excluded is everything the pool will not offer',
    valueOf(lines, 'Excluded addresses'));
  const row = lineWith(lines, /^ 192\.168/);
  ok(/192\.168\.10\.1 - 192\.168\.10\.254/.test(row), 'the row spans the usable range of the subnet', row);
  ok(/ 244 \/ 254$/.test(row), 'and the numbers are leased / excluded / total', row);

  // The same subnet with nothing excluded: the line is absent, which is what the captures show for a /24 pool
  // whose whole subnet is offerable.
  const whole = lab(['ip dhcp pool all', 'network 172.16.5.0 255.255.255.0',
    'range 172.16.5.1 172.16.5.254', 'exit']);
  const noExclusions = show(whole, null, 'show ip dhcp pool all');
  ok(valueOf(noExclusions, 'Total addresses') === '254', 'a whole-subnet pool still totals 254');
  ok(noExclusions.join('\n').indexOf('Excluded addresses') === -1,
    'and prints no Excluded addresses line, because it has none', noExclusions.join(' | '));
  ok(valueOf(noExclusions, 'Utilization mark (high/low)') === '100 / 0', 'the marks are still the defaults');
}

console.log('');
console.log('Current index is the address the server would offer next:');
{
  const t = lab(POOL);
  const sim = new Simulator(t);
  sim.runAtMs = 1000;
  sim.computeDhcp();
  const lines = show(t, sim, 'show ip dhcp pool lan');
  ok(valueOf(lines, 'Leased addresses') === '2', 'two clients hold addresses',
    valueOf(lines, 'Leased addresses'));
  const row = lineWith(lines, /^ 192\.168/);
  // .100 and .101 went out, .102 is excluded, so the next address the allocator would try is .103.
  ok(/^ 192\.168\.10\.103/.test(row), 'the index skips the leases and the exclusion, landing on .103', row);
  ok(/ 2 \/ 244 \/ 254$/.test(row), 'with both leases counted', row);

  // A pool with nothing left says so with 0.0.0.0 - the address a full pool does not have - rather than by
  // printing an address it would refuse.
  const small = lab(['ip dhcp pool two', 'network 192.168.10.0 255.255.255.0',
    'default-router 192.168.10.1', 'range 192.168.10.200 192.168.10.201', 'lease 0 0 1', 'exit']);
  const s2 = new Simulator(small);
  s2.runAtMs = 1000;
  s2.computeDhcp();
  const full = show(small, s2, 'show ip dhcp pool two');
  ok(/^ 0\.0\.0\.0\s+192\.168\.10\.1 - 192\.168\.10\.254\s+2 \/ 252 \/ 254$/.test(lineWith(full, /^ 0\.0\.0\.0/)),
    'an exhausted pool reads 0.0.0.0', full.join(' | '));
}

console.log('');
console.log('Nothing measured is not the same as nothing there:');
{
  const t = lab(POOL);
  const guess = show(t, null, 'show ip dhcp pool lan');
  ok(valueOf(guess, 'Leased addresses') === 'not measured (no simulation has run)',
    'with no simulation the lease count says it is not measured', valueOf(guess, 'Leased addresses'));
  ok(/ not measured \/ 244 \/ 254$/.test(lineWith(guess, /^ 192\.168/)),
    'and the row does not print a zero it did not observe');

  // A pool that cannot serve prints the reason and no row: an index and a lease count for a pool that answers
  // nothing would be a measurement of nothing.
  const broken = lab(['ip dhcp pool half', 'network 10.9.0.0 255.255.255.0', 'exit']);
  const lines = show(broken, null, 'show ip dhcp pool half');
  ok(/^% this pool is not serving yet: .*rangeStart and rangeEnd are required/.test(
    lineWith(lines, /^% this pool is not serving yet/)), 'a broken pool says why, on a % line',
    lines.join(' | '));
  ok(lineWith(lines, /^ Current index/) === '', 'and prints no table row it cannot fill');
}

console.log('');
console.log('Every pool, one after another:');
{
  const t = lab(POOL.concat(['ip dhcp pool guest', 'network 192.168.20.0 255.255.255.0',
    'range 192.168.20.10 192.168.20.20', 'exit']));
  const lines = show(t, null, 'show ip dhcp pool');
  const headers = lines.filter(function (l) { return /^Pool /.test(l); });
  ok(headers.length === 2 && headers[0] === 'Pool lan :' && headers[1] === 'Pool guest :',
    'both pools are named, in the order they were configured', JSON.stringify(headers));
  ok(valueOf(lines.slice(lines.indexOf('Pool guest :')), 'Total addresses') === '254',
    'and each carries its own counts');
}

console.log('');
console.log('The library states the same three numbers the console prints:');
{
  const p = dhcp.normalizePool({ name: 'lan', network: '192.168.10.0', mask: '255.255.255.0',
    rangeStart: '192.168.10.100', rangeEnd: '192.168.10.110',
    excluded: [{ start: '192.168.10.102', end: '192.168.10.102' }], leaseSec: 60 });
  const sum = dhcp.poolSummary(p, null);
  ok(sum.total === 254 && sum.excluded === 244 && sum.capacity === 10,
    'total 254, 10 offerable, 244 excluded', JSON.stringify(sum));
  ok(sum.index === '192.168.10.100', 'and the index is where allocation starts', sum.index);
  ok(dhcp.poolSummary(p, ['192.168.10.100', '192.168.10.101', '192.168.10.103']).index === '192.168.10.104',
    'taking addresses moves it past them');
  ok(dhcp.poolSummary(p, ['192.168.10.100']).index === '192.168.10.101', 'and not over the exclusion at .102');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
