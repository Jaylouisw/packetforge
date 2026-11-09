'use strict';
// A port has one method, and the console says which it displaced (#1286).
//
// `ip address dhcp` set the DHCP flag and left the static address on the interface, so one port held two
// methods at once. Three surfaces then disagreed about the same port:
//
//   * the interface kept an address it did not own, and `routeTo()` would route for it;
//   * `show ip interface brief` reported Method `DHCP` beside that address;
//   * `show running-config` printed only the static line, so restoring the backup lost the DHCP intent.
//
// The reverse direction - a static address over a DHCP client - already cleared the flag, but silently, so
// the operator could not tell which of the two was now in force. Both directions now displace, and both say
// what they displaced. `no ip address` stops claiming to remove an address when there was none.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }

const ROUTER = spec('generic-router');
const PC = spec('generic-pc');

function router() {
  const t = new Topology();
  const d = t.addDevice(ROUTER, 'r1');
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  s.run('configure terminal');
  s.run('interface Gi0/0');
  return { t: t, d: d, s: s, iface: d.interfaces.get('Gi0/0'),
    say: function (c) { return ((s.run(c).output) || []).map(String); } };
}

function methodOf(iface) {
  if (iface.dhcp) return 'dhcp';
  if (iface.ip) return 'static';
  return 'none';
}

console.log('');
console.log('A static address does not survive `ip address dhcp`:');
{
  const env = router();
  env.say('ip address 10.0.0.1 255.255.255.0');
  ok(methodOf(env.iface) === 'static', 'the port is static to begin with', methodOf(env.iface));
  const out = env.say('ip address dhcp');
  ok(methodOf(env.iface) === 'dhcp', 'and DHCP afterwards', methodOf(env.iface));
  ok(env.iface.ip === null, 'with no address left over from the static configuration',
    JSON.stringify(env.iface.ip));
  ok(/static address 10\.0\.0\.1\/24 removed/.test(out.join(' ')),
    'and the console names the address it displaced', JSON.stringify(out));

  env.s. run('end');
  const cfg = env.say('show running-config').filter(function (l) { return /ip address/.test(l); });
  ok(cfg.length === 1 && /ip address dhcp/.test(cfg[0]),
    'the backup says the port asks DHCP, and nothing else', JSON.stringify(cfg));
  const brief = env.say('show ip interface brief').filter(function (l) { return /Gi0\/0/.test(l); })[0] || '';
  ok(!/\d+\.\d+\.\d+\.\d+.*DHCP|DHCP.*\d+\.\d+\.\d+\.\d+\/.*(manual|DHCP)/.test(brief),
    'and `show ip interface brief` does not report an address beside Method DHCP', brief);
}

console.log('');
console.log('A static address does not leave the DHCP client behind:');
{
  const env = router();
  env.say('ip address dhcp');
  ok(methodOf(env.iface) === 'dhcp', 'the port asks DHCP to begin with', methodOf(env.iface));
  const out = env.say('ip address 10.0.0.1 255.255.255.0');
  ok(methodOf(env.iface) === 'static', 'and holds a static address afterwards', methodOf(env.iface));
  ok(/DHCP client removed/.test(out.join(' ')), 'the console says it stopped asking', JSON.stringify(out));
  env.s.run('end');
  const cfg = env.say('show running-config').filter(function (l) { return /ip address/.test(l); });
  ok(cfg.length === 1 && /ip address 10\.0\.0\.1 255\.255\.255\.0/.test(cfg[0]),
    'the backup prints one method', JSON.stringify(cfg));
}

console.log('');
console.log('`no ip address` reports what was there:');
{
  const env = router();
  ok(/% No IP address on Gi0\/0/.test(env.say('no ip address').join(' ')),
    'nothing to remove is refused by name', JSON.stringify(env.say('no ip address')));

  const env2 = router();
  env2.say('ip address 10.0.0.9 255.255.255.0');
  const out2 = env2.say('no ip address').join(' ');
  ok(/10\.0\.0\.9\/24 removed/.test(out2), 'a static address is named as it goes', out2);
  ok(methodOf(env2.iface) === 'none', 'and the port is left with no method', methodOf(env2.iface));

  const env3 = router();
  env3.say('ip address dhcp');
  const out3 = env3.say('no ip address').join(' ');
  ok(/DHCP client removed/.test(out3), 'a DHCP client is named as it goes', out3);
  ok(!/IP address .*removed/.test(out3), 'and is not called an address', out3);
  ok(methodOf(env3.iface) === 'none', 'leaving no method behind', methodOf(env3.iface));
}

