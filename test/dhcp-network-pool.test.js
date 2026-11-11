'use strict';
// dhcp-network-pool.test.js - `network` is the address range, as it is on a router.
//
//   R1(config)#ip dhcp pool LAN
//   R1(config-dhcp)#network 10.0.0.0 255.255.255.0
//   R1(config-dhcp)#default-router 10.0.0.1
//   R1(config-dhcp)#exit
//   % DHCP pool LAN: no address range was given - "range <start> <end>" is required.
//   % Pool LAN discarded - a pool is kept only once it is valid
//   PC1#show ip interface brief
//   eth0  unassigned  YES  DHCP  up  up
//
// On a router `network <net> <mask>` IS the address range: leases come from that subnet, and the
// addresses the router holds are never among them. Here the canonical way to configure DHCP was
// accepted in silence and then thrown away at `exit`, so the client's answer was "no DHCP server in
// this broadcast domain" while a DHCP server sat on its own wire.
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

function lab() {
  const t = new Topology();
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const pc = t.addDevice(find('generic-pc')); pc.name = 'PC1';
  const swp = Array.from(sw.interfaces.values()).filter(function (i) { return !i.svi; }).map(function (i) { return i.name; });
  t.connect(r.id, 'Gi0/0', sw.id, swp[0]);
  t.connect(sw.id, swp[1], pc.id, Array.from(pc.interfaces.values())[0].name);
  const sim = new Simulator(t);
  const s = new CliSession(r, t, sim); s.run('enable');
  const sp = new CliSession(pc, t, sim); sp.run('enable');
  s.run('configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', 'end');
  return { t: t, sim: sim, r: r, sw: sw, pc: pc, s: s, sp: sp };
}

console.log('A pool whose network is its range is a pool:');
{
  const env = lab();
  env.s.run('configure terminal', 'ip dhcp pool LAN');
  const line = text(env.s.run('network 10.0.0.0 255.255.255.0'));
  // Silent, like every other line in this sub-mode; the range it implies is reported by the view.
  ok(!/^%/.test(line), 'the network line is accepted without a range');
  env.s.run('default-router 10.0.0.1', 'exit');
  env.s.run('end');
  const pools = text(env.s.run('show ip dhcp pool'));
  ok(/DHCP pools on R1/.test(pools), 'the pool survived exit');
  ok(/Range\s+: 10\.0\.0\.1 - 10\.0\.0\.254/.test(pools), 'and reports the range it will use');
  ok(/Not leased : 10\.0\.0\.1 \(this router\)/.test(pools),
    'and says the router\'s own address is not among them');
  const run = text(env.s.run('show running-config'));
  ok(/^ip dhcp pool LAN$/m.test(run), 'the running-config has the pool');
  ok(/^  network 10\.0\.0\.0 255\.255\.255\.0$/m.test(run), 'with the network line');
  ok(!/^  range /m.test(run), 'and no range line it was never given');
}

console.log('\nA client on that wire gets a lease, and not the router\'s address:');
{
  const env = lab();
  env.s.run('configure terminal', 'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0',
    'default-router 10.0.0.1', 'exit', 'end');
  env.sp.run('configure terminal', 'interface eth0', 'ip address dhcp', 'end');
  const brief = text(env.sp.run('show ip interface brief'));
  ok(/10\.0\.0\.2\/24/.test(brief), 'the client is given 10.0.0.2/24');
  ok(!/10\.0\.0\.1\/24/.test(brief), 'and never the router\'s own 10.0.0.1');
  const lease = text(env.sp.run('show dhcp lease'));
  ok(/10\.0\.0\.2/.test(lease), 'the lease view agrees');
  ok(/Gateway\s+: 10\.0\.0\.1/.test(lease), 'and carries the default router');
  const bind = text(env.s.run('show ip dhcp binding'));
  ok(/02:00:00:00:02:00\s+10\.0\.0\.2/.test(bind), 'the server lists the binding under the client MAC');
}

console.log('\nAn explicit range still narrows the pool:');
{
  const env = lab();
  env.s.run('configure terminal', 'ip dhcp pool NARROW', 'network 10.0.0.0 255.255.255.0',
    'range 10.0.0.100 10.0.0.101', 'default-router 10.0.0.1', 'exit');
  env.s.run('no ip dhcp pool LAN', 'end');
  env.sp.run('configure terminal', 'interface eth0', 'ip address dhcp', 'end');
  const brief = text(env.sp.run('show ip interface brief'));
  ok(/10\.0\.0\.100\/24/.test(brief), 'the lease comes from inside the narrower range');
  const run = text(env.s.run('show running-config'));
  ok(/^  range 10\.0\.0\.100 10\.0\.0\.101$/m.test(run), 'and the range is what the config carries');
}

console.log('\nA pool with neither network nor range is still not a pool:');
{
  const env = lab();
  env.s.run('configure terminal', 'ip dhcp pool EMPTY');
  const out = text(env.s.run('exit'));
  ok(/discarded/.test(out), 'the pool is discarded');
  ok(/no network and no address range/.test(out), 'and the reason names both missing pieces');
  ok(/"network <network> <mask>"/.test(out), 'the network form is offered as a way to complete it');
  ok(/"range <start> <end>"/.test(out), 'and so is the range form');
  env.s.run('end');
  ok(/has no DHCP pools/.test(text(env.s.run('show ip dhcp pool'))), 'and the device has no pools');
}

console.log('\nThe pool survives a save and a reload of the saved copy:');
{
  const env = lab();
  env.s.run('configure terminal', 'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0',
    'default-router 10.0.0.1', 'exit', 'end');
  env.s.run('write memory');
  env.s.run('configure terminal', 'no ip dhcp pool LAN', 'end');
  ok(/has no DHCP pools/.test(text(env.s.run('show ip dhcp pool'))), 'the pool was removed');
  env.s.run('copy startup-config running-config');
  const pools = text(env.s.run('show ip dhcp pool'));
  ok(/DHCP pools on R1/.test(pools) && /10\.0\.0\.0/.test(pools), 'and the saved copy puts it back');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
