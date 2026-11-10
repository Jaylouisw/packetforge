'use strict';
// no-placeholders.test.js - a number in a message is a number, and a cost is the cost of that speed.
//
//   SW1(config-if)#speed 100
//   Speed on Fa0/1 set to 100M (was 1G)
//     Spanning-tree path cost from this port is now 200000 (was ?)
//
// Two defects behind that one line. The "(was …)" figure was read only from a *negotiated* speed, and a
// port configured from the start never has one - so the before-and-after, which is the whole reason the
// line exists, printed a question mark instead of a cost. And the cost table had no 10 Mbps row: a 10M
// port and a 100M port were both 200000, so a spanning tree could not tell them apart.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const sim = require('../engine/simulator');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

function box(model, name) {
  const t = new Topology();
  const d = t.addDevice(find(model)); d.name = name;
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  return { t: t, d: d, s: s };
}

console.log('The cost of a speed is the cost of that speed:');
{
  const expected = [[10, 2000000], [100, 200000], [1000, 20000], [10000, 2000], [25000, 800], [40000, 400], [100000, 200]];
  const wrong = expected.filter(function (pair) { return sim.speedToCost(pair[0]) !== pair[1]; });
  ok(wrong.length === 0, 'the 802.1t table holds for 10M-100G'
    + (wrong.length ? ': ' + wrong.map(function (p) { return p[0] + '->' + sim.speedToCost(p[0]); }).join(', ') : ''));
  ok(sim.speedToCost(10) !== sim.speedToCost(100), '10M and 100M do not cost the same');
  ok(sim.speedToCost(10) > sim.speedToCost(100) && sim.speedToCost(100) > sim.speedToCost(1000),
    'a slower port costs a tree more than a faster one');
}

console.log('\nThe speed message reports the change it made:');
{
  const env = box('generic-switch', 'SW1');
  env.s.run('configure terminal');
  env.s.run('interface Fa0/1');
  const one = text(env.s.run('speed 100'));
  ok(/cost from this port is now 200000 \(was 20000\)/.test(one),
    'speed 100 reports 200000 replacing 20000');
  ok(!/\(\s*was \?/.test(one) && !/\?/.test(one), 'and no question mark stands where a cost belongs');
  const two = text(env.s.run('speed 10'));
  ok(/cost from this port is now 2000000 \(was 200000\)/.test(two),
    'speed 10 reports 2000000 replacing 200000');
  const three = text(env.s.run('speed 1000'));
  ok(/cost from this port is now 20000 \(was 2000000\)/.test(three),
    'speed 1000 reports 20000 replacing 2000000');
}

console.log('\nA refusal and the usage line under it agree:');
{
  const env = box('generic-switch', 'SW1');
  env.s.run('configure terminal');
  env.s.run('interface Fa0/1');
  const body = text(env.s.run('speed 250'));
  ok(/supports 10, 100, 1000 Mbps/.test(body), 'the refusal names the speeds this port has');
  const usage = (body.split('\n')[1] || '');
  ok(!/100000/.test(usage), 'the usage line does not offer a range the refusal rejects');
  ok(/10\|100\|1000/.test(usage), 'it offers exactly the speeds the refusal listed');
}

console.log('\nNo view prints a placeholder instead of a value:');
{
  // A lab with something in every table: addresses, a route, a VLAN, a trunk, port security, an
  // OSPF process, a BGP peer, a DHCP pool. An empty device answers "nothing here" and never reaches
  // the code that formats a value.
  const t = new Topology();
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const pc = t.addDevice(find('generic-pc')); pc.name = 'PC1';
  const swp = Array.from(sw.interfaces.values()).filter(function (i) { return !i.svi; }).map(function (i) { return i.name; });
  const pcp = Array.from(pc.interfaces.values())[0].name;
  t.connect(r.id, 'Gi0/0', sw.id, swp[0]);
  t.connect(sw.id, swp[1], pc.id, pcp);
  const simu = new Simulator(t);
  const sr = new CliSession(r, t, simu);
  sr.run('enable', 'configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0',
    'no shutdown', 'ip nat outside', 'vrrp 1 ip 10.0.0.254', 'exit',
    'interface Gi0/1', 'ip address 10.1.0.1 255.255.255.0', 'no shutdown', 'ip nat inside', 'exit',
    'ip route 10.9.0.0 255.255.0.0 10.1.0.254', 'ip name-server 8.8.8.8',
    'vlan 10', 'interface Vlan10', 'ip address 10.10.0.1 255.255.255.0', 'exit',
    'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'exit',
    'router bgp 65001', 'bgp router-id 10.0.0.1', 'neighbor 10.0.1.1 remote-as 65002', 'exit',
    'ip dhcp pool LAN', 'network 10.20.0.0 255.255.255.0', 'default-router 10.20.0.1', 'exit',
    'access-list 10 permit 10.0.0.0 0.0.0.255', 'end');
  const ss = new CliSession(sw, t, simu);
  ss.run('enable', 'configure terminal', 'vlan 10', 'vlan 20', 'interface vlan 20',
    'ip address 10.0.20.1 255.255.255.0', 'exit',
    'interface ' + swp[0], 'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'exit',
    'interface ' + swp[1], 'switchport access vlan 10', 'switchport port-security',
    'switchport port-security maximum 2', 'exit',
    'spanning-tree vlan 10 priority 4096', 'ip default-gateway 10.0.20.254', 'end');
  const sp = new CliSession(pc, t, simu);
  sp.run('enable', 'configure terminal', 'interface ' + pcp, 'ip address 10.0.0.50 255.255.255.0',
    'ip default-gateway 10.0.0.1', 'end');

  const bad = [];
  let checked = 0;
  for (const s of [sr, ss, sp]) {
    s.run('enable');
    const rows = (s._helpFormRowsAll(s.mode) || []).filter(function (f) {
      return f.tokens && f.tokens.every(function (x) { return typeof x === 'string'; });
    }).map(function (f) { return f.tokens.join(' '); });
    for (const row of rows) {
      checked += 1;
      const out = text(s.run(row));
      const m = /undefined|\bNaN\b|\bnull\b|\(was \?\)|\[object Object\]/.exec(out);
      if (m) bad.push(s.device.name + ': "' + row + '" -> ' + out.slice(Math.max(0, out.indexOf(m[0]) - 40), out.indexOf(m[0]) + 20).replace(/\n/g, ' '));
    }
  }
  ok(bad.length === 0, 'no show view prints undefined/null/NaN/[object Object]/<PH>'
    + (bad.length ? ': ' + bad.slice(0, 3).join(' | ') : ''));
  ok(checked > 250, 'the sweep ran (' + checked + ' view calls across a configured lab)');

  const cfgBad = [];
  for (const line of ['speed 100', 'speed auto', 'duplex auto', 'mtu 9000', 'shutdown', 'no shutdown',
    'no mtu', 'no speed', 'no duplex']) {
    const s2 = new CliSession(sw, t, simu);
    s2.run('enable', 'configure terminal', 'interface ' + swp[1]);
    const out = text(s2.run(line));
    if (/undefined|\bNaN\b|\bnull\b|\(was \?\)|\[object Object\]/.test(out)) cfgBad.push(line);
  }
  ok(cfgBad.length === 0, 'and no port-config reply does either'
    + (cfgBad.length ? ': ' + cfgBad.join(', ') : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
