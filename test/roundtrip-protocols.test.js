'use strict';
// roundtrip-protocols.test.js - the second half of the dump-and-paste harness.
//
// config-roundtrip.test.js covers addressing, switching, port security, NAT and OSPF. This covers the
// protocol families it does not touch: IPv6, a DHCP server pool, VRRP, BGP, a named ACL, STP root
// election and sticky port security. The failure mode being tested is the same one a lab hits: a
// config that is accepted, dumped, and then refused - or silently different - when pasted back.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) + ')'));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const pick = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };
const ROUTER = pick('generic-router'), SWITCH = pick('generic-switch'), PC = pick('generic-pc');

function lab() {
  const t = new Topology();
  const r = t.addDevice(ROUTER), sw = t.addDevice(SWITCH), pc = t.addDevice(PC);
  r.name = 'R1'; sw.name = 'SW1'; pc.name = 'PC1';
  const ports = function (d) {
    return Array.from(d.interfaces.keys()).filter(function (n) {
      const i = d.interfaces.get(n);
      return !i.svi && !i.parent;
    });
  };
  t.connect(r.id, 'Gi0/0', sw.id, ports(sw)[0]);
  t.connect(pc.id, 'eth0', sw.id, ports(sw)[1]);
  const sim = new Simulator(t);
  const s = {};
  for (const d of [r, sw, pc]) { const x = new CliSession(d, t, sim); x.run('enable'); s[d.name] = x; }
  return { t: t, sim: sim, r: r, sw: sw, pc: pc, s: s, swp: ports(sw) };
}

const CONFIG = {
  R1: [
    'hostname R1',
    'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'ipv6 address 2001:db8:1::1/64', 'exit',
    'interface Gi0/1', 'ip address 192.168.5.1 255.255.255.0', 'exit',
    'ipv6 unicast-routing',
    'ipv6 route 2001:db8:2::/64 2001:db8:1::2',
    'ip dhcp pool LAN', 'network 192.168.5.0 255.255.255.0', 'default-router 192.168.5.1',
    'dns-server 10.0.0.53', 'range 192.168.5.100 192.168.5.120', 'exit',
    'interface Gi0/1', 'vrrp 1 ip 192.168.5.1', 'vrrp 1 priority 150', 'vrrp 1 preempt', 'exit',
    'router bgp 65001', 'bgp router-id 1.1.1.1', 'bgp neighbor 10.0.0.2 remote-as 65002', 'exit',
    'ip access-list extended WEB', 'permit tcp any any eq 443', 'deny ip any any', 'exit',
    'ip domain-name lab.test'
  ],
  SW1: [
    'hostname SW1', 'vlan 10 name users', 'spanning-tree vlan 10 root primary',
    'interface Fa0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
    'interface Fa0/2', 'switchport mode trunk', 'switchport trunk allowed vlan 10', 'exit',
    'interface Fa0/3', 'switchport port-security', 'switchport port-security mac-address sticky', 'exit',
    'lldp run'
  ],
  PC1: ['hostname PC1', 'interface eth0', 'ip address 192.168.5.10 255.255.255.0', 'exit',
    'ip default-gateway 192.168.5.1']
};

function apply(env, config) {
  const refused = [];
  for (const dev of Object.keys(config)) {
    const s = env.s[dev];
    s.run('configure terminal');
    for (const line of config[dev]) {
      const out = s.run(line).output || [];
      const bad = out.filter(function (l) { return /^(%|Unexpected)/.test(l); });
      if (bad.length) refused.push(dev + ': ' + line + ' -> ' + bad[0]);
    }
    s.run('end');
  }
  return refused;
}
function dump(env) {
  const out = {};
  for (const k of Object.keys(env.s)) out[k] = env.s[k].run('show running-config').output;
  return out;
}
function pasteInto(env, dumps) {
  for (const k of Object.keys(dumps)) {
    const s = env.s[k];
    s.run('configure terminal');
    for (const line of dumps[k]) {
      // Ordinary control flow, not an exemption: a dump's banner, its `end` terminator and the
      // "Building configuration" heading are not commands, by construction of the dump format.
      if (/^!/.test(line) || /^end$/.test(line) || /^(Building|Current) configuration/.test(line)) continue;
      s.run(line);
    }
    s.run('end');
  }
}

