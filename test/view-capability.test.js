'use strict';
// view-capability.test.js - a view is shown where it can be answered, and refused in the device's terms.
//
// Three shapes of one gap, all found by sweeping the `?` page against the parser on devices that are
// not routers:
//
//   SW1#show ip route ?          (the view is on the page only for a layer-3 device)
//   "...is a command here, but not on SW1: it does not forward between interfaces, so it has no
//    routes or adjacencies"      - while `show ip route` answers, and prints the default route
//   SW1#show ip bgp
//   % BGP is not enabled - "router bgp <as>" in config mode turns BGP on    - refused on a switch
//   PC1#show interfaces eth0 switchport
//   Access Mode VLAN: 1 ...      - a switchport state invented for a port that switches nothing
//
// The rules:
//   1. A view a device can answer is on its page. `show ip route` is answered by every device in this
//      model (a switch prints its `ip default-gateway` route, a host an empty table), so it is never
//      gated.
//   2. A view a device cannot have is refused as what the device is, not with advice it cannot take.
//      A switch has no BGP process and no OSPF process to enable.
//   3. A capability refusal is the same for the family form and the per-port form, because it is the
//      same question: `show interfaces switchport` refused a non-switch while
//      `show interfaces <port> switchport` invented a state for one.
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

function session(model, name) {
  const t = new Topology();
  const d = t.addDevice(find(model)); d.name = name;
  const s = new CliSession(d, t, new Simulator(t)); s.run('enable');
  return { t: t, d: d, s: s, port: Array.from(d.interfaces.values())[0] };
}

console.log('Every device answers the route table, so every device is shown it:');
{
  const sw = session('generic-switch', 'SW1');
  sw.s.run('configure terminal'); sw.s.run('vlan 10');
  sw.s.run('interface vlan 10'); sw.s.run('ip address 10.0.0.254 255.255.255.0');
  sw.s.run('exit'); sw.s.run('ip default-gateway 10.0.0.1'); sw.s.run('end');
  const page = text(sw.s.run('show ip route ?'));
  ok(!/but not on SW1/.test(page), 'show ip route is on a switch\'s page');
  const table = text(sw.s.run('show ip route'));
  ok(/0\.0\.0\.0\/0/.test(table), 'and it prints the default route a switch really has');
  ok(/Vlan10/.test(table), 'naming the interface it leaves by');
  ok(/Route summary/.test(text(sw.s.run('show ip route summary'))), 'the summary answers too');
  ok(/Destination/.test(text(sw.s.run('show ip route 10.9.9.9'))), 'and a lookup');
  // A host keeps an empty table rather than no view.
  const pc = session('generic-pc', 'PC1');
  ok(/Codes: C - connected, S - static/.test(text(pc.s.run('show ip route'))),
    'a host has an empty table, not a missing command');
  ok(!/but not on PC1/.test(text(pc.s.run('show ip route ?'))), 'and is shown it');
}

console.log('\nA view a device cannot have is refused as what the device is:');
{
  const sw = session('generic-switch', 'SW1');
  for (const cmd of ['show ip bgp', 'show ip bgp summary', 'show ip bgp neighbors', 'show ip ospf', 'show ip ospf neighbor']) {
    const out = text(sw.s.run(cmd));
    ok(/^%/.test(out), cmd + ' is refused on a switch');
    ok(/is a layer 2 switch: no (BGP|OSPF) process can run here/.test(out), '  saying which process cannot run');
    ok(/needs a device that routes/.test(out), '  and what such a device needs');
    ok(!/router bgp|ospf router-id/.test(out), '  and never naming a command this device refuses');
    ok(/show ip route/.test(out), '  while pointing at the table it does have');
  }
  // A router without the process still gets the enablement advice - that is advice it can take.
  const r = session('generic-router', 'R1');
  const bgp = text(r.s.run('show ip bgp'));
  ok(/BGP is not enabled/.test(bgp), 'a router is told BGP is not enabled');
  ok(/router bgp <as>/.test(bgp), 'and how to enable it - which works there');
}

