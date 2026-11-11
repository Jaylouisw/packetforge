'use strict';
// An address is an address (#1411).
//
// Found by asking one question of every door that takes an address: *what happens if I type one that cannot
// exist?* `net.isIp()` answered it for most of them, and its answer was a shape check - four dotted groups of one
// to three digits - so `300.1.1.1` and `10.0.0.999` were addresses. Eight doors accepted them and stored them:
//
//   r1(config)#ip name-server 300.1.1.1        → Name server 300.1.1.1
//   r1(config)#ip default-gateway 300.1.1.1    → Default gateway: 300.1.1.1
//   r1(config)#ip route 300.1.1.0 255.255.255.0 10.1.1.9
//                                              → Route added: 300.1.1.0/24 via 10.1.1.9
//   r1(config)#ip route 192.0.2.0 255.255.255.0 300.1.1.9
//                                              → Route added: 192.0.2.0/24 via 300.1.1.9
//   r1(config)#ip nat pool NP 300.1.1.1 300.1.1.9 netmask 255.255.255.0
//                                              → NAT pool "NP" 300.1.1.1 - 300.1.1.9 ...
//   r1(config-router)#neighbor 300.1.1.1 remote-as 65002
//                                              → BGP neighbor 300.1.1.1 remote-as 65002
//
// Meanwhile `ip address`, `vrrp 1 ip` and `ping` refused the same address with a sentence, because they asked
// `ipToInt()` - the parser that has always checked the octets. Two related defects turned up in the same sweep:
// `ip route` "validated" its mask by calling `maskToInt()` and throwing the result away, so a non-contiguous mask
// became a different prefix (255.0.255.0 → /8, "Route added: 192.0.2.0/8"), and an `access-list` refusal printed
// `% [object Object]`.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const net = require('../engine/net');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = function (m) { return catalog.find(function (x) { return x.model === m; }); };

