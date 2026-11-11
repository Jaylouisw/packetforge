'use strict';
// instant-label.test.js - a question asked at a moment says which moment, or refuses the moment.
//
//   SW1#show spanning-tree at 50
//   STP at t=50 ms (control planes rebuilt for this answer)      <- the family form labels it
//   SW1#show spanning-tree summary at 50
//   Spanning tree enabled protocol ieee - summary for SW1        <- and the summary did not
//
// The dispatcher prints the instant line before the handler runs, so a handler that returns its own
// array instead of appending to the one it was given silently drops it - the line reads as if the
// instant had never been typed. Two shapes of one rule:
//
//   1. A view that accepts `at <ms>` / `converged` labels the answer with the instant it was asked at.
//   2. A view that cannot answer at an instant refuses the instant by name; it never answers the
//      question it would have asked without it.
//
// The second is checked by the same sweep: a refusal (`% ...`) is an honest answer here, silence is not.
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

function switchLab() {
  // Two switches with a redundant link, so the tree has a role to report.
  const t = new Topology();
  const a = t.addDevice(find('generic-switch')); a.name = 'SW1';
  const b = t.addDevice(find('generic-switch')); b.name = 'SW2';
  const ap = Array.from(a.interfaces.values());
  const bp = Array.from(b.interfaces.values());
  t.connect(a.id, ap[0].name, b.id, bp[0].name);
  t.connect(a.id, ap[1].name, b.id, bp[1].name);
  const s = new CliSession(a, t, new Simulator(t)); s.run('enable');
  return { t: t, s: s };
}

console.log('A view asked at a moment says which moment:');
{
  const env = switchLab();
  const pairs = [
    ['show spanning-tree', 'show spanning-tree at 50'],
    ['show spanning-tree summary', 'show spanning-tree summary at 50'],
    ['show spanning-tree root', 'show spanning-tree root at 50']
  ];
  for (const pair of pairs) {
    const base = text(env.s.run(pair[0]));
    ok(!/at t=/.test(base), pair[0] + ' on its own carries no instant line');
    const asked = text(env.s.run(pair[1]));
    ok(/at t=50 ms/.test(asked), pair[1] + ' says it was answered at t=50 ms');
    ok(/control planes rebuilt/.test(asked), 'and says what that means');
    // The body must still be the answer, not just a label.
    const body = base.split('\n')[0];
    ok(asked.indexOf(body) !== -1, 'and the answer itself is unchanged underneath the label');
  }
  const converged = text(env.s.run('show spanning-tree summary converged'));
  ok(/converged/.test(converged), 'summary converged labels the settled instant');
  ok(/Spanning tree enabled/.test(converged), 'and still prints the summary');
}

console.log('\nThe sweep: every view on every kind of device, asked at an instant:');
{
  // The guard for the class. `% ...` is an honest answer (this view cannot be asked at a moment);
  // answering the question without the instant is not.
  const SHOWS = ['show version', 'show interfaces', 'show interfaces status', 'show interfaces counters',
    'show interfaces switchport', 'show interfaces trunk', 'show vlan', 'show mac address-table',
    'show spanning-tree', 'show spanning-tree summary', 'show spanning-tree root', 'show port-security',
    'show power inline', 'show logging', 'show clock', 'show arp', 'show ip interface brief',
    'show ip route', 'show ip protocols', 'show ip ospf neighbor', 'show ip bgp summary', 'show vrrp',
    'show lldp neighbors', 'show ip traffic', 'show hosts', 'show access-lists',
    'show ip nat translations', 'show ip dhcp pool', 'show ip dhcp binding', 'show users',
    'show processes cpu', 'show environment', 'show ipv6 route', 'show ipv6 interface brief',
    'show inventory', 'show running-config'];
  const byKind = {};
  for (const cat of catalog) {
    const kind = cat.category || cat.kind || 'other';
    if (!byKind[kind]) byKind[kind] = cat;
  }
  let probes = 0;
  const silent = [];
  for (const kind of Object.keys(byKind)) {
    const t = new Topology();
    const d = t.addDevice(byKind[kind]); d.name = 'D1';
    const s = new CliSession(d, t, new Simulator(t)); s.run('enable');
    for (const cmd of SHOWS) {
      if (/^\s*%/.test(text(s.run(cmd)))) continue;   // the view is not on this device: another invariant
      for (const tail of ['at 50', 'converged']) {
        const out = text(s.run(cmd + ' ' + tail)).replace(/\r/g, '');
        if (/^\s*%/.test(out)) continue;              // refused by name: honest
        probes++;
        if (!/t=50 ms|converged/i.test(out)) {
          silent.push(kind + ': ' + cmd + ' ' + tail);
        }
      }
    }
  }
  ok(probes > 200, 'the sweep asked an instant of every view it could (' + probes + ')');
  ok(silent.length === 0, 'and no view answered as if the instant had not been typed'
    + (silent.length ? ' - ' + silent.slice(0, 4).join(' | ') : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