console.log('\nThe family form and the per-port form refuse the same question the same way:');
{
  for (const model of ['generic-router', 'generic-pc']) {
    const env = session(model, 'D1');
    const family = text(env.s.run('show interfaces switchport'));
    const single = text(env.s.run('show interfaces ' + env.port.name + ' switchport'));
    ok(/^%/.test(family), model + ': the family form is refused');
    ok(/^%/.test(single), model + ': the per-port form is refused too');
    ok(/does not switch/.test(single), model + ':  and for the same reason');
    ok(!/Access Mode VLAN/.test(single), model + ':  with no invented switchport state');
    ok(!/Port Security/.test(single), model + ':  and no invented port security');
  }
  // A switch still answers both, and they agree.
  const sw = session('generic-switch', 'SW1');
  const one = text(sw.s.run('show interfaces ' + sw.port.name + ' switchport'));
  ok(/Administrative Mode/.test(one), 'a switch answers the per-port form');
  const all = text(sw.s.run('show interfaces switchport'));
  ok(all.indexOf(one.split('\n')[0]) !== -1, 'and the per-port block is the family block');
}

console.log('\nThe sweep behind all three: a hidden show row is a row the parser refuses:');
{
  // One device from each catalogue category. Every `show` row the page hides must be refused when
  // typed, because a hidden row that answers is a view an operator will never find.
  const byKind = {};
  for (const cat of catalog) {
    const kind = cat.category || 'other';
    if (!byKind[kind]) byKind[kind] = cat;
  }
  const VALUES = {
    '<dest>': '10.9.9.0', '<dest>/<len>': '10.9.9.0/24', '<prefix>': '10.9.9.0', '<prefix/len>': '10.9.9.0/24',
    '<ip>': '10.0.0.1', '<addr>': '10.0.0.1', '<mask>': '255.255.255.0', '<id>': '10', '<n>': '2',
    '<type>': 'drop', '<what>': 'summary', '<vrid>': '1', '<mac>': '0011.2233.4455', '<as>': '65001',
    '<pid>': '1', '<gw>': '10.0.0.1', '<text>': 'x', '<ms>': '50', '<v6dst>': '2001:db8::1',
    '<address>': '10.0.0.1', '<interface>': null, '<port>': null, '<iface>': null, '<name>': null
  };
  let checked = 0;
  const broken = [];
  for (const kind of Object.keys(byKind)) {
    const t = new Topology();
    const d = t.addDevice(byKind[kind]); d.name = 'D1';
    const s = new CliSession(d, t, new Simulator(t)); s.run('enable');
    const first = Array.from(d.interfaces.values())[0];
    const shown = new Set();
    const rows = [];
    for (const line of s._helpPage()) {
      // Not an exemption, ordinary control flow: the page's headers and legends are not rows, and
      // this loop is asking which rows exist.
      if (!/^ {2}\S/.test(line)) continue;
      const syn = line.trim().split(/\s{2,}/)[0];
      rows.push(syn);
      if (s._helpApplies(syn)) shown.add(syn);
    }
    for (const syn of rows) {
      // Not an exemption, ordinary control flow: this sweep is the mirror of capability-gate's, which
      // types the shown rows. Each row belongs to exactly one of the two sweeps.
      if (shown.has(syn)) continue;
      // Not an exemption, ordinary control flow: a configuration row is not a view, and the shown
      // configuration rows are typed by capability-gate.
      if (!/^show /.test(syn)) continue;
      let cmd = syn;
      for (const ph of Object.keys(VALUES)) {
        const v = VALUES[ph] === null ? (first ? first.name : 'x') : VALUES[ph];
        cmd = cmd.split(ph).join(v);
      }
      cmd = cmd.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
      if (cmd.indexOf('<') !== -1) continue;
      checked++;
      const out = text(s.run(cmd));
      if (out && !/^\s*%/.test(out)) {
        broken.push(kind + ': ' + syn + ' -> ' + String(out).split('\n')[0].slice(0, 60));
      }
    }
  }
  ok(checked > 200, 'the sweep typed the hidden show rows (' + checked + ')');
  ok(broken.length === 0, 'and none of them answered'
    + (broken.length ? ' - ' + broken.slice(0, 5).join(' | ') : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
