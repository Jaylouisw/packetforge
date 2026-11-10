'use strict';
// ipv6-interface.test.js — which IPv6 address is on which port, and where it came from.
//
// The IPv6 addressing question had no console answer at all: `show ip interface brief` is IPv4, and
// `show ipv6 nd` reports policy rather than state, so "what address does this port have, and did a
// human type it or did a router advertise it?" could only be answered by reading `show
// running-config` and knowing that a *missing* `ipv6 address` line means SLAAC. Provenance is the
// load-bearing column here: an autoconfigured address disappears when the advertisements stop, which
// is a different situation from a configured one, and nothing else in the console distinguishes them.
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
function match(re, text, msg) {
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text) + ')'));
}

function model(name) {
  const found = loadCatalog(path.join(__dirname, '..', 'devices')).find((x) => x.model === name);
  if (!found) throw new Error('no such model: ' + name);
  return found;
}

// R1 advertises 2001:db8:12::/64; PC1 autoconfigures from it. R1 also has a configured address on a
// second port and a third port shut down, so one answer carries all three provenances.
const t = new Topology();
const r1 = t.addDevice(model('generic-router'));
const pc1 = t.addDevice(model('generic-pc'));
r1.name = 'R1'; pc1.name = 'PC1';
t.connect(pc1.id, 'eth0', r1.id, 'Gi0/0');
const sim = new Simulator(t);

function raw(dev, cmds) {
  return runCommands(dev, t, sim, ['enable'].concat(cmds)).lines.filter(function (l) {
    return !/^[A-Za-z0-9_.() -]+[>#]/.test(l);
  });
}
function cli(dev, cmds) { return raw(dev, cmds).join('\n'); }

// Gi0/0 needs its own address: a router advertises a prefix on the interface that has one, so
// without it the host below would (correctly) never autoconfigure and this lab would prove nothing.
const rcfg = ['enable', 'configure terminal',
  'interface Gi0/0', 'ipv6 address 2001:db8:12::1/64', 'exit',
  'interface Gi0/1', 'ipv6 address 2001:db8:23::1/64', 'exit',
  'interface Gi0/2', 'shutdown', 'exit',
  'ipv6 nd ra enable', 'ipv6 nd prefix 2001:db8:12::/64', 'exit'];
ok(!runCommands(r1, t, sim, rcfg).lines.some((l) => /^%/.test(l)), 'the router config is accepted');
ok(!runCommands(pc1, t, sim, ['enable', 'configure terminal', 'interface eth0',
  'ipv6 address autoconfig', 'exit', 'exit']).lines.some((l) => /^%/.test(l)),
  'the host is told to autoconfigure');

function tableRows(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^ {2}(\S+) {2,}(\S.*?) {2,}(\S+) {2,}(\S+) {2,}(.+)$/.exec(line);
    if (m && m[1] !== 'Port') out.push({ port: m[1], state: m[2], addr: m[3], prefix: m[4], source: m[5] });
  }
  return out;
}

console.log('Every port is accounted for, with its state:');
{
  const out = cli(r1, ['show ipv6 interface']);
  const rows = tableRows(out);
  ok(rows.length >= 4, 'the answer has rows (' + rows.length + ')');
  eq(rows.filter((r) => r.port === 'Gi0/2')[0].state, 'administratively down',
    'a shut port says so, in the same words `show ip interfaces` uses');
  eq(rows.filter((r) => r.port === 'Gi0/2')[0].source, '-',
    'and a shut port claims no address at all');
  ok(rows.filter((r) => r.port === 'Gi0/0').every((r) => r.state === 'up'),
    'the up ports are up');
  const counts = out.split('\n').filter((l) => /^\d+ ports?, /.test(l))[0];
  match(/^3 ports, 2 with a global address/m, out, 'and the summary counts ports and addresses');
  ok(counts !== undefined, 'the summary line exists');
}

console.log('\nThe link-local address is shown, and it is derived rather than configured:');
{
  const rows = tableRows(cli(r1, ['show ipv6 interface']));
  const ll = rows.filter((r) => r.source === 'link-local');
  ok(ll.length >= 1, 'link-local rows exist');
  ok(ll.every((r) => /^fe80:/.test(r.addr)), 'and they are fe80:: addresses');
  ok(ll.every((r) => r.prefix === '-'), 'a link-local address has no prefix length');
  // Two ports on the same device must not share a link-local address.
  const addrs = ll.map((r) => r.addr);
  eq(new Set(addrs).size, addrs.length, 'no two ports report the same link-local address');
  ok(!/configured/.test(ll.map((r) => r.source).join('')),
    'and none of them is labelled as configured, because nobody typed it');
}

console.log('\nThe host has heard the advertisement by the time the table is printed:');
{
  // This used to need `at converged`: a plain show reported the state as last computed, so SLAAC
  // looked broken until something else had run. A reader now derives the planes it displays, so the
  // first question gets the same answer as the tenth - the address the router actually advertised.
  const plain = cli(pc1, ['show ipv6 interface']);
  ok(/2001:db8:12::/.test(plain), 'the first ask already shows the autoconfigured address');
  ok(!/no global address/.test(plain), 'and does not claim the host has none');
  ok(/autoconfig from/.test(plain), 'the provenance column names the router it heard');
  const atInstant = cli(pc1, ['show ipv6 interface at converged']);
  ok(/2001:db8:12::/.test(atInstant), 'and asking at an instant agrees with the plain ask');
}

