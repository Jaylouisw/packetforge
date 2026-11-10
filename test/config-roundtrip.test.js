'use strict';
// config-roundtrip.test.js - the property this series has been enforcing one command at a time:
// a device's own running-config, pasted back into an identical device, produces the same device.
//
// This exists because a *probe* of it found `router ospf 1` missing last iteration: applying a broad
// reference configuration produced a list of refusals, and that list is where the real gaps were. The
// probe is now a test, so the next gap shows up here rather than in someone's lab.
//
// It also covers `ip routing`, which the same probe found missing on a device whose whole purpose is
// routing between its VLANs: `ip routing` answered `% Unrecognized config command` on an L3 switch.
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
function match(re, haystack, msg) {
  if (haystack && Array.isArray(haystack.output)) haystack = haystack.output;
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 900)) + ')'));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const pick = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };
const SWITCH = pick('generic-switch'), L3 = pick('generic-l3-switch'), ROUTER = pick('generic-router');
const PC = pick('generic-pc'), SERVER = pick('generic-server');

// Five device kinds on one cable plant, so the configuration covers five capability sets.
function lab() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH), l3 = t.addDevice(L3), r = t.addDevice(ROUTER);
  const pc = t.addDevice(PC), srv = t.addDevice(SERVER);
  sw.name = 'SW1'; l3.name = 'L31'; r.name = 'R1'; pc.name = 'PC1'; srv.name = 'SRV1';
  const ports = function (d) {
    return Array.from(d.interfaces.keys()).filter(function (n) {
      const i = d.interfaces.get(n);
      return !i.svi && !i.parent;
    });
  };
  t.connect(r.id, 'Gi0/0', sw.id, ports(sw)[0]);
  t.connect(pc.id, 'eth0', sw.id, ports(sw)[1]);
  t.connect(srv.id, 'eth0', l3.id, ports(l3)[0]);
  t.connect(l3.id, ports(l3)[1], r.id, 'Gi0/1');
  const sim = new Simulator(t);
  const sessions = {};
  const devices = { SW1: sw, L31: l3, R1: r, PC1: pc, SRV1: srv };
  for (const k of Object.keys(devices)) {
    const s = new CliSession(devices[k], t, sim); s.run('enable'); sessions[k] = s;
  }
  return { t: t, sim: sim, devices: devices, s: sessions,
    swp: ports(sw), l3p: ports(l3) };
}

// Every family of verb this model has, on the device that owns it.
function referenceConfig(env) {
  const l3p1 = env.l3p[0];
  return {
    SW1: ['hostname SW1', 'vlan 10 name users', 'vlan 20 name voice',
      'interface Fa0/1', 'switchport mode access', 'switchport access vlan 10',
      'description desk 12', 'mtu 1400', 'speed 100', 'duplex full', 'spanning-tree cost 30',
      'switchport port-security', 'switchport port-security maximum 2',
      'switchport port-security violation restrict', 'switchport port-security aging time 5',
      'switchport port-security aging type inactivity', 'exit',
      'interface Fa0/2', 'switchport mode trunk', 'switchport trunk native vlan 10',
      'switchport trunk allowed vlan 10,20', 'exit',
      'interface Fa0/3', 'channel-group 1 mode active', 'exit',
      'interface Fa0/4', 'channel-group 1 mode active', 'exit',
      'interface Vlan10', 'ip address 10.10.0.2 255.255.255.0', 'exit',
      'ip default-gateway 10.10.0.1', 'ip domain-name lab.test', 'lldp run',
      'interface Fa0/5', 'no lldp transmit', 'exit',
      'spanning-tree vlan 10 priority 4096'],
    L31: ['hostname L31', 'vlan 30 name servers',
      'interface ' + l3p1, 'switchport mode access', 'switchport access vlan 30', 'exit',
      'interface Vlan30', 'ip address 192.168.30.1 255.255.255.0', 'exit',
      'ip routing', 'ip route 0.0.0.0 0.0.0.0 192.168.30.254'],
    R1: ['hostname R1',
      'interface Gi0/0', 'ip address 10.10.0.1 255.255.255.0', 'ip nat outside', 'exit',
      'interface Gi0/1', 'ip address 192.168.5.1 255.255.255.0', 'ip nat inside', 'exit',
      'ip route 10.0.0.0 255.255.0.0 10.10.0.254', 'ip domain-name lab.test',
      'arp 192.168.5.9 0200.0000.0009 arpa',
      'ip nat inside source static 192.168.5.10 10.10.0.99',
      'access-list 110 permit tcp 192.168.5.0 0.0.0.255 any eq 443',
      'ip nat inside source list 110 interface Gi0/0 overload',
      'router ospf 1', 'network 10.10.0.0 0.0.0.255 area 0',
      'network 192.168.5.0 0.0.0.255 area 1', 'router-id 1.1.1.1', 'exit',
      'interface Gi0/0', 'ip ospf cost 20', 'ip ospf passive', 'exit',
      'ip name-server 10.10.0.53'],
    PC1: ['hostname PC1', 'interface eth0', 'ip address 192.168.5.10 255.255.255.0', 'exit',
      'ip default-gateway 192.168.5.1'],
    SRV1: ['hostname SRV1', 'interface eth0', 'ip address 192.168.5.50 255.255.255.0', 'exit']
  };
}

function apply(env, config) {
  const refused = [];
  for (const dev of Object.keys(config)) {
    const s = env.s[dev];
    s.run('configure terminal');
    for (const line of config[dev]) {
      const out = s.run(line).output || [];
      const bad = out.filter(function (l) { return /^(%|Unexpected)/.test(l); });
      // `exit` at config level leaves config mode; the reference config never relies on that.
      if (bad.length) refused.push(dev + ': ' + line + ' -> ' + bad[0]);
    }
    s.run('end');
  }
  return refused;
}