console.log('\nEvery protocol family is accepted on the device that owns it:');
{
  const env = lab();
  const refused = apply(env, CONFIG);
  ok(refused.length === 0, 'the reference configuration is accepted' +
    (refused.length ? ': ' + refused.join(' | ') : ''));
}

console.log('\nThe dump pastes back into an identical device, byte for byte:');
{
  const a = lab(); apply(a, CONFIG);
  const dumpA = dump(a);
  const b = lab(); pasteInto(b, dumpA);
  const dumpB = dump(b);
  for (const k of Object.keys(dumpA)) {
    const same = dumpA[k].join('\n') === dumpB[k].join('\n');
    ok(same, k + ' dumps identically after a paste (' + dumpA[k].length + ' lines)' +
      (same ? '' : '\n      A: ' + JSON.stringify(dumpA[k].slice(0, 6)) + '\n      B: ' + JSON.stringify(dumpB[k].slice(0, 6))));
  }
  // And the state behind the text.
  eq((b.r.config.ipv6Routes || []).length, (a.r.config.ipv6Routes || []).length,
    'the IPv6 route survived the paste');
  eq(b.r.config.dhcpPools ? Object.keys(b.r.config.dhcpPools).length : 0,
    a.r.config.dhcpPools ? Object.keys(a.r.config.dhcpPools).length : 0,
    'the DHCP pool survived');
  // VRRP groups live in `config.vrrp` and name their interface, which is how the dump knows where to
  // put them back. `preempt` was in the record but *not* in the dump, so the paste dropped it.
  const g = (b.r.config.vrrp || []).filter(function (x) { return x.vrid === 1; })[0];
  ok(!!g, 'the VRRP group survived the paste');
  eq(g && g.interface, 'Gi0/1', 'on the interface it was configured on');
  eq(g && g.priority, 150, 'with its priority');
  eq(g && g.preempt, true, 'and its preempt setting, which the dump used to omit');
  const bgp = b.r.config.bgp;
  eq(bgp && bgp.as, 65001, 'the BGP AS survived');
  eq((bgp && bgp.neighbors || []).length, 1, 'and its neighbour');
  eq(bgp && bgp.neighbors[0].remoteAs, 65002, 'with its remote AS');
  const acl = (b.r.config.acls || {}).WEB;
  eq((acl || []).length, 2, 'the named ACL kept both entries');
  const sw = b.sw;
  const sec = sw.portSecurity && sw.portSecurity.ports['Fa0/3'];
  ok(sec && sec.sticky, 'the switch kept sticky learning');
  // The STP root really is the root on the pasted switch.
  const stp = b.s.SW1.run('show spanning-tree').output.join('\n');
  // The output says "(this bridge is the root)" in lower case and names the root as
  // "Root bridge: priority 24576, 02:00:... (SW1)", so both of the obvious spellings missed.
  ok(/this bridge is the root/i.test(stp), 'and the pasted switch is the STP root');
  ok(/priority 24576/.test(stp), 'with the priority that `root primary` chose');
  // The dump names the VLAN the operator named. It used to write `spanning-tree vlan 1 priority`,
  // inventing a VLAN nobody configured - and pasting it back moved the setting to VLAN 1.
  const dumpText = b.s.SW1.run('show running-config').output.join('\n');
  ok(/^spanning-tree vlan 10 priority 24576$/m.test(dumpText),
    'and the dump keeps VLAN 10, the VLAN the operator typed');
  ok(!/^spanning-tree vlan 1 /m.test(dumpText), 'so it does not invent a VLAN nobody configured');
}

console.log('\nA paste does not double anything:');
{
  const a = lab(); apply(a, CONFIG);
  const dumps = dump(a);
  const c = lab(); pasteInto(c, dumps); pasteInto(c, dumps);
  const dumpC = dump(c);
  for (const k of Object.keys(dumps)) {
    eq(dumpC[k].join('\n'), dumps[k].join('\n'), k + ' is unchanged by a second paste');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
