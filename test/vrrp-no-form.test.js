'use strict';
// A `no` line that names one setting must remove that setting, not the object that holds it.
//
// `show running-config` has always printed `  no vrrp <vrid> preempt` for a group whose preemption is
// off, and the set form was the only half that existed: the interface-mode `no vrrp` branch parsed the
// vrid, threw the rest of the line away, and dropped every group with that vrid on the port. So the
// console wrote a line it read back as a deletion - the paste of its own config took the virtual
// gateway with it, which is the property test/config-roundtrip.test.js exists to hold (#1230).
//
// What the device does is the vendor's own grammar: `no vrrp <group> preempt` is the documented way to
// turn preemption off - "To disable this function, use the no form of this command", syntax
// `no vrrp group preempt` (Cisco IOS First Hop Redundancy Protocols Command Reference, `vrrp preempt`,
// https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp_fhrp/command/fhp-cr-book/fhp-v1.html) - and the
// configuration guide's sample interface block lists `no vrrp 100 preempt` beside `vrrp 100 ip 10.1.0.100`.
// `priority` and `timers advertise` carry the same default-restoring `no` form, with defaults 100 and
// 1 second. Only the bare `no vrrp <vrid>` removes the group.
//
// See research/vrrp-no-form-scope.md for the evidence, and for the half that is still open: nothing
// reads the flag during an election yet.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return s.model === 'generic-router'; })[0];
const PORT = 'Gi0/0';

// One router with one group on one port, configured the way a lab configures it. The device is added
// through a Topology because that is what fills in a model's default port set.
function session() {
  const t = new Topology();
  const dev = t.addDevice(ROUTER, 'r1');
  const cli = new CliSession(dev, t, new Simulator(t));
  const run = function (cmds) {
    const lines = [];
    for (const c of cmds) {
      const r = cli.run(c);
      for (const l of ((r && r.output) || [])) lines.push(String(l));
    }
    return lines;
  };
  run(['enable', 'configure terminal', 'interface ' + PORT, 'ip address 10.0.0.1 255.255.255.0',
    'vrrp 42 ip 10.0.0.254', 'vrrp 42 priority 150', 'vrrp 42 advertise 3']);
  return { dev: dev, cli: cli, run: run };
}

function groups(dev) { return Array.isArray(dev.config.vrrp) ? dev.config.vrrp : []; }
function group(dev) {
  return groups(dev).filter(function (g) { return g.vrid === 42; })[0] || null;
}

console.log('A `no` line that names a setting removes the setting, and leaves the group standing:');
{
  const s = session();
  ok(groups(s.dev).length === 1, 'the group is configured to begin with');

  const priority = s.run(['no vrrp 42 priority']);
  ok(priority[0] === 'VRRP group 42 priority reset to 100',
    'no vrrp 42 priority says the priority is back at 100', priority[0]);
  ok(groups(s.dev).length === 1, 'and the group is still there', JSON.stringify(groups(s.dev)));
  ok(group(s.dev).priority === 100, 'with the default priority in force', String(group(s.dev).priority));
  ok(group(s.dev).ips.length === 1 && group(s.dev).ips[0] === '10.0.0.254',
    'and its virtual address untouched', JSON.stringify(group(s.dev).ips));

  const preempt = s.run(['no vrrp 42 preempt']);
  ok(preempt[0] === 'VRRP group 42 preempt disabled', 'no vrrp 42 preempt disables preemption', preempt[0]);
  ok(groups(s.dev).length === 1, 'and does not remove the group', JSON.stringify(groups(s.dev)));
  ok(group(s.dev).preempt === false, 'preempt is now off on the group', String(group(s.dev).preempt));

  const advertise = s.run(['no vrrp 42 advertise']);
  ok(advertise[0] === 'VRRP group 42 advertises every 1 s',
    'no vrrp 42 advertise returns the 1 s default', advertise[0]);
  ok(groups(s.dev).length === 1, 'and the group survives that too', JSON.stringify(groups(s.dev)));
  ok(group(s.dev).advertSec === 1, 'with the default interval stored', String(group(s.dev).advertSec));

  const again = s.run(['vrrp 42 preempt']);
  ok(again[0] === 'VRRP group 42 preempt enabled', 'vrrp 42 preempt turns it back on', again[0]);
  ok(group(s.dev).preempt === true, 'and the flag follows the line', String(group(s.dev).preempt));
}