function dumpAll(env) {
  const out = {};
  for (const k of Object.keys(env.s)) out[k] = env.s[k].run('show running-config').output;
  return out;
}

function paste(env, dumps) {
  for (const k of Object.keys(dumps)) {
    const s = env.s[k];
    s.run('configure terminal');
    for (const line of dumps[k]) {
      // The banner and the terminator are not commands to paste.
      if (/^!/.test(line) || /^end$/.test(line) || /^Building configuration/.test(line) ||
        /^Current configuration/.test(line)) continue;
      s.run(line);
    }
    s.run('end');
  }
}

console.log('\nEvery verb family this model has is accepted on the device that owns it:');
{
  const env = lab();
  const refused = apply(env, referenceConfig(env));
  ok(refused.length === 0, 'the reference configuration is accepted everywhere' +
    (refused.length ? ' (' + refused.join(' | ') + ')' : ''));
}

console.log('\nA dump pasted into an identical device produces the identical device:');
{
  const a = lab();
  apply(a, referenceConfig(a));
  const dumpA = dumpAll(a);
  const b = lab();
  paste(b, dumpA);
  const dumpB = dumpAll(b);
  for (const k of Object.keys(dumpA)) {
    const same = dumpA[k].join('\n') === dumpB[k].join('\n');
    ok(same, k + ': the pasted device dumps identically (' + dumpA[k].length + ' lines)' +
      (same ? '' : '\n      A: ' + JSON.stringify(dumpA[k].filter(function (l, i) { return l !== dumpB[k][i]; }).slice(0, 4)) +
        '\n      B: ' + JSON.stringify(dumpB[k].filter(function (l, i) { return l !== dumpA[k][i]; }).slice(0, 4))));
  }
  // Pasting twice must not accumulate anything either.
  const c = lab();
  paste(c, dumpA);
  paste(c, dumpA);
  const dumpC = dumpAll(c);
  for (const k of Object.keys(dumpA)) {
    eq(dumpC[k].join('\n'), dumpA[k].join('\n'), k + ': pasting the same dump twice changes nothing');
  }
  // And the state, not only the text: the port-security limits and the OSPF areas really landed.
  const sw = b.devices.SW1;
  const sec = sw.portSecurity && sw.portSecurity.ports['Fa0/1'];
  eq(sec && sec.maximum, 2, 'the pasted switch kept the port-security limit');
  eq(sec && sec.violation, 'restrict', 'and its violation mode');
  eq(sec && sec.agingTimeMin, 5, 'and its aging time');
  const r1 = b.devices.R1;
  eq(r1.config.ospf && r1.config.ospf.pid, 1, 'the pasted router kept the OSPF process');
  const areas = (r1.config.ospf.interfaces || []).map(function (x) { return x.name + '=' + x.area; }).sort();
  eq(areas.join(','), 'Gi0/0=0,Gi0/1=1', 'and both areas');
  eq((r1.config.nat && r1.config.nat.rules || []).length, 2, 'and both NAT rules');
}

console.log('\n`ip routing` is a switch with a real effect on the data path:');
{
  const env = lab();
  // Two SVIs on the L3 switch, so there is something to route between.
  const l3 = env.devices.L31, s = env.s.L31;
  s.run('configure terminal');
  s.run('vlan 30 name servers');
  s.run('interface ' + env.l3p[0]); s.run('switchport mode access'); s.run('switchport access vlan 30'); s.run('exit');
  s.run('interface ' + env.l3p[1]); s.run('switchport mode access'); s.run('switchport access vlan 40'); s.run('exit');
  s.run('interface Vlan30'); s.run('ip address 192.168.30.1 255.255.255.0'); s.run('exit');
  s.run('interface Vlan40'); s.run('ip address 192.168.40.1 255.255.255.0'); s.run('exit');
  match(/IP routing is already enabled on L31/, s.run('ip routing'), 'routing is on by default here');
  // Turn it off: the routes stay, the forwarding stops, and the show says so at the top.
  const off = s.run('no ip routing');
  match(/IP routing disabled on L31/, off, 'it can be turned off');
  match(/will not forward between its interfaces/, off, 'and the consequence is stated');
  match(/IP routing is disabled - these routes are configured but will not forward/,
    s.run('show ip route'), 'the routing table says its rows will not forward');
  match(/^no ip routing$/m, s.run('show running-config'), 'the setting is configuration, so it is dumped');
  match(/IP routing is already disabled on L31/, s.run('no ip routing'), 'turning it off twice says so');
  s.run('ip routing');
  ok(!/^no ip routing$/m.test(s.run('show running-config').output.join('\n')),
    'turning it back on removes the dump line');
  ok(!/IP routing is disabled/.test(s.run('show ip route').output.join('\n')),
    'and the routing table stops apologising');
  // A device that cannot route refuses the verb by naming what it has instead.
  const host = new CliSession(env.devices.PC1, env.t, env.sim);
  host.run('enable'); host.run('configure terminal');
  const refused = host.run('ip routing');
  match(/is not a router/, refused, 'a host is refused by name');
  match(/ip default-gateway/, refused, 'and pointed at the command it does have');
}

console.log('\n`switchport` typed at global scope is answered, not called a typo:');
{
  const env = lab();
  const s = env.s.SW1;
  s.run('configure terminal');
  const out = s.run('switchport mode access');
  match(/switchport is configured per interface: enter one first/, out,
    'the refusal names the mode the verb lives in');
  match(/switchport port-security/, out, 'and the verbs it takes');
  // In interface mode the same line is the real command.
  s.run('interface Fa0/1');
  match(/Switchport mode access on Fa0\/1/, s.run('switchport mode access'),
    'and inside an interface it is the command itself');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
