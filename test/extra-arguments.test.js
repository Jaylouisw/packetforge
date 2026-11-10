'use strict';
// extra-arguments.test.js — an argument the command does not use is refused by name.
//
// Ignoring it is indistinguishable from honouring it, and this console has been bitten by that five
// times: nine shows that ignored a port, an instant read as a destination, `ping at 5000` that asked
// DNS about `at`, `show vlan 99` that printed every VLAN, and `converge 100 extra` that converged
// anyway. Every one of them looked like an answer, which is why nobody noticed.
//
// The rule now has one wording (`_noExtra` in engine/cli.js): a command's own tail either narrows the
// answer or is refused, and the refusal quotes the synopsis so the operator can see what is allowed.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });

// A switch with three VLANs (two carrying ports, one configured and empty) and a live flow between
// two hosts in the same VLAN, so every narrowing below has a wrong answer available to print.
//
// One CliSession for the whole setup on purpose: `runCommands()` opens a fresh session per call, so
// mode never carries over and a config built through it silently configures nothing - which is
// exactly what made the first draft of this lab look like an engine bug.
function build() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  const mk = function (name, addr) {
    const pc = t.addDevice(catalog.find(function (s) { return s.model === 'generic-pc'; }));
    pc.name = name;
    return pc;
  };
  const pc1 = mk('PC1'), pc2 = mk('PC2'), pc3 = mk('PC3');
  t.connect(pc1.id, 'eth0', sw.id, 'Fa0/1');
  t.connect(pc2.id, 'eth0', sw.id, 'Fa0/2');
  t.connect(pc3.id, 'eth0', sw.id, 'Fa0/3');
  const sim = new Simulator(t);
  const session = new CliSession(sw, t, sim);
  const s = function (cmd) { return session.run(cmd).output; };
  s('enable');
  s('configure terminal');
  for (const [port, vlan] of [['Fa0/1', '10'], ['Fa0/2', '10'], ['Fa0/3', '20']]) {
    s('interface ' + port);
    s('switchport mode access');
    s('switchport access vlan ' + vlan);
    s('exit');
  }
  s('vlan 30');          // configured, and nothing in it - a real answer, not an empty cell
  s('end');
  // A host's address lives on the port, not at global config: `configure terminal` then
  // `interface eth0` then `ip address`. Set at global scope it is refused, which looks like a
  // missing feature rather than a missing mode.
  const cfg = function (pc, addr) {
    const ps = new CliSession(pc, t, sim);
    ps.run('enable');
    ps.run('configure terminal');
    ps.run('interface eth0');
    ps.run('ip address ' + addr + ' 255.255.255.0');
    ps.run('end');
  };
  cfg(pc1, '10.0.0.1');
  cfg(pc2, '10.0.0.2');
  cfg(pc3, '10.0.20.3');
  // UDP, because a `generic-pc` listens on nothing: a TCP flow to port 80 is refused with
  // "nothing listening", which is the engine being right and the lab being wrong.
  const host = new CliSession(pc1, t, sim);
  host.run('enable');
  host.run('flow open 10.0.0.2 port 53 proto udp bytes 600');
  // `cli()` answers from the switch in enable mode, leaving configuration between calls.
  const cli = function (cmd) { s('end'); return s(cmd); };
  return { t: t, sw: sw, sim: sim, cli: cli, s: s };
}

console.log('\nA tail the command does not use is refused, not dropped:');
{
  const l = build();
  const cases = [
    ['show flows counters 99', 'show flows counters'],
    ['show flows 1 extra', 'show flows <id>'],
    ['converge 100 extra', 'converge [<ms>|converged]'],
    ['show ip route connected extra', 'show ip route connected'],
    ['show ip route summary extra', 'show ip route summary'],
    ['show vlan 10 20', 'show vlan [<id>|brief]']
  ];
  for (const [cmd, usage] of cases) {
    const out = l.cli(cmd).join('\n');
    ok(/^% Unexpected argument/m.test(out), cmd + ' is refused');
    ok(out.indexOf('% Usage: ' + usage) !== -1, cmd + ' quotes its own synopsis');
  }
  // And the forms that must keep working.
  ok(/^Flow counters/.test(l.cli('show flows counters')[0]), 'show flows counters alone still answers');
  ok(/^Flow flow-1/.test(l.cli('show flows 1')[0]), 'show flows <id> alone still answers');
  ok(/% Unexpected argument/.test(l.cli('show spanning-tree at 100 extra').join('\n')),
    'the pre-existing instant form keeps refusing a tail too');
}