console.log('\nThe config this console prints is a config it can read back:');
{
  const s = session();
  s.run(['no vrrp 42 preempt', 'end']);
  const text = s.run(['show running-config']).join('\n');
  ok(/(^|\n) no vrrp 42 preempt(\n|$)/.test(text), 'the printer writes ` no vrrp 42 preempt` for the group',
    text.split('\n').filter(function (l) { return /vrrp/.test(l); }).join(' | '));

  // The paste-back: the same text into a fresh device of the same model, as a saved lab would be.
  const topo = new Topology();
  const fresh = topo.addDevice(ROUTER, 'r2');
  const cli = new CliSession(fresh, topo, new Simulator(topo));
  const replayed = [];
  for (const line of ['enable', 'configure terminal'].concat(text.split('\n'))) {
    const r = cli.run(line);
    for (const l of ((r && r.output) || [])) replayed.push(String(l));
  }
  const rejected = replayed.filter(function (l) { return /^%/.test(l); });
  ok(rejected.length === 0, 'every line of the printed config is accepted back',
    JSON.stringify(rejected.slice(0, 3)));
  ok(groups(fresh).length === 1, 'and the group survives the paste', JSON.stringify(groups(fresh)));
  ok(group(fresh) && group(fresh).preempt === false, 'with its preemption still off',
    JSON.stringify(group(fresh)));
  ok(group(fresh) && group(fresh).priority === 150, 'and its priority still 150',
    group(fresh) ? String(group(fresh).priority) : 'no group');
}

console.log('\nThe bare form still removes the group, and a word it cannot unset is refused:');
{
  const s = session();
  const bad = s.run(['no vrrp 42 wibble']);
  ok(/^% Unrecognized vrrp command: no vrrp 42 wibble/.test(bad[0]), 'no vrrp 42 wibble is refused', bad[0]);
  ok(/priority, preempt, advertise/.test(bad[0]), 'and names the settings it can unset', bad[0]);
  ok(groups(s.dev).length === 1, 'the group is left exactly as it was', JSON.stringify(groups(s.dev)));
  ok(group(s.dev).priority === 150 && group(s.dev).preempt === true,
    'with its priority and its preemption untouched',
    JSON.stringify({ priority: group(s.dev).priority, preempt: group(s.dev).preempt }));

  const missing = s.run(['no vrrp 99 preempt']);
  ok(missing[0] === '% No VRRP group 99 on ' + PORT, 'a group that does not exist says so', missing[0]);

  const bare = s.run(['no vrrp 42']);
  ok(bare[0] === 'VRRP group 42 removed from ' + PORT, 'the bare no vrrp 42 still removes it', bare[0]);
  ok(groups(s.dev).length === 0, 'and nothing is left behind', JSON.stringify(groups(s.dev)));
}

console.log('\nThe flag survives a simulation run, and the group still answers for its address:');
{
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const r2 = t.addDevice(ROUTER, 'r2');
  const sw = t.addDevice(catalog.filter(function (s) { return s.model === 'generic-switch'; })[0], 'sw');
  t.connect('r1', PORT, 'sw', 'Fa0/1');
  t.connect('r2', PORT, 'sw', 'Fa0/2');
  const sim = new Simulator(t);
  for (const pair of [[r1, '10.0.0.1', 150], [r2, '10.0.0.2', 200]]) {
    const cli = new CliSession(pair[0], t, sim);
    for (const c of ['enable', 'configure terminal', 'interface ' + PORT,
      'ip address ' + pair[1] + ' 255.255.255.0', 'vrrp 42 ip 10.0.0.254', 'vrrp 42 priority ' + pair[2]]) {
      cli.run(c);
    }
  }
  const cli = new CliSession(r1, t, sim);
  for (const cmd of ['enable', 'configure terminal', 'interface ' + PORT, 'no vrrp 42 preempt', 'end']) cli.run(cmd);
  sim.computeVrrp();
  ok(groups(r1).length === 1 && group(r1).preempt === false, 'the flag is still off after an election',
    JSON.stringify(groups(r1)));
  const shown = ((new CliSession(r1, t, sim).run('show vrrp').output) || []).map(String).join('\n');
  ok(/10\.0\.0\.254/.test(shown), 'and the group still reports its virtual address',
    shown.split('\n').filter(function (l) { return /10\.0\.0\.254/.test(l); })[0] || '');
}

console.log('\n' + (failed ? '\u2717 ' : '\u2713 ') + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
