'use strict';
// running-config.test.js — the dump must carry every protocol the CLI can
// configure, not just hostname / interfaces / ACLs / routes. A `show
// running-config` that drops OSPF, BGP, VRRP, DNS, SCION, DHCP pools or IPv6 is
// a config that lies about what the device is doing, and one you cannot paste
// back into a fresh box.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = catalog.find(function (s) { return s.vendor === 'generic' && s.model === 'generic-router'; });
ok(!!spec, 'the generic-router spec is in the catalogue');

const t = new Topology();
const r = t.addDevice(spec);
const sim = new Simulator(t);
const cli = new CliSession(r, t, sim);

function run(cmd) { return cli.run(cmd).output.join('\n'); }

cli.run('configure terminal');
cli.run('hostname R1');
cli.run('vlan 10 LAB10');
cli.run('ospf router-id 1.1.1.1');
cli.run('interface Gi0/0');
cli.run('ip address 10.0.0.1 255.255.255.0');
cli.run('ip ospf cost 10');
cli.run('ip ospf passive');
cli.run('vrrp 10 ip 10.0.0.254');
cli.run('vrrp 10 priority 120');
cli.run('ipv6 address 2001:db8::1/64');
cli.run('exit');
cli.run('router bgp 65001');
cli.run('bgp router-id 1.1.1.1');
cli.run('neighbor 10.0.0.2 remote-as 65002');
cli.run('dns zone lab.example');
cli.run('dns add www.lab.example A 10.0.0.10');
cli.run('ip name-server 10.0.0.53');
cli.run('scion 1-ff00:0:110');
cli.run('ip dhcp pool LAB');
cli.run('network 10.0.0.0 255.255.255.0');
cli.run('range 10.0.0.100 10.0.0.200');
cli.run('default-router 10.0.0.1');
cli.run('lease 0 12 0');
cli.run('exit');

const text = run('show running-config');

// 'do show ...' must answer the same thing from config mode, not "% Invalid
// show command: show ..." (the off-by-one that made the alias useless).
const viaDo = run('do show running-config');
ok(viaDo.indexOf('! PacketForge running-config') !== -1, 'do show running-config works from config mode');

ok(/hostname R1/.test(text), 'running-config carries the hostname');
ok(/vlan 10 LAB10/.test(text), 'running-config carries the VLAN declaration');
ok(/ospf router-id 1\.1\.1\.1/.test(text), 'running-config carries the OSPF process');
ok(/ip ospf cost 10/.test(text), 'running-config carries the OSPF interface cost');
ok(/ip ospf passive/.test(text), 'running-config carries the passive interface');

ok(/router bgp 65001/.test(text), 'running-config carries the BGP process');
ok(/bgp router-id 1\.1\.1\.1/.test(text), 'running-config carries the BGP router-id');
ok(/neighbor 10\.0\.0\.2 remote-as 65002/.test(text), 'running-config carries the BGP neighbour');

ok(/vrrp 10 ip 10\.0\.0\.254/.test(text), 'running-config carries the VRRP virtual IP');
ok(/vrrp 10 priority 120/.test(text), 'running-config carries the VRRP priority');

const zone = (r.config.dnsZones && r.config.dnsZones[0] && r.config.dnsZones[0].name) || '';
ok(text.indexOf('dns zone ' + zone) !== -1, 'running-config carries the DNS zone');
ok(/dns add www\.lab\.example A 10\.0\.0\.10/.test(text), 'running-config carries the DNS record');
ok(/ip name-server 10\.0\.0\.53/.test(text), 'running-config carries the name server');

ok(text.indexOf('scion ' + r.config.scionAs) !== -1, 'running-config carries SCION membership');

ok(/ip dhcp pool LAB/.test(text), 'running-config carries the DHCP pool');
ok(/network 10\.0\.0\.0 255\.255\.255\.0/.test(text), 'running-config carries the pool network');
ok(/range 10\.0\.0\.100 10\.0\.0\.200/.test(text), 'running-config carries the pool range');
ok(/default-router 10\.0\.0\.1/.test(text), 'running-config carries the pool default-router');
ok(/lease 0 12 0/.test(text), 'running-config carries the lease as days/hours/minutes');

const v6 = (r.config.ip6 && r.config.ip6['Gi0/0'] && r.config.ip6['Gi0/0'].addr) || '';
ok(!!v6 && text.indexOf('ipv6 address ' + v6 + '/64') !== -1, 'running-config carries the IPv6 address');

console.log('\nA row that advertises several complete commands owes every one of them:');
{
  // The help row is `bgp router-id <ip> | bgp neighbor <ip> remote-as <as> | no bgp neighbor <ip>`.
  // The console accepted the first and refused the second with a usage line, and the help sweep could
  // not see it: `bgp neighbor …` in a session with no BGP enabled answers `% BGP is not enabled`, which
  // reads as "recognised" to a sweep that only knows shape complaints. So the spelling is pinned here,
  // where BGP is actually on - and the paste of the dump is pinned with it, because a spelling that
  // only exists in help is a spelling that comes back as a refusal when the dump is replayed.
  const t = new Topology();
  const r = t.addDevice(spec);
  r.name = 'R1';
  const sim = new Simulator(t);
  const c = (function () {
    const s = new CliSession(r, t, sim);
    return { run: function () {
      const o = [];
      for (const cmd of Array.prototype.slice.call(arguments)) o.push.apply(o, s.run(cmd).output);
      return o;
    } };
  })();
  c.run('enable', 'configure terminal', 'router bgp 65001', 'bgp router-id 1.1.1.1');
  const documented = c.run('bgp neighbor 10.0.12.2 remote-as 65002').join('\n');
  ok(/BGP neighbor 10\.0\.12\.2 remote-as 65002/.test(documented), 'bgp neighbor … remote-as … is accepted');
  ok(!/% Usage/.test(documented), 'and not answered with a usage line');
  c.run('exit');
  const dump = c.run('show running-config').filter(function (l) { return !/^[^\s#>]+[#>]\s?/.test(l); });
  ok(dump.some(function (l) { return /^neighbor 10\.0\.12\.2 remote-as 65002$/.test(l); }),
    'the dump prints the neighbour in the form that needs no prefix');
  // Both spellings mean the same thing, so the dump's form must be accepted as well.
  const other = c.run('configure terminal', 'neighbor 10.0.12.3 remote-as 65003', 'exit').join('\n');
  ok(/BGP neighbor 10\.0\.12\.3 remote-as 65003/.test(other), 'the dump spelling is accepted too');
  // And `no bgp neighbor`, the third alternative in the row.
  const removed = c.run('configure terminal', 'no bgp neighbor 10.0.12.2', 'exit').join('\n');
  ok(/Removed neighbor 10\.0\.12\.2/.test(removed), 'no bgp neighbor … removes it');
  const gone = c.run('show running-config').join('\n');
  ok(!/10\.0\.12\.2 remote-as/.test(gone), 'and the dump no longer lists it');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