console.log('\nProvenance is the column that matters:');
{
  const ofRouter = tableRows(cli(r1, ['show ipv6 interface']));
  eq(ofRouter.filter((r) => r.addr === '2001:db8:23::1')[0].source, 'configured',
    'an address a human typed is labelled configured');
  cli(pc1, ['show ipv6 interface at converged']);   // run the advertisement pass
  const ofHost = tableRows(cli(pc1, ['show ipv6 interface']));
  const self = ofHost.filter((r) => /^2001:db8:12::/.test(r.addr));
  ok(self.length === 1, 'the host has exactly one global address');
  eq(self[0].source, 'autoconfig from fe80::ff:fe00:0',
    'and it names the router that advertised it, not just "autoconfig"');
  eq(self[0].prefix, '64', 'with the advertised prefix length');
  match(/1 autoconfigured/, cli(pc1, ['show ipv6 interface']),
    'the summary counts autoconfigured addresses separately');
  // The address is not in the host's configuration, which is the whole point.
  const dump = raw(pc1, ['configure terminal', 'end', 'show running-config']).join('\n');
  match(/ipv6 address autoconfig/, dump, 'the dump carries the intent (autoconfig), not the address');
  ok(!dump.includes(self[0].addr),
    'and the autoconfigured address never appears in the configuration');
}

console.log('\nA host with no advertisement is told what to do next:');
{
  const t2 = new Topology();
  const silent = t2.addDevice(model('generic-router'));
  const waiting = t2.addDevice(model('generic-pc'));
  silent.name = 'R9'; waiting.name = 'PC9';
  t2.connect(waiting.id, 'eth0', silent.id, 'Gi0/0');
  const s2 = new Simulator(t2);
  runCommands(waiting, t2, s2, ['enable', 'configure terminal', 'interface eth0',
    'ipv6 address autoconfig', 'exit', 'exit']);
  const out = runCommands(waiting, t2, s2, ['enable', 'show ipv6 interface']).lines.join('\n');
  match(/no global address/, out, 'a waiting host says it has no global address');
  match(/Global addresses appear when a router advertisement arrives - see `show ipv6 nd`/, out,
    'and points at the command that explains why, instead of leaving a blank cell');
  // A router with no configured address is not given the host hint: it cannot wait for itself.
  const routerOut = runCommands(silent, t2, s2, ['enable', 'show ipv6 interface']).lines.join('\n');
  ok(!/router advertisement arrives/.test(routerOut),
    'a router with no IPv6 address gets no such hint, because nothing will advertise to it');
}

console.log('\nNaming one port answers about one port:');
{
  const one = cli(r1, ['show ipv6 interface Gi0/1']);
  const rows = tableRows(one);
  ok(rows.length >= 2, 'the single-port answer has the port\'s rows');
  ok(rows.every((r) => r.port === 'Gi0/1'), 'and no other port\'s rows, which is the point');
  match(/^1 port, 1 with a global address/m, one, 'the summary counts one port, not three');
  eq(cli(r1, ['show ipv6 interface bogus9']), '% No IPv6 port named bogus9 on R1',
    'an unknown port is refused by name');
  ok(!/Gi0\/0/.test(cli(r1, ['show ipv6 interface bogus9'])),
    'and the refusal does not print every port, which would look like an answer');
}

console.log('\nThe table is aligned, not hand-padded:');
{
  const out = cli(r1, ['show ipv6 interface']);
  const lines = out.split('\n').filter((l) => /^ {2}\S/.test(l));
  ok(lines.length >= 4, 'there are enough lines to check');
  // Every row must start each cell at the same offset as the header's cells.
  const header = lines[0];
  const starts = [];
  let prev = null;
  for (let i = 0; i < header.length; i++) {
    if (header[i] !== ' ' && (i === 0 || header[i - 1] === ' ')) starts.push(i);
  }
  for (const line of lines.slice(1)) {
    for (const s of starts) {
      ok(line[s] !== ' ' && line[s] !== undefined,
        'column at offset ' + s + ' is filled in: ' + JSON.stringify(line.slice(0, 40)));
    }
  }
}

console.log('\nIt composes with the instant, and says which instant it answered:');
{
  const out = cli(r1, ['show ipv6 interface at converged']);
  match(/^IPv6 interfaces at converged /m, out, 'the label names the instant');
  match(/Port +State +Address +Prefix +Source/, out, 'and the table is still the answer');
  // A router's addresses come from its configuration, so they are the same at every instant. That
  // is stated rather than glossed: the label reports the question, and an identical answer is the
  // honest reply. (The comparison is on the table body, since the label line is the only thing that
  // differs, and dropping it here would be hiding the part that is supposed to differ.)
  const bodyOf = (text) => text.split('\n').filter((l) => !/^IPv6 interfaces at /.test(l)).join('\n');
  eq(bodyOf(cli(r1, ['show ipv6 interface at 0'])), bodyOf(cli(r1, ['show ipv6 interface at converged'])),
    'a configured router advertises the same addresses at t=0 and at convergence');
}

console.log('\nThe command is discoverable:');
{
  match(/show ipv6 interface \[<port>\] \[at <ms>\|converged\]/, cli(r1, ['?']),
    'help lists the port and the instant');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
