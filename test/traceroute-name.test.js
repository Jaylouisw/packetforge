'use strict';
// `traceroute <name>` - the name the index row promised, and the target line a box prints for it (#1484).
//
// `help` has said `traceroute|tracert <address|name> [max <n>]` since the command landed, and the parser put the
// target through `net.isIp()`, so a name was refused as an invalid target before the resolver the lab already has
// was ever asked. `ping` has taken a name since #1375; the trace beside it in every ticket could not.
//
// What a Cisco-style box prints for a name is three lines longer than for an address, and the order is not
// obvious - the lookup is announced before "Type escape sequence to abort." and the resolved address appears on
// the target line in parentheses, after the name that was typed:
//
//   Router#traceroute google.com
//   Translating "google.com"...domain server (8.8.8.8) [OK]
//   Type escape sequence to abort.
//   Tracing the route to google.com (173.194.38.167)
//   1 59.90.253.1 16 msec 16 msec 12 msec
//
// The transcripts are pasted into research/traceroute-name-target.md.
//
// What this file locks:
//
//   1. the lookup line names the server that answered, by address, and carries [OK] only when one did;
//   2. it precedes "Type escape sequence to abort.", as `ping`'s does;
//   3. the target line is `Tracing the route to <name> (<address>)` - both, name first;
//   4. the hops are the same hops the address form walks, address for address and figure for figure;
//   5. an address still prints no lookup and no parentheses;
//   6. a name that does not resolve sends nothing, and says which failure it was.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.log('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) +
    ', got ' + JSON.stringify(actual) + ')');
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(model) { return catalog.find(function (x) { return x.model === model; }); }
const ROUTER = spec('generic-router');
const PC = spec('generic-pc');

// h1 -- r1 -- r2 -- srv, with r2 hosting the zone. Three hops, so a trace has a name for the destination and
// two intermediate addresses, and the hop lines are worth comparing.
function bench(zone) {
  const topo = new Topology();
  const h1 = topo.addDevice(PC, 'h1');
  const r1 = topo.addDevice(ROUTER, 'r1');
  const r2 = topo.addDevice(ROUTER, 'r2');
  const srv = topo.addDevice(PC, 'srv');
  topo.connect(h1.id, 'eth0', r1.id, 'Gi0/0');
  topo.connect(r1.id, 'Gi0/1', r2.id, 'Gi0/0');
  topo.connect(r2.id, 'Gi0/1', srv.id, 'eth0');
  const sim = new Simulator(topo);
  const cfg = function (dev, cmds) { runCommands(dev, topo, sim, ['enable', 'configure terminal'].concat(cmds)); };
  cfg(h1, ['interface eth0', 'ip address 10.0.1.10 255.255.255.0', 'exit',
    'ip default-gateway 10.0.1.1', 'ip name-server 10.0.2.2', 'exit']);
  cfg(r1, ['interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0', 'exit', 'ip routing',
    'ip route 10.0.9.0 255.255.255.0 10.0.2.2']);
  cfg(r2, ['interface Gi0/0', 'ip address 10.0.2.2 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.9.1 255.255.255.0', 'exit', 'ip routing',
    'ip route 10.0.1.0 255.255.255.0 10.0.2.1']);
  cfg(srv, ['interface eth0', 'ip address 10.0.9.9 255.255.255.0', 'exit',
    'ip default-gateway 10.0.9.1', 'exit']);
  if (zone !== false) {
    cfg(r2, ['dns zone lab', 'dns add srv A 10.0.9.9', 'dns add txt-only TXT hello', 'exit']);
  }
  return { topo: topo, sim: sim, h1: topo.getDevice('h1') };
}

function trace(b, cmd) {
  const s = new CliSession(b.h1, b.topo, b.sim);
  s.run('enable');
  return (s.run(cmd) || { output: [] }).output || [];
}

const b = bench();
const byName = trace(b, 'traceroute srv.lab');
const byAddr = trace(b, 'traceroute 10.0.9.9');

section('A trace by name announces the lookup, and where it went');
eq(byName[0], 'Translating "srv.lab"...domain server (10.0.2.2) [OK]',
  'the first line is the lookup, naming the server that answered, by address');