function cli(t, d, cmds) {
  return runCommands(d, t, null, ['enable', 'configure terminal'].concat(cmds)).lines
    .filter(function (l) { return !/\(config|>enable|#configure/.test(String(l)); });
}
function show(t, d, cmd) {
  const s = new Simulator(t);
  s.setRunTime(60000);
  return runCommands(d, t, s, ['enable', cmd]).lines.join('\n');
}
function lab() {
  const t = new Topology();
  const d = t.addDevice(spec('ISR 4331'), 'r1');
  const port = Array.from(d.interfaces.values()).filter(function (p) { return p.type === 'ethernet'; })[0].name;
  return { t: t, d: d, port: port };
}

console.log('The predicate asks whether the octets are in range');
{
  ok(!net.isIp('300.1.1.1'), '300.1.1.1 is not an address');
  ok(!net.isIp('10.0.0.999'), '10.0.0.999 is not an address');
  ok(!net.isIp('9999.1.1.1'), 'a five-digit group is not an address');
  ok(!net.isIp('1.2.3') && !net.isIp('1.2.3.4.5'), 'and the wrong number of groups is not one');
  ok(!net.isIp('') && !net.isIp('abc') && !net.isIp(null) && !net.isIp(undefined),
    'nor is nothing, a word, or a missing value');
  ok(net.isIp('10.0.0.1') && net.isIp('255.255.255.255') && net.isIp('0.0.0.0'),
    'the whole legal range still is', [net.isIp('10.0.0.1'), net.isIp('255.255.255.255'), net.isIp('0.0.0.0')].join());
  ok(net.isIp(' 10.0.0.1 '), 'and surrounding spaces are still tolerated, as before');
}

console.log('');
console.log('Every door that takes an address refuses one that cannot exist');
{
  const DOORS = [
    ['ip name-server 300.1.1.1', /Invalid name server "300\.1\.1\.1"/],
    ['ip name-server 10.0.0.999', /Invalid name server "10\.0\.0\.999"/],
    ['ip default-gateway 300.1.1.1', /Invalid default gateway "300\.1\.1\.1"/],
    ['ip route 300.1.1.0 255.255.255.0 10.1.1.9', /Invalid destination "300\.1\.1\.0"/],
    ['ip route 192.0.2.0 255.255.255.0 300.1.1.9', /"300\.1\.1\.9" is neither a next-hop address nor an interface/],
    ['ip nat pool NP 300.1.1.1 300.1.1.9 netmask 255.255.255.0', /Invalid pool address "300\.1\.1\.1"/],
    ['ip nat inside source static 300.1.1.1 10.0.0.5', /Invalid address "300\.1\.1\.1" in a static NAT rule/],
    ['ospf router-id 300.1.1.1', /Invalid router-id "300\.1\.1\.1"/]
  ];
  const bad = [];
  for (const [cmd, pattern] of DOORS) {
    const { t, d } = lab();
    const said = cli(t, d, [cmd]);
    const refusal = said.filter(function (l) { return /^%/.test(String(l)); })[0] || '';
    if (!pattern.test(refusal)) bad.push(cmd + ' -> ' + JSON.stringify(said));
    // And nothing of it reaches the configuration.
    const rc = show(t, d, 'show running-config');
    if (/300\.1\.1|999/.test(rc)) bad.push(cmd + ' was stored: ' + rc.split('\n').filter(function (l) { return /300\.1\.1|999/.test(l); }).join(' | '));
  }
  ok(bad.length === 0, 'eight doors refuse, and the address never reaches the config', bad.slice(0, 4).join(' ;; '));

  // The BGP neighbour is guarded by the predicate itself, so it needed its own branch to be able to say why.
  const { t, d } = lab();
  const said = cli(t, d, ['router bgp 65001', 'neighbor 300.1.1.1 remote-as 65002']);
  ok(said.some(function (l) { return /Invalid neighbor address "300\.1\.1\.1"/.test(String(l)); }),
    'and a BGP neighbour names the address, not the whole syntax', JSON.stringify(said));

  // A refusal has to be readable. The access-list path printed the error object.
  const t2 = lab();
  const acl = cli(t2.t, t2.d, ['access-list 10 permit 300.1.1.0 0.0.0.255']);
  ok(acl.length === 1 && /^% /.test(acl[0]) && !/object Object/.test(acl[0]),
    'an ACL refusal is a sentence with a reason in it', JSON.stringify(acl));
}

console.log('');
console.log('A mask is a mask: the routing door applies the rule the port door always had');
{
  const { t, d } = lab();
  const said = cli(t, d, ['ip route 192.0.2.0 255.0.255.0 10.1.1.9']);
  ok(/^% Invalid mask: 255\.0\.255\.0 - a netmask is a run of ones then zeros/.test(said[0]),
    'a non-contiguous mask is refused with the sentence `ip address` uses', JSON.stringify(said));
  ok(!/192\.0\.2\.0\/8/.test(show(t, d, 'show ip route')), 'and no /8 route was invented');
  ok(/^% Invalid mask: 255\.255\.0\.255/.test(cli(t, d, ['ip route 192.0.2.0 255.255.0.255 10.1.1.9'])[0]),
    'the other way round too');
  ok(/"\/24\/"|192\.0\.2\.0\/24/.test(cli(t, d, ['ip route 192.0.2.0 24 10.1.1.9'])[0] || ''),
    'a prefix length is still accepted', JSON.stringify(cli(t, d, ['ip route 192.0.2.0 24 10.1.1.9'])));
  ok(/Route added: 192\.0\.2\.0\/25/.test(cli(t, d, ['ip route 192.0.2.0 255.255.255.128 10.1.1.9'])[0]),
    'and so is a legitimate /25');
  // The NAT pool's netmask is read by the same prefix arithmetic, so it is asked the same question.
  ok(/Invalid netmask: 255\.0\.255\.0/.test(cli(t, d, ['ip nat pool NP 10.0.0.1 10.0.0.9 netmask 255.0.255.0'])[0]),
    'and a NAT pool netmask is asked the same question');
}

console.log('');
console.log('A route with nowhere to send a packet is not installed');
{
  const { t, d } = lab();
  const said = cli(t, d, ['ip route 192.0.2.0 255.255.255.0']);
  ok(/^% Incomplete command: ip route 192\.0\.2\.0 255\.255\.255\.0 needs a next hop or an interface/.test(said[0]),
    'no next hop and no interface is refused as incomplete', JSON.stringify(said));
  ok(!/192\.0\.2\.0/.test(show(t, d, 'show ip route')), 'and nothing was added to the table');
  ok(!/192\.0\.2\.0/.test(show(t, d, 'show running-config')), 'nor to the config');
  // The interface-only form is legal (a segment to ARP on) and must keep working, with its caveat.
  const viaIface = cli(t, d, ['ip route 192.0.2.0 255.255.255.0 ' + Array.from(d.interfaces.values())[0].name]);
  ok(viaIface.some(function (l) { return /Route added: 192\.0\.2\.0\/24 out /.test(String(l)); }),
    'an interface-only static is still accepted', JSON.stringify(viaIface));
  ok(viaIface.some(function (l) { return /no next hop: this resolves by ARP on that segment/.test(String(l)); }),
    'and still says what it will take to work');
}

console.log('');
console.log('The same rule everywhere: an address typed at any door gets the same verdict');
{
  const BAD = ['300.1.1.1', '10.0.0.999', '1.2.3', '9999.1.1.1', '0.0.0.256'];
  const doors = function (addr, port) {
    return [
      ['ip name-server ' + addr],
      ['ip default-gateway ' + addr],
      ['ip route ' + addr + ' 255.255.255.0 10.1.1.9'],
      ['ip route 192.0.2.0 255.255.255.0 ' + addr],
      ['ip nat pool NP ' + addr + ' 10.0.0.9 netmask 255.255.255.0'],
      ['ip nat inside source static ' + addr + ' 10.0.0.5'],
      ['ospf router-id ' + addr],
      ['router bgp 65001', 'neighbor ' + addr + ' remote-as 65002'],
      ['interface ' + port, 'ip address ' + addr + ' 255.255.255.0'],
      ['interface ' + port, 'ip address 10.5.5.1 255.255.255.0', 'vrrp 1 ip ' + addr]
    ];
  };
  const leaked = [];
  let checked = 0;
  for (const addr of BAD) {
    for (const cmds of doors(addr)) {
      const { t, d, port } = lab();
      const sub = cmds.map(function (c) { return c.replace(/\bP\b/g, port); });
      cli(t, d, sub);
      checked++;
      const rc = show(t, d, 'show running-config');
      const table = show(t, d, 'show ip route');
      if (rc.indexOf(addr) !== -1) leaked.push('config: ' + sub.join('; ') + ' -> ' + addr);
      if (table.indexOf(addr) !== -1) leaked.push('table: ' + sub.join('; ') + ' -> ' + addr);
    }
  }
  ok(checked >= 50, 'every bad address was tried at every door', String(checked));
  ok(leaked.length === 0, 'and none of them reached a configuration or a routing table', leaked.slice(0, 5).join(' ;; '));
}

console.log('');
console.log('Nothing was over-refused: the legal forms still work at every door');
{
  const GOOD = [
    ['ip name-server 10.9.9.9', /Name server 10\.9\.9\.9/],
    ['ip default-gateway 10.1.1.1', /Default gateway: 10\.1\.1\.1/],
    ['ip route 192.0.2.0 255.255.255.0 10.1.1.9', /Route added: 192\.0\.2\.0\/24 via 10\.1\.1\.9/],
    ['ip nat pool NP 10.0.0.1 10.0.0.9 netmask 255.255.255.0', /NAT pool "NP"/],
    ['ip nat inside source static 10.0.0.5 198.51.100.5', /static|NAT/i],
    ['ospf router-id 1.1.1.1', /OSPF|router-id/],
    ['router bgp 65001', /BGP enabled/]
  ];
  const broken = [];
  for (const [cmd, pattern] of GOOD) {
    const { t, d } = lab();
    const said = cli(t, d, [cmd]);
    const refused = said.filter(function (l) { return /^%/.test(String(l)); });
    if (refused.length || !said.some(function (l) { return pattern.test(String(l)); })) {
      broken.push(cmd + ' -> ' + JSON.stringify(said));
    }
  }
  ok(broken.length === 0, 'all seven legal forms are still accepted', broken.join(' ;; '));
}

console.log('');
console.log('Measured over the catalogue');
{
  const leaked = [];
  let checked = 0;
  for (const s of catalog) {
    // Not an exemption, ordinary control flow: a model that cannot route has no route command to test, and the
    // catalogue includes models that failed to load.
    if (s.error) continue;
    if (!Array.isArray(s.capabilities) || s.capabilities.indexOf('l3-forward') === -1) continue;
    const t = new Topology();
    const d = t.addDevice(s, 'd1');
    const port = Array.from(d.interfaces.values()).filter(function (p) { return p.type === 'ethernet'; })[0];
    if (!port) continue;
    checked++;
    cli(t, d, ['ip name-server 300.1.1.1', 'ip default-gateway 300.1.1.1',
      'ip route 300.1.1.0 255.255.255.0 10.1.1.9']);
    const rc = show(t, d, 'show running-config');
    if (/300\.1\.1/.test(rc)) leaked.push(s.model + ': ' + rc.split('\n').filter(function (l) { return /300\.1\.1/.test(l); })[0]);
  }
  ok(checked > 500, 'the sweep covered every model that can route', String(checked));
  ok(leaked.length === 0, 'and none of them stored an address that cannot exist', leaked.slice(0, 4).join(' ;; '));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
