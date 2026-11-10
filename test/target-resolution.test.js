'use strict';
// target-resolution.test.js — a destination is resolved, and an argument is validated.
//
// Three defects in one neighbourhood, all of the same shape: the console answered a
// question nobody asked.
//
//   * `ping <hostname>` was refused outright — `% Invalid ping target: www.lab.test` —
//     while docs/CLI.md described the nslookup resolver path as "the same one `ping
//     <name>` uses". The promise existed; the code did not.
//   * `ping 10.0.2.20 count abc` (also `count 0`, `count -3`) silently sent **four**,
//     because a count that failed `parseInt` was dropped rather than refused.
//   * `converge abc` meant "no instant" and `converge -1` meant "1 ms before power-on",
//     so both printed a table with confident-looking (pending) marks.
//
// The resolver is shared with nslookup, so the two cannot disagree about a name.
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
const match = function (re, text, msg) {
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text) + ')'));
};

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const model = (n) => catalog.find((x) => x.model === n);

// PC1 -- R1 -- WEB, with WEB authoritative for lab.test and PC1 told to ask it.
const t = new Topology();
const pc = t.addDevice(model('generic-pc'));
const r1 = t.addDevice(model('generic-router'));
const srv = t.addDevice(model('generic-server'));
pc.name = 'PC1'; r1.name = 'R1'; srv.name = 'WEB';
t.connect(pc.id, 'eth0', r1.id, 'Gi0/0');
t.connect(r1.id, 'Gi0/1', srv.id, 'eth0');
const sim = new Simulator(t);
function run(dev, commands) { return runCommands(dev, t, sim, commands).lines; }
function cli(dev, cmd) {
  return run(dev, ['enable', cmd]).filter(function (l) {
    return !/[>#](enable|show\b|ping\b|traceroute\b|flow\b|converge|nslookup|\$)/.test(l);
  });
}

run(pc, ['configure terminal', 'interface eth0', 'ip address 10.0.1.10 255.255.255.0',
  'exit', 'ip default-gateway 10.0.1.1', 'ip dns server 10.0.2.20']);
run(r1, ['configure terminal', 'interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0',
  'exit', 'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0']);
run(srv, ['configure terminal', 'interface eth0', 'ip address 10.0.2.20 255.255.255.0',
  'exit', 'ip default-gateway 10.0.2.1',
  'dns zone lab.test', 'dns add www.lab.test A 10.0.2.20']);

console.log('A name is resolved, and the console says how:');
{
  const lines = cli(pc, 'ping www.lab.test count 1');
  match(/^Translating "www\.lab\.test"\.\.\.domain server \(WEB\)$/, lines[0],
    'the translation line names the server that answered: ' + lines[0]);
  match(/Sending 1, 100-byte ICMP Echos to 10\.0\.2\.20/, lines[2],
    'and the echo goes to the address, not the name');
  match(/^!$/, lines[3], 'the ping succeeds once the name is resolved');

  // An address is already an answer: no translation line, no DNS involved.
  const literal = cli(pc, 'ping 10.0.2.20 count 1');
  eq(literal[0], 'Type escape sequence to abort.', 'an address needs no translation line');
}

console.log('\nThe same name resolves the same way in every command that takes one:');
{
  const tr = cli(pc, 'traceroute www.lab.test');
  match(/^Translating "www\.lab\.test"\.\.\.domain server \(WEB\)$/, tr[0], 'traceroute translates too');
  match(/Tracing the route to 10\.0\.2\.20/, tr[2], 'and traces to the address');

  const flow = cli(pc, 'flow open www.lab.test port 80');
  match(/^Flow flow-\d+ opened: tcp 10\.0\.1\.10:\d+ -> 10\.0\.2\.20:80/, flow[0],
    'a flow opens to the resolved address: ' + flow[0]);

  // The invariant: the resolver the CLI uses is the one nslookup documents.
  const nsl = cli(pc, 'nslookup www.lab.test').join('\n');
  match(/10\.0\.2\.20/, nsl, 'nslookup agrees about the address');
}

console.log('\nA name that does not exist says whose answer it was:');
{
  const lines = cli(pc, 'ping nosuch.lab.test count 1');
  eq(lines.length, 1, 'one line, no half-started ping');
  match(/^% Unknown host nosuch\.lab\.test: NXDOMAIN from WEB$/, lines[0],
    'an NXDOMAIN is quoted with the server that gave it: ' + lines[0]);

  // Two failures that used to be reported as one. A name inside a zone the lab really
  // serves is an authoritative denial; a name outside every zone is nobody's to deny, and
  // saying "NXDOMAIN from WEB" would accuse a server of refusing a domain it never held.
  const outOfZone = cli(pc, 'ping nothing.example');
  eq(outOfZone[0], '% Unknown host nothing.example: no DNS server in this lab hosts a zone for it',
    'a name outside every hosted zone is reported as unserved, not denied');

  const inZone = cli(pc, 'ping nowww.lab.test count 1');
  eq(inZone[0], '% Unknown host nowww.lab.test: NXDOMAIN from WEB',
    'and a name inside a served zone is a real NXDOMAIN');

  // R1 has no "ip dns server", but a lab falls back to any device hosting the zone - so
  // the same name answers from there too, which is why the fallback is documented.
  const lonely = cli(r1, 'ping www.lab.test count 1');
  match(/^Translating "www\.lab\.test"\.\.\.domain server \(WEB\)$/, lonely[0],
    'a device with no resolver configured still reaches a server that hosts the zone: ' + lonely[0]);
}

console.log('\nA malformed address is malformed, not an unknown host:');
{
  for (const bad of ['999.1.1.1', '10.0.0.999']) {
    eq(cli(pc, 'ping ' + bad)[0], '% Invalid ping target: ' + bad,
      'ping calls ' + bad + ' an invalid target');
    eq(cli(pc, 'traceroute ' + bad)[0], '% Invalid traceroute target: ' + bad,
      'and so does traceroute');
    eq(cli(pc, 'flow open ' + bad)[0], '% Invalid destination: ' + bad,
      'and so does flow open');
  }
}

console.log('\nA count is a count, or it is refused:');
{
  for (const bad of ['abc', '0', '-3', '2.5']) {
    const lines = cli(pc, 'ping 10.0.2.20 count ' + bad);
    eq(lines.length, 1, '"count ' + bad + '" stops before printing anything');
    eq(lines[0], '% count expects a whole number of at least 1 (got ' + bad + ')',
      'and says what it wanted');
  }
  const bare = cli(pc, 'ping 10.0.2.20 count');
  eq(bare[0], '% count expects a whole number of at least 1 (got (none))',
    'a keyword with no value is refused too');

  ok(/Sending 2, /.test(cli(pc, 'ping 10.0.2.20 count 2')[1]), 'count 2 sends 2');
  ok(/Sending 3, /.test(cli(pc, 'ping 10.0.2.20 3')[1]), 'and so does the bare IOS form "ping <ip> 3"');
  ok(/Sending 4, /.test(cli(pc, 'ping 10.0.2.20')[1]), 'no count still means four');

  const junk = cli(pc, 'ping 10.0.2.20 nonsense');
  eq(junk[0], '% Unrecognised argument "nonsense" (expected count <n> or at <ms>)',
    'an unknown trailing word is named, not ignored');
}

console.log('\nconverge validates its instant instead of coercing it:');
{
  const t2 = new Topology();
  const a = t2.addDevice(model('generic-router'));
  const b = t2.addDevice(model('generic-router'));
  a.name = 'R1'; b.name = 'R2';
  t2.connect(a.id, 'Gi0/0', b.id, 'Gi0/0');
  const sim2 = new Simulator(t2);
  const go = function (cmd) {
    return runCommands(a, t2, sim2, ['enable', cmd]).lines.filter(function (l) {
      return !/[>#](enable|converge|\$)/.test(l);
    });
  };
  runCommands(a, t2, sim2, ['configure terminal', 'interface Gi0/0',
    'ip address 10.0.0.1 255.255.255.0', 'exit', 'ospf router-id 1.1.1.1', 'ospf area 0']);
  runCommands(b, t2, sim2, ['configure terminal', 'interface Gi0/0',
    'ip address 10.0.0.2 255.255.255.0', 'exit', 'ospf router-id 2.2.2.2', 'ospf area 0']);

  eq(go('converge abc')[0], '% Invalid instant: abc', 'garbage is refused by name');
  eq(go('converge -1')[0], '% Invalid instant: -1', 'and so is a negative instant');
  eq(go('converge at 1000')[0],
    '% converge takes a bare instant: converge <ms>|converged (not "at <ms>")',
    'the "at" keyword is refused with the form that works');

  const early = go('converge 1000');
  match(/\(pending\)/, early.join('\n'), 'a real instant still marks what is pending');
  const settled = go('converge converged');
  ok(!/\(pending\)/.test(settled.join('\n')), 'and "converged" still means everything is done');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
