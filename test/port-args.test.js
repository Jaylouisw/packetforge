'use strict';
// port-args.test.js — every show command that takes a port answers about *that port*, or says why not.
//
// This is the third time this console has had the same defect. `show interfaces ether1` accepted the
// argument and printed all 36 lines (wake 24); `show ipv6 interface sfp-sfpplus1` refused a spelling the
// config parser accepted (wake 39); and five commands added in between — `show ip interface brief`,
// `show spanning-tree`, `show lldp neighbors`, `show arp`, `show mac address-table` — took the port and
// dropped it on the floor. Printing the whole table in answer to a question about one port is worse
// than refusing: it *looks* like an answer.
//
// So the invariant, stated once and swept for every command:
//
//   a port argument either narrows the answer, or is refused by name - it is never ignored.
//
// That formulation is deliberately shape-independent. It does not care how many rows a lab happens to
// have, which device family is being asked, or whether the port is bridged; it only refuses to let an
// argument vanish. The second half is spelling equality: whatever the config parser accepts, the show
// commands accept, because two opinions about what a port is called is the bug, not the feature.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : '\n      got: ' + JSON.stringify(actual) +
    '\n      want: ' + JSON.stringify(expected)));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}
function model(m) {
  const s = catalog.find(function (x) { return x.model === m; });
  if (!s) throw new Error('missing model ' + m);
  return s;
}

// Every show command with a port slot. Kept as data so adding a command means adding one line - and
// so a reader can see the whole surface in one place instead of trusting that a sweep found it.
const PORT_COMMANDS = [
  'show interfaces',
  'show interfaces transceiver',
  'show ipv6 interface',
  'show ip interface brief',
  'show arp',
  'show mac address-table',
  'show spanning-tree',
  'show lldp neighbors',
  'show power inline'
];