console.log('\nshow vlan <id> narrows, and says what it could not find:');
{
  const l = build();
  const all = l.cli('show vlan');
  ok(all.length >= 4, 'the unfiltered table lists VLANs (' + all.length + ' lines)');
  const ten = l.cli('show vlan 10');
  ok(ten.some(function (row) { return /^10\s/.test(row); }), 'show vlan 10 has the VLAN 10 row');
  ok(!ten.some(function (row) { return /^20\s/.test(row); }), 'and not the VLAN 20 row');
  ok(!ten.some(function (row) { return /no ports/.test(row); }), 'VLAN 10 has ports, so it does not say (no ports)');
  // A configured VLAN with nothing in it is a real answer.
  const empty = l.cli('show vlan 30').join('\n');
  ok(empty.split('\n').some(function (row) { return /^30\s/.test(row) && /\(no ports\)$/.test(row); }),
    'a configured empty VLAN says (no ports) instead of printing an empty cell');
  const missing = l.cli('show vlan 99').join('\n');
  ok(/^% No VLAN 99 on SW1/.test(missing), 'an unknown VLAN is refused by name');
  // Two different facts: VLANs a port carries, and VLANs that were declared but carry nothing.
  // Folding them together would either hide the declaration or claim it exists as a real segment.
  ok(/Carried VLANs: 1, 10, 20; configured but empty: 30/.test(missing),
    'and the refusal separates carried VLANs from configured-but-empty ones');
  const word = l.cli('show vlan abc').join('\n');
  ok(/^% Invalid VLAN id "abc"/.test(word), 'a word is refused as a word, not looked up');
  ok(!/VLAN  Name/.test(word), 'and no table is printed for it');
  // The documented synonym and the IOS spelling both keep working, because adding an argument must
  // not take away a form the docs already promised.
  ok(l.cli('show vlan brief').length === all.length, 'show vlan brief is still the whole table');
  ok(l.cli('show vlan id 10').join('\n').split('\n').some(function (r) { return /^10\s/.test(r); }),
    'show vlan id 10 is the same question as show vlan 10');
  ok(/^% Incomplete command: show vlan id <id>/.test(l.cli('show vlan id').join('\n')),
    'show vlan id with no value is incomplete, not a lookup for the word "id"');
}

console.log('\nshow logging last takes the spelling of a count:');
{
  const l = build();
  l.cli('ping 10.0.0.2 count 1');
  for (const bad of ['0x10', '1e3', '+2', '1.5', '0', '-2', 'abc', '']) {
    const out = l.cli('show logging last' + (bad ? ' ' + bad : '')).join('\n');
    ok(/positive whole number of events/.test(out) && !/Event log/.test(out),
      'last ' + JSON.stringify(bad) + ' is refused rather than guessed');
  }
  const three = l.cli('show logging last 3').join('\n');
  ok(/Event log \(last 3 of \d+ events\)/.test(three), 'last 3 shows three events');
  ok(/last 3 of/.test(three) && three.split('\n').filter(function (x) { return /^\s+\d+\s+\d+\s/.test(x); }).length === 3,
    'and exactly three rows, so the count is honoured and not merely echoed');
}

console.log('\nA flow id has a shape, and both doors agree on it:');
{
  const l = build();
  const detail = l.cli('show flows 1').join('\n');
  ok(/^Flow flow-1/.test(detail), 'show flows 1 resolves to flow-1');
  const closed = l.cli('flow close 1').join('\n');
  ok(/^Flow flow-1 closed/.test(closed), 'flow close 1 closes flow-1');
  ok(/already closed/.test(l.cli('flow close flow-1').join('\n')),
    'and flow close flow-1 finds it already closed - the same flow, two spellings');
  for (const bad of ['abc', 'flow-abc', '1.5']) {
    ok(/^% Invalid flow id/.test(l.cli('show flows ' + bad).join('\n')), 'show flows ' + bad + ' is an invalid id');
    ok(/^% Invalid flow id/.test(l.cli('flow close ' + bad).join('\n')), 'flow close ' + bad + ' is an invalid id');
  }
  ok(/^% No flow flow-9 in this lab/.test(l.cli('show flows 9').join('\n')),
    'a well-shaped id that is not in the lab is still "no flow", not "invalid"');
}

console.log('\nThe ports were already strict - this pins them against regression:');
{
  const l = build();
  for (const cmd of ['show arp Fa0/1 zzz', 'show interfaces counters Fa0/1 zzz',
    'show mac address-table interface Fa0/1 zzz', 'show lldp neighbors Fa0/1 zzz',
    'show spanning-tree Fa0/1 zzz', 'clear counters Fa0/1 zzz']) {
    const out = l.cli(cmd).join('\n');
    ok(/^%/.test(out.trim()), cmd + ' is refused');
    ok(!/VLAN  Name|Interface  IP-Address/.test(out), cmd + ' does not print a table anyway');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