ok(byName.indexOf('Type escape sequence to abort.') > 0, 'and it precedes "Type escape sequence to abort."',
  byName.join('\n'));
ok(byName.join('\n').indexOf('srv.lab -> ') === -1, 'no invented name-to-address line', byName.join('\n'));

section('The target line carries the name and the address, in that order');
eq(byName[2], 'Tracing the route to srv.lab (10.0.9.9)',
  'the target line is `Tracing the route to <name> (<address>)`');

section('A trace by name is the same trace as by address');
const bodyByName = byName.slice(3);
const bodyByAddr = byAddr.slice(2);
eq(bodyByName.join('\n'), bodyByAddr.join('\n'),
  'every hop line, figure and verdict is the same whichever name the target was given by');
ok(bodyByName.length >= 3, 'the trace actually walked hops (r1, r2, srv)', bodyByName.join('\n'));
ok(bodyByName[bodyByName.length - 1].indexOf('10.0.9.9') !== -1,
  'the last hop is the destination it resolved to', bodyByName[bodyByName.length - 1]);
ok(byName.join('\n').indexOf('destination not reached') === -1, 'and the trace reached it');

section('An address is still an address');
eq(byAddr[0], 'Type escape sequence to abort.', 'an address prints no lookup line first');
eq(byAddr[1], 'Tracing the route to 10.0.9.9', 'and no parentheses on the target line');

section('The alias resolves the same way, and a typo is not a name');
const byAlias = trace(b, 'tracert srv.lab');
eq(byAlias[0], 'Translating "srv.lab"...domain server (10.0.2.2) [OK]', '`tracert` takes a name too');
eq(byAlias[2], 'Tracing the route to srv.lab (10.0.9.9)', 'and prints the same target line');
const typo = trace(b, 'traceroute 10.0.9.999');
eq(typo.join('\n'),
  '% Invalid traceroute target: 10.0.9.999 (not an IPv4 address, and not a name that could resolve)',
  'digits and dots that are not an address are refused as a typo, exactly as `ping` refuses them');
const none = trace(b, 'traceroute');
eq(none.join('\n'), '% Invalid traceroute target: (none)', 'no target is still refused');

section('A name that does not resolve sends nothing, and says which failure it was');
const nx = trace(b, 'traceroute nope.lab');
eq(nx[0], 'Translating "nope.lab"...domain server (10.0.2.2)',
  'the lookup line is still printed - it is what was asked and where - but with no [OK]');
ok(/^% Could not resolve "nope\.lab": NXDOMAIN - /.test(nx[1]), 'the verdict is the resolver\'s, not a trace', nx[1]);
ok(/^% Nothing was sent\. /.test(nx[2]), 'and nothing was sent', nx[2]);
ok(nx.join('\n').indexOf('Tracing the route to') === -1, 'no target line, and no hops, are invented');
ok(nx.join('\n').indexOf('Type escape sequence to abort.') === -1,
  'a box does not offer to abort a trace it never started', nx.join('\n'));
const nodata = trace(b, 'traceroute txt-only.lab');
ok(/^% Could not resolve "txt-only\.lab": NODATA - the name exists on 10\.0\.2\.2 but has no A record$/
  .test(nodata[1]), 'a name with only a TXT record is NODATA, and the server that holds it is named', nodata[1]);

section('A lab with no zone at all is a resolver failure, not a trace of zero hops');
const empty = bench(false);
const servfail = trace(empty, 'traceroute srv.lab');
ok(/% Could not resolve "srv\.lab": SERVFAIL/.test(servfail.join('\n')),
  'SERVFAIL is reported as the resolver\'s failure', servfail.join('\n'));
ok(servfail.join('\n').indexOf('Tracing the route to') === -1, 'and no trace is printed', servfail.join('\n'));

section('An IPv6 literal is an address this walk cannot take');
const v6 = trace(b, 'traceroute 2001:db8::1');
eq(v6.join('\n'), '% Invalid traceroute target: 2001:db8::1 (this console traces IPv4 paths only)',
  'it is refused as an IPv4-only walk, not sent to the resolver as a name');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;