console.log('');
console.log('One method per port, across every port of a device, after any history:');
{
  // The sweep is the point: the invariant has to hold for a whole config, not just the one port a test
  // happened to type into.
  const env = router();
  env.s.run('end');
  env.s.run('configure terminal');
  const base = 'ip address 10.0.0.1 255.255.255.0';
  const histories = [
    [base, 'ip address dhcp'],
    ['ip address dhcp', base],
    [base, 'ip address dhcp', base],
    ['ip address dhcp', base, 'ip address dhcp'],
    [base, 'no ip address', 'ip address dhcp']
  ];
  let checked = 0, bad = [];
  for (const history of histories) {
    for (const port of ['Gi0/0', 'Gi0/1', 'Gi0/2']) {
      const t = new Topology();
      const d = t.addDevice(ROUTER, 'r1');
      const s = new CliSession(d, t, new Simulator(t));
      s.run('enable'); s.run('configure terminal'); s.run('interface ' + port);
      for (const cmd of history) s.run(cmd);
      const i = d.interfaces.get(port);
      checked++;
      if (i.ip && i.dhcp) bad.push(port + ' ' + history.join(' / '));
      if (i.ip && !i.mask) bad.push(port + ' address with no mask');
    }
  }
  ok(bad.length === 0, histories.length * 3 + ' port histories leave exactly one method',
    JSON.stringify(bad.slice(0, 3)));
  ok(checked === 15, 'all fifteen were checked', String(checked));
}

console.log('');
console.log('The consequence: a host moved from a static address to DHCP gets a real lease');
{
  const topo = new Topology();
  const r = topo.addDevice(ROUTER);
  r.name = 'R1';
  const sim = new Simulator(topo);
  const cli = function (dev, cmds) { return runCommands(dev, topo, sim, cmds).lines; };
  const pc = topo.addDevice(PC);
  pc.name = 'PC1';
  topo.connect(pc.id, 'eth0', r.id, 'Gi0/0');

  cli(r, ['enable', 'configure terminal',
    'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'ip dhcp pool lan', 'network 10.0.0.0 255.255.255.0', 'default-router 10.0.0.1',
    'range 10.0.0.100 10.0.0.110', 'exit', 'end']);

  // The host starts on a static address in the range the pool would not hand out, so a lease is proof the
  // client asked and was answered rather than the old address being kept.
  cli(pc, ['enable', 'configure terminal', 'interface eth0',
    'ip address 10.0.0.55 255.255.255.0', 'exit', 'end']);
  ok(pc.interfaces.get('eth0').ip === '10.0.0.55', 'the host starts on its static address');

  const out = cli(pc, ['configure terminal', 'interface eth0', 'ip address dhcp', 'exit', 'end']);
  ok(out.join(' ').indexOf('static address 10.0.0.55/24 removed') !== -1,
    'it is told the static address went', JSON.stringify(out));
  ok(pc.interfaces.get('eth0').ip === null, 'the interface is empty before the exchange',
    JSON.stringify(pc.interfaces.get('eth0').ip));

  const res = sim.ping(pc.id, '10.0.0.1', { count: 1 });
  const ack = res.events.filter(function (e) { return e.type === 'dhcp' && e.phase === 'ack'; })[0];
  ok(!!ack, 'it gets an ACK');
  ok(ack && ack.ip === '10.0.0.100', 'with a pool address, not the static one it used to have',
    ack && ack.ip);
  ok(pc.interfaces.get('eth0').ip === '10.0.0.100', 'and the interface holds it',
    pc.interfaces.get('eth0').ip);
  ok(res.replies[0].success, 'so the ping succeeds');

  const cfg = cli(pc, ['end', 'show running-config']).filter(function (l) { return /ip address/.test(l); });
  ok(cfg.length === 1 && /ip address dhcp/.test(cfg[0]),
    'and the backup says DHCP, not the address it leased', JSON.stringify(cfg));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
