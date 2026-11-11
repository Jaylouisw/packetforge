'use strict';
// value-bounds.test.js - an address that cannot answer, and a number out of range.
//
//   R1(config-if)#ip helper-address 0.0.0.0
//   Helper address 0.0.0.0 on Gi0/0 (DHCP requests will be relayed to it)
//
// A relay sends a unicast to one server. 0.0.0.0, 255.255.255.255, a multicast group and a loopback
// address were all accepted with that sentence - four targets that cannot answer, each one a relay
// that silently relays nothing. The same sweep found a mask that addresses nothing, a multicast
// address held by an interface, a default speed dumped as configuration, and VRRP ranges judged after
// the group was looked for.
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
  const sim = new Simulator(t);
  const R = new CliSession(r, t, sim); R.run('enable');
  R.run('configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', 'end');
  return { t: t, sim: sim, r: r, R: R };
}
const run = function (env, line) {
  return text(env.R.run('configure terminal', 'interface Gi0/0', line, 'exit', 'end'));
};
const helpers = function (env) {
  const i = env.r.interfaces.get('Gi0/0');
  return i.helperAddresses || [];
};
const dump = function (env, re) {
  return text(env.R.run('show running-config')).split('\n').filter(function (l) { return re.test(l); });
};

console.log('A relay target that cannot answer is refused, and the class is named:');
{
  const cases = [
    ['ip helper-address 0.0.0.0', /zero address/],
    ['ip helper-address 255.255.255.255', /limited broadcast/],
    ['ip helper-address 224.0.0.9', /multicast group address/],
    ['ip helper-address 127.0.0.1', /loopback address/],
  ];
  for (const [line, want] of cases) {
    const env = lab();
    const out = run(env, line);
    ok(want.test(out), line + ' is refused for what it is');
    ok(/one unicast address/.test(out), 'and the refusal says what a helper target must be');
    ok(helpers(env).length === 0, 'and nothing was stored');
    ok(!/will be relayed/.test(out), 'no promise of a relay was made');
  }
}

console.log('\nA real server address is still accepted:');
{
  const env = lab();
  const out = run(env, 'ip helper-address 10.0.0.53');
  ok(/Helper address 10\.0\.0\.53 on Gi0\/0/.test(out), 'a unicast address is taken');
  ok(JSON.stringify(helpers(env)) === JSON.stringify(['10.0.0.53']), 'and stored on the port');
}

console.log('\nA mask of 0.0.0.0 is not a mask for an interface:');
{
  const env = lab();
  const out = run(env, 'ip address 10.0.0.1 0.0.0.0');
  ok(/0\.0\.0\.0 addresses nothing/.test(out), 'the zero mask is refused');
  ok(/255\.255\.255\.255 \(\/32\)/.test(out), 'and the smallest useful masks are named');
  const kept = env.r.interfaces.get('Gi0/0').ip;
  ok(/10\.0\.0\.1/.test(String(kept)), 'the port keeps the address it had');
}

console.log('\nA multicast or reserved address cannot be an interface address:');
{
  for (const [line, kind] of [['ip address 224.0.0.1 255.255.255.0', /multicast \(class D\)/],
    ['ip address 240.0.0.1 255.255.255.0', /reserved \(class E\)/]]) {
    const env = lab();
    const out = run(env, line);
    ok(kind.test(out), line + ' is refused for its class');
    ok(/unicast host address/.test(out), 'and the refusal says what a router address is');
  }
}

console.log('\nA speed equal to the port\'s own is not configuration:');
{
  const env = lab();
  const port = env.r.interfaces.get('Gi0/0');
  const native = port.speed;
  const out = run(env, 'speed 1000');
  ok(/that is the port's own speed, so nothing is configured/.test(out),
    'setting the speed it already runs at says so (it was stored and dumped)');
  ok(!port.speedConfigured, 'and nothing is configured');
  ok(dump(env, /^\s*speed /).length === 0, 'so the dump does not grow (' + native + ' here)');
  const slower = run(env, 'speed 100');
  ok(/Speed on Gi0\/0 set to 100/.test(slower), 'a different speed is still configuration');
  ok(port.speedConfigured === true, 'and is stored');
  ok(dump(env, /^\s*speed /).length === 1, 'and dumped once');
}

console.log('\nA number out of range is refused for the number, not for the missing group:');
{
  const env = lab();
  const p = run(env, 'vrrp 1 priority 256');
  ok(/Invalid priority: 256 \(1-255\)/.test(p), 'priority 256 names the range');
  ok(!/No VRRP group/.test(p), 'and does not blame the missing group');
  const a = run(env, 'vrrp 1 advertise 0.5');
  ok(/Invalid advertisement interval: 0\.5 \(whole seconds, 1-255\)/.test(a), 'a fractional interval is refused');
  const b = run(env, 'vrrp 1 advertise 3600');
  ok(/Invalid advertisement interval: 3600/.test(b), 'and an out-of-range one too');
}

console.log('\nA refusal does not leave a half-configured group behind:');
{
  const env = lab();
  run(env, 'vrrp 1 priority 150');
  ok((env.r.config.vrrp || []).length === 0, 'a refused setting creates no group');
  run(env, 'vrrp 1 ip 10.0.0.254');
  ok((env.r.config.vrrp || []).length === 1, 'the group appears when the address does');
  const out = run(env, 'vrrp 1 priority 150');
  ok(/VRRP group 1 priority 150/.test(out), 'and settings apply to it');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
