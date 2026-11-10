'use strict';
// show-at.test.js — asking a state show about an instant.
//
// `show ip route at <ms>` landed first, because the route table is where "as last computed" hurts
// most. But the same question applies to every show whose answer is a product of the control
// planes: what was STP doing at t=0, who owned the VIP, had BGP come up? Those commands had no
// way to ask, so the only way to see a converged-out state was to catch it before running
// anything - which is not a query, it is a race.
//
// One implementation, in `CliSession._show()`: the trailing `at` is split off, the control planes
// are rebuilt at that instant through `Simulator.refreshControlPlanes()`, and the answer is
// labelled with the instant it describes. The table and docs forms share that path with `show ip
// route`, so they cannot drift apart.
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

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const model = (n) => catalog.find((x) => x.model === n);

// Three switches in a loop: STP has something to decide. Plus two routers for VRRP and BGP.
const t = new Topology();
const sw1 = t.addDevice(model('generic-switch'));
const sw2 = t.addDevice(model('generic-switch'));
const sw3 = t.addDevice(model('generic-switch'));
const r1 = t.addDevice(model('generic-router'));
const r2 = t.addDevice(model('generic-router'));
sw1.name = 'SW1'; sw2.name = 'SW2'; sw3.name = 'SW3'; r1.name = 'R1'; r2.name = 'R2';
t.connect(sw1.id, 'Fa0/1', sw2.id, 'Fa0/1');
t.connect(sw2.id, 'Fa0/2', sw3.id, 'Fa0/1');
t.connect(sw3.id, 'Fa0/2', sw1.id, 'Fa0/2');
t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
const sim = new Simulator(t);
function run(dev, cmds) {
  return runCommands(dev, t, sim, cmds).lines.filter(function (l) {
    // Prompts can carry a space: `Switch (L2)-d1#`. A filter that excludes space leaves the
    // prompt line in the compared text and every exact-string assertion fails for no reason.
    return !/^[A-Za-z0-9_.() -]+[>#]/.test(l);
  });
}
function cli(dev, cmds) { return run(dev, ['enable'].concat(cmds)).join('\n'); }
// Configuring from user exec is allowed here, but then `exit` returns to `>` - so a lab that
// builds config has to start at privileged exec, exactly like a transcript does.
function config(dev, cmds) { return run(dev, ['enable'].concat(cmds)); }

// The lab, in the order the engine requires: the OSPF process has to exist before an interface
// can join an area ("ip ospf area 0" is refused otherwise), and this engine's `router bgp` is a
// flat command - it does not open a sub-mode, so an `exit` after the neighbours leaves config
// entirely. Both of those are things a refused config line would hide.
const R1_CFG = ['enable', 'configure terminal',
  'ospf router-id 1.1.1.1', 'ospf area 0',
  'interface Gi0/0', 'ip address 10.0.12.1 255.255.255.0',
  'ip ospf area 0', 'vrrp 10 ip 10.0.12.254', 'vrrp 10 priority 120', 'exit',
  'router bgp 65001', 'bgp router-id 1.1.1.1', 'neighbor 10.0.12.2 remote-as 65002', 'exit'];
const R2_CFG = ['enable', 'configure terminal',
  'ospf router-id 2.2.2.2', 'ospf area 0',
  'interface Gi0/0', 'ip address 10.0.12.2 255.255.255.0',
  'ip ospf area 0', 'vrrp 10 ip 10.0.12.254', 'exit',
  'router bgp 65002', 'bgp router-id 2.2.2.2', 'neighbor 10.0.12.1 remote-as 65001', 'exit'];

// A refused config line leaves an empty table that looks exactly like a layout bug, so the build
// is checked before anything is asserted about the output.
{
  const refusals = [];
  for (const [dev, cmds] of [[r1, R1_CFG], [r2, R2_CFG]]) {
    for (const line of run(dev, cmds)) {
      if (/^%/.test(line) || /^  note:/.test(line)) refusals.push(line);
    }
  }
  ok(refusals.length === 0, 'the lab config is accepted in full, with no silent scope change' +
    (refusals.length ? ' (' + refusals.join('; ') + ')' : ''));
}

console.log('Spanning tree answers for an instant, and the answer changes:');
{
  const early = cli(sw1, ['show spanning-tree at 0']);
  match(/^STP at t=0 ms \(control planes rebuilt for this answer\)$/m, early,
    'the answer is labelled with the instant it describes');
  match(/listening/, early, 'at t=0 the ports are still listening');
  ok(!/forwarding/.test(early), 'nothing forwards yet');

  const settled = cli(sw1, ['show spanning-tree at converged']);
  match(/^STP at converged/m, settled, '"converged" is accepted');
  match(/forwarding/, settled, 'and after convergence the ports forward');
  ok(!/listening/.test(settled), 'so the two instants really differ');
}

console.log('\nVRRP answers for an instant:');
{
  const early = cli(r1, ['show vrrp at 0']);
  match(/^VRRP at t=0 ms/, early, 'the label names the instant');
  match(/Backup/, early, 'at t=0 the group is still a backup');
  // The note was reworded: it used to tell an operator to "run a simulation" while one was attached,
  // and at an instant before the election the honest statement is that the group has not converged.
  match(/no router holds the virtual address yet - the group has not converged/, early,
    'and nothing owns the virtual address');
  ok(!/00:00:5e:00:01:0a/.test(early), 'no virtual MAC exists yet');

  const settled = cli(r1, ['show vrrp at converged']);
  match(/Master/, settled, 'after the election this box is master');
  match(/00:00:5e:00:01:0a/, settled, 'and the virtual MAC is there');
}

console.log('\nA protocol with no timer gives the same answer at both instants - honestly:');
{
  // BGP establishes immediately in this model (there is no connect/hold timer to walk), so the
  // instant form is not a way to catch it mid-session. Saying so is the useful outcome: the label
  // reports the question, and identical answers are the truthful reply to it.
  const early = cli(r1, ['show ip bgp at 0']);
  const settled = cli(r1, ['show ip bgp at converged']);
  match(/^BGP at t=0 ms/, early, 'the early answer is labelled');
  match(/^BGP at converged/m, settled, 'and so is the converged one');
  const state = function (text) {
    const m = /10\.0\.12\.2\s+4\s+65002\s+(\S+)/.exec(text);
    return m ? m[1] : null;
  };
  eq(state(early), state(settled), 'both report the same neighbour state (' + state(early) + ')');
  eq(state(early), 'Established', 'which is Established, because BGP has no timer to be mid-way through');
}

console.log('\nThe learned tables can be asked too:');
{
  const arp = cli(r1, ['show arp at 0']);
  match(/^ARP at t=0 ms/m, arp, 'ARP is labelled');
  const mac = cli(sw1, ['show mac address-table at 0']);
  match(/^MAC table at t=0 ms/m, mac, 'the MAC table is labelled');
  const lldp = cli(r1, ['show lldp at 0']);
  match(/^LLDP at t=0 ms/m, lldp, 'LLDP is labelled');
  // `show lldp` is the device's own LLDP state (IOS's global view), so the neighbour shows up as a
  // count here and in the table one word further in - both rebuilt at the instant asked about.
  match(/Neighbours learned: 1/, lldp, 'and the rebuild announces LLDP like a boot does, so it learned one');
  match(/R2/, cli(r1, ['show lldp neighbors at 0']), 'and the neighbour is there in the table');
  const dhcp = cli(r1, ['show ip dhcp binding at 0']);
  match(/^DHCP at t=0 ms/m, dhcp, 'DHCP is labelled');
  const ospf = cli(r1, ['show ip ospf at converged']);
  match(/^OSPF at converged/m, ospf, 'OSPF is labelled, and the neighbour argument still works');
  match(/FULL/, ospf, 'with the adjacency the rebuild produced');
}

console.log('\nShows that are not control-plane products refuse the instant:');
{
  const out = cli(r1, ['show interfaces transceiver at 0']);
  match(/^% "interfaces transceiver at 0" does not take an instant$/m, out,
    'a physical show says no, and quotes what was asked');
  match(/Control-plane shows do:/, out, 'and names the ones that do');
  eq(cli(r1, ['show version at 5000']).split('\n')[0],
    '% "version at 5000" does not take an instant',
    'the same for show version, rather than silently ignoring the argument');
}

console.log('\nThe instant is validated wherever it appears:');
{
  eq(cli(sw1, ['show arp at']), '% Incomplete command: show arp at <ms>|converged',
    'a bare "at" is refused with the form that works');
  eq(cli(sw1, ['show arp at abc']), '% Invalid instant: abc', 'garbage is refused by name');
  eq(cli(sw1, ['show arp at -5']), '% Invalid instant: -5', 'and a negative instant too');
  const junk = cli(sw1, ['show arp at 0 junk']);
  match(/^% Unexpected argument after the instant: junk$/m, junk, 'a word after the instant is named');
  match(/^% Usage: show arp at <ms>\|converged$/m, junk, 'with the form that works');
}

console.log('\nWithout an instant, nothing changes:');
{
  const plain = cli(sw1, ['show spanning-tree']);
  ok(!/rebuilt for this answer/.test(plain), 'the plain form carries no label');
  ok(!/at t=/.test(plain), 'and no instant text');
  match(/Spanning tree enabled/, plain, 'it is the same table it always was');
}

console.log('\nThe help row offers four spellings, and all four work:');
{
  // `[at <ms>|converged]` reads as "at <ms>", "at converged", or just "converged" - and a bare
  // number is the same request. Only the `at` forms used to be parsed, so `show spanning-tree
  // converged` printed the table as last computed while looking like the answer to the question.
  const bare = cli(sw1, ['show spanning-tree converged']);
  match(/^STP at converged/m, bare, 'a bare "converged" is an instant, not a word to ignore');
  match(/forwarding/, bare, 'and it answers the question it looks like it is answering');
  const numbered = cli(sw1, ['show mac address-table 5000']);
  match(/^MAC table at t=5000 ms/m, numbered, 'so is a bare number');
  const atForm = cli(sw1, ['show spanning-tree at converged']);
  eq(atForm, bare, 'and the two spellings give the same answer');
  ok(!/rebuilt for this answer/.test(cli(sw1, ['show spanning-tree'])),
    'while the plain form still prints the table as last computed, unlabelled');
}

console.log('\nThe convention is discoverable:');
{
  const help = cli(sw1, ['?']);
  match(/also answers "at <ms>" or "at converged"/, help, 'help states the convention');
  match(/show ip route\|ospf\|bgp\|dhcp, show arp, show mac address-table/, help,
    'and lists which shows take it');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