// The console echoes every line it was given, prompt included. An answer is what follows, so the
// echo is dropped here - otherwise two runs that differ only in the command they typed look different,
// and a spelling-equality assertion would be comparing the question instead of the answer.
function answer(dev, t, sim, cmds) {
  return runCommands(dev, t, sim, ['enable'].concat(cmds)).lines.filter(function (l) {
    return !/^[^\s#>]+[#>]\s?/.test(l);
  });
}
function run(dev, t, sim, cmds) {
  return answer(dev, t, sim, cmds).join('\n');
}

// --- Lab A: a MikroTik, whose front panel and console disagree about port names -------------------
function routerLab() {
  const t = new Topology();
  const mt = t.addDevice(spec('mikrotik', 'CCR1009-7G-1C-1S+'));
  const h1 = t.addDevice(model('generic-pc'));
  const h2 = t.addDevice(model('generic-pc'));
  mt.name = 'MT1'; h1.name = 'H1'; h2.name = 'H2';
  t.connect(h1.id, 'eth0', mt.id, 'eth1');
  t.connect(h2.id, 'eth0', mt.id, 'eth2');
  const sim = new Simulator(t);
  runCommands(mt, t, sim, ['configure terminal',
    'interface eth1', 'ip address 10.9.9.1 255.255.255.0', 'exit',
    'interface eth2', 'ip address 10.9.10.1 255.255.255.0', 'exit', 'exit']);
  // Two hosts on two ports, so the ARP cache has one entry per port and a filter has something to
  // remove - a one-entry table would make "narrowed" indistinguishable from "unchanged".
  runCommands(h1, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.9.9.2 255.255.255.0', 'exit', 'exit']);
  runCommands(h2, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.9.10.2 255.255.255.0', 'exit', 'exit']);
  runCommands(mt, t, sim, ['enable', 'ping 10.9.9.2 count 1', 'ping 10.9.10.2 count 1']);
  return { t: t, sim: sim, dev: mt, h1: h1, h2: h2 };
}

// --- Lab B: a small network with something to say, so filters have rows to remove -----------------
// A loop (two links between two switches) gives spanning-tree something to block, a host pair gives
// ARP and MAC entries, LLDP fills itself, and two powered devices give PoE rows.
function networkLab() {
  const t = new Topology();
  const sw1 = t.addDevice(spec('aruba', 'CX 6000 24G CL4 PoE 4SFP 370W'));
  const sw2 = t.addDevice(spec('aruba', 'CX 6000 24G CL4 PoE 4SFP 370W'));
  const pc1 = t.addDevice(model('generic-pc'));
  const pc2 = t.addDevice(model('generic-pc'));
  const pd1 = t.addDevice(spec('ubiquiti', 'UCG-Ultra'));
  sw1.name = 'SW1'; sw2.name = 'SW2'; pc1.name = 'PC1'; pc2.name = 'PC2'; pd1.name = 'PD1';
  t.connect(pc1.id, 'eth0', sw1.id, '1/1/3');
  t.connect(pc2.id, 'eth0', sw2.id, '1/1/3');
  t.connect(sw1.id, '1/1/5', sw2.id, '1/1/5');
  t.connect(sw1.id, '1/1/6', sw2.id, '1/1/6');
  t.connect(pd1.id, 'port1', sw1.id, '1/1/9');
  const sim = new Simulator(t);
  const cfg = [
    'configure terminal',
    'hostname SW1',
    'interface vlan 1', 'ip address 10.0.0.1/24', 'exit',
    'exit'
  ];
  runCommands(sw1, t, sim, cfg);
  runCommands(sw2, t, sim, ['configure terminal', 'hostname SW2', 'interface vlan 1',
    'ip address 10.0.0.2/24', 'exit', 'exit']);
  runCommands(pc1, t, sim, ['configure terminal', 'interface eth0', 'ip address 10.0.0.10/24',
    'exit', 'exit']);
  runCommands(pc2, t, sim, ['configure terminal', 'interface eth0', 'ip address 10.0.0.11/24',
    'exit', 'exit']);
  // Traffic, so ARP and the MAC table have entries that a filter can remove. The switch's own ARP
  // cache is filled by asking *it* to reach a host - a PC pinging another PC never touches it.
  runCommands(pc1, t, sim, ['ping 10.0.0.11 count 2']);
  runCommands(sw1, t, sim, ['enable', 'ping 10.0.0.11 count 1']);
  return { t: t, sim: sim, sw1: sw1, sw2: sw2, pc1: pc1, pc2: pc2, pd1: pd1 };
}

// Which lab each command is swept in, and on which port. `show arp` is the odd one out because a
// switch has no routed port in this model - its entries live on the router that has hosts behind it.
const SWEEP = PORT_COMMANDS.map(function (cmd) {
  return cmd === 'show arp'
    ? { cmd: cmd, lab: 'router', port: 'eth1' }
    : { cmd: cmd, lab: 'network', port: '1/1/3' };
});

console.log('A port argument narrows the answer, or is refused by name - never ignored:');
{
  const net = networkLab();
  const rtr = routerLab();
  const envFor = function (lab) { return lab === 'router' ? rtr.dev : net.sw1; };
  const ctxFor = function (lab) { return lab === 'router' ? rtr : net; };
  const port = '1/1/3';
  let narrowed = 0, refusedWithName = 0;
  for (const step of SWEEP) {
    const cmd = step.cmd;
    const ctx = ctxFor(step.lab);
    const dev = envFor(step.lab);
    const myPort = step.port;
    const all = run(dev, ctx.t, ctx.sim, [cmd]);
    const one = run(dev, ctx.t, ctx.sim, [cmd + ' ' + myPort]);
    const first = one.split('\n')[0];
    const isRefusal = /^%/.test(first);
    if (isRefusal) {
      ok(first.indexOf(myPort) !== -1, cmd + ': refused, and the refusal names the port it could not answer for');
      refusedWithName++;
    } else {
      // Counting lines is not enough: a filtered answer gains a heading, so a two-entry table and a
      // one-entry filter can both be three lines. What must be true is that the filtered answer is
      // made of rows the full answer also contained, and that it carries fewer of them.
      const allLines = all.split('\n').filter(function (l) { return l.trim(); });
      const oneLines = one.split('\n').filter(function (l) { return l.trim(); });
      const carried = oneLines.filter(function (l) { return allLines.indexOf(l) !== -1; });
      const fewer = carried.length < allLines.length;
      ok(fewer, cmd + ': carries ' + carried.length + ' of the ' + allLines.length +
        ' lines the full answer has');
      // And it must not talk about a port nobody asked about.
      const others = Array.from(dev.interfaces.values()).map(function (i) { return i.name; })
        .filter(function (n) { return n !== myPort; });
      const leaked = others.filter(function (n) {
        // A bare number or a suffix like `/3` would match inside other text; require a word boundary
        // on both sides so `1/1/3` is not found inside `1/1/30`.
        const re = new RegExp('(^|[^0-9A-Za-z/])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          '([^0-9A-Za-z/]|$)');
        return re.test(one);
      });
      ok(leaked.length === 0, cmd + ': no other port is mentioned' +
        (leaked.length ? ' (found ' + leaked.slice(0, 3).join(', ') + ')' : ''));
      if (fewer) narrowed++;
    }
    // The invariant, stated as its own assertion: filtered output must never be the full table with
    // a different heading. This is the defect, caught directly.
    ok(one !== all, cmd + ': the argument changed the answer (it is not printed and dropped)');
  }
  ok(narrowed + refusedWithName === SWEEP.length,
    'all ' + PORT_COMMANDS.length + ' commands accounted for (' + narrowed + ' narrowed, ' +
    refusedWithName + ' refused by name)');
  ok(narrowed >= 5, narrowed + ' of them actually narrowed, so the sweep is not just counting refusals');
}

console.log('\nAn unknown port is refused by name, not widened:');
{
  const env = networkLab();
  let checked = 0;
  for (const cmd of PORT_COMMANDS) {
    const out = run(env.sw1, env.t, env.sim, [cmd + ' bogus9']);
    const lines = out.split('\n');
    ok(/^%/.test(lines[0]), cmd + ' bogus9: refused');
    ok(lines[0].indexOf('bogus9') !== -1, cmd + ' bogus9: the refusal quotes what was typed');
    ok(lines.length <= 3, cmd + ' bogus9: and it does not print a table anyway');
    checked++;
  }
  eq(checked, PORT_COMMANDS.length, 'every command was asked about a port it does not have');
}

console.log('\nThe panel spelling and the console spelling get the same answer:');
{
  const env = routerLab();
  // The panel says SFP+1; RouterOS calls it sfp-sfpplus1. Both are accepted by config, so both must be
  // accepted here - one resolver, one opinion.
  const pairs = [['SFP+1', 'sfp-sfpplus1'], ['eth1', 'ether1']];
  for (const cmd of ['show interfaces', 'show ipv6 interface', 'show interfaces transceiver']) {
    for (const pair of pairs) {
      const a = run(env.dev, env.t, env.sim, [cmd + ' ' + pair[0]]);
      const b = run(env.dev, env.t, env.sim, [cmd + ' ' + pair[1]]);
      // Two refusals are allowed to differ in the port they quote - that is the refusal being useful.
      // What must not happen is one spelling answering and the other refusing.
      const bothRefuse = /^%/.test(a) && /^%/.test(b);
      if (bothRefuse) {
        eq(a.split('\n').slice(1).join('\n'), b.split('\n').slice(1).join('\n'),
          cmd + ': both spellings are refused for the same reason (' + a.split('\n')[0] + ')');
      } else {
        eq(b, a, cmd + ': ' + pair[0] + ' and ' + pair[1] + ' are the same port');
      }
    }
  }
  // And the answer names the panel, because that is what is printed on the box.
  ok(run(env.dev, env.t, env.sim, ['show interfaces sfp-sfpplus1']).indexOf('SFP+1') !== -1,
    'the answer uses the panel spelling, not the one typed');
  // A port the config parser accepts must not be refused here: the exact split that woke this file up.
  const cfg = runCommands(env.dev, env.t, env.sim,
    ['enable', 'configure terminal', 'interface sfp-sfpplus1', 'ip address 10.9.9.9/24', 'exit', 'exit']);
  ok(!cfg.lines.some(function (l) { return /^%/.test(l); }),
    'config accepts sfp-sfpplus1 (' + cfg.lines.join(' / ').slice(0, 80) + ')');
  ok(!/^%/.test(run(env.dev, env.t, env.sim, ['show ipv6 interface sfp-sfpplus1'])),
    'so show ipv6 interface accepts it too');
  ok(!/^%/.test(run(env.dev, env.t, env.sim, ['show interfaces sfp-sfpplus1'])),
    'and show interfaces accepts it');
}

console.log('\n`interface <port>` is accepted where IOS spells it that way:');
{
  const env = networkLab();
  for (const cmd of ['show mac address-table', 'show spanning-tree', 'show ip interface brief']) {
    eq(run(env.sw1, env.t, env.sim, [cmd + ' interface 1/1/3']),
      run(env.sw1, env.t, env.sim, [cmd + ' 1/1/3']),
      cmd + ': the `interface` keyword is optional, not a port name');
  }
}

console.log('\nA filter that finds nothing says so instead of going blank:');
{
  const env = networkLab();
  // 1/1/12 is a real port on this switch with nothing attached: no LLDP, no MAC, no PoE device.
  const lldp = run(env.sw1, env.t, env.sim, ['show lldp neighbors 1/1/12']);
  ok(/none - no LLDP has been heard on 1\/1\/12/.test(lldp),
    'no LLDP on that port is stated, not left as an empty table');
  const mac = run(env.sw1, env.t, env.sim, ['show mac address-table 1/1/12']);
  ok(/none - nothing has been learned on this port/.test(mac), 'and no MAC entry likewise');
  ok(!/1\/1\/3 /.test(mac), 'the answer does not leak another port\'s entries');
}

console.log('\nTwo ports is a question this console will not guess at:');
{
  const env = networkLab();
  const out = run(env.sw1, env.t, env.sim, ['show arp 1/1/3 1/1/5']);
  ok(/takes one port/.test(out), 'asking about two ports is refused (' + out.split('\n')[0] + ')');
}

console.log('\nA word that looks like a subcommand is a subcommand, not a port hunt:');
{
  const env = networkLab();
  const out = run(env.sw1, env.t, env.sim, ['show interfaces counters']);
  // This block used to assert the opposite - that `counters` was refused as a command and the operator
  // was pointed at `show interfaces <port>`. That pointer was to a command with no counters in it, so
  // the command exists now and refusing it would be a regression dressed as consistency.
  ok(!/is not a command here/.test(out), '`show interfaces counters` is accepted');
  ok(!/No interface named counters/.test(out), 'and it is never mistaken for a port by that name');
  ok(/Interface counters on SW1/.test(out), 'it answers with a counters heading: ' + out.split('\n')[0]);
  // A real port after the subcommand still narrows, and an invented one is still refused by name.
  const one = run(env.sw1, env.t, env.sim, ['show interfaces counters 1/1/3']);
  ok(/Interface counters on SW1 for 1\/1\/3/.test(one), 'a named port narrows it');
  const bad = run(env.sw1, env.t, env.sim, ['show interfaces counters 1/1/99']);
  ok(/% No interface named 1\/1\/99/.test(bad), 'an unknown port after it is refused by name');
}

console.log('\nThe help says the argument exists:');
{
  const env = networkLab();
  const help = run(env.sw1, env.t, env.sim, ['help']);
  for (const row of ['show interfaces [<port>]', 'show ip interface brief [<port>]',
    'show mac address-table [interface <port>]', 'show spanning-tree [<port>]',
    'show lldp neighbors [<port>]', 'show arp [<port>]', 'show power inline [<port>]']) {
    ok(help.indexOf(row) !== -1, 'help documents `' + row + '`');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
