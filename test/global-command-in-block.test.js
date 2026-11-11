'use strict';
// global-command-in-block.test.js - a global command typed in a block does not evict the operator.
//
//   PC1(config-if)#ip default-gateway 10.9.0.1
//   Default gateway: 10.9.0.1
//     note: ... is a global command - applied at global scope and the interface block was left
//   PC1(config)#ipv6 address 2001:db8:9::50/64
//   % Unrecognized config command: ipv6 address 2001:db8:9::50/64
//
// Applying a global command at global scope is right: a pasted running-config prints no `exit` between
// its last interface stanza and the globals, and it has to run start to finish. Leaving the block is
// what was wrong. The person who typed three lines for one port had the third read against the wrong
// mode, and a dual-stack port came out with no IPv6 address at all - while the prompt had already told
// them they were somewhere else, one line too late to matter.
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

function host() {
  const t = new Topology();
  const pc = t.addDevice(find('generic-pc')); pc.name = 'PC1';
  const s = new CliSession(pc, t, new Simulator(t));
  s.run('enable');
  return { t: t, pc: pc, s: s };
}

console.log('A global command typed in a block applies globally and keeps the block:');
{
  const env = host();
  env.s.run('configure terminal', 'interface eth0', 'ip address 10.9.0.50 255.255.255.0');
  const out = text(env.s.run('ip default-gateway 10.9.0.1'));
  ok(/Default gateway: 10\.9\.0\.1/.test(out), 'the gateway is set');
  ok(/global command/.test(out), 'the note says it is a global command');
  ok(/still in this interface block/.test(out), 'and that the block is still entered');
  ok(!/block was left/.test(out), 'nothing claims the block was left');
  ok(/\(config-if\)#/.test(env.s.prompt()), 'the prompt is still the interface block');
}

console.log('\nThe next line is read as the port it was meant for:');
{
  const env = host();
  env.s.run('configure terminal', 'interface eth0', 'ip address 10.9.0.50 255.255.255.0');
  env.s.run('ip default-gateway 10.9.0.1');
  const body = text(env.s.run('ipv6 address 2001:db8:9::50/64'));
  ok(/IPv6 address 2001:db8:9::50\/64 on eth0/.test(body), 'the IPv6 address lands on the port');
  ok(!/Unrecognized/.test(body), 'and is not refused as a global command');
  ok(env.pc.config.ip6 && env.pc.config.ip6.eth0 && env.pc.config.ip6.eth0.addr === '2001:db8:9::50',
    'the port holds a dual stack: one IPv4 address and one IPv6 address');
  const gw = text(env.s.run('ipv6 gateway 2001:db8:9::1'));
  ok(/global command/.test(gw) && /still in this interface block/.test(gw),
    'the IPv6 default gateway is global too, and keeps the block');
  ok(/\(config-if\)#/.test(env.s.prompt()), 'the prompt has not moved after either one');
}

console.log('\nA pasted dump with no exits still applies end to end:');
{
  const t = new Topology();
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  const env = { s: new CliSession(r, t, new Simulator(t)) };
  env.s.run('enable');
  const dump = ['! a dump, globals after the stanza and no exit between them',
    'interface Gi0/0', ' ip address 10.9.0.1 255.255.255.0', ' no shutdown',
    'ip default-gateway 10.9.0.1', 'ip domain-name lab.test',
    'interface Gi0/1', ' ip address 10.10.0.1 255.255.255.0'];
  env.s.run('configure terminal');
  for (const line of dump) env.s.run(line);
  env.s.run('end');
  const run = text(env.s.run('show running-config'));
  ok(/^ip default-gateway 10\.9\.0\.1$/m.test(run), 'the global line reached the running-config');
  ok(/^ip domain-name lab\.test$/m.test(run), 'and so did the second one');
  ok(/^interface Gi0\/0$/m.test(run) && /^interface Gi0\/1$/m.test(run), 'both stanzas are there');
  ok(/10\.9\.0\.1/.test(run) && /10\.10\.0\.1/.test(run), 'each port kept its own address');
}

console.log('\nA dual-stack path answers in both families:');
{
  const t = new Topology();
  const r1 = t.addDevice(find('generic-router')); r1.name = 'R1';
  const r2 = t.addDevice(find('generic-router')); r2.name = 'R2';
  const pc = t.addDevice(find('generic-pc')); pc.name = 'PC1';
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  t.connect(r2.id, 'Gi0/1', pc.id, Array.from(pc.interfaces.values())[0].name);
  const sim = new Simulator(t);
  const s1 = new CliSession(r1, t, sim);
  s1.run('enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown',
    'ipv6 address 2001:db8::1/64', 'exit',
    'ip route 10.9.0.0 255.255.255.0 10.0.0.2', 'ipv6 route 2001:db8:9::/64 2001:db8::2', 'end');
  const s2 = new CliSession(r2, t, sim);
  s2.run('enable', 'configure terminal',
    'interface Gi0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown',
    'ipv6 address 2001:db8::2/64', 'exit',
    'interface Gi0/1', 'ip address 10.9.0.1 255.255.255.0', 'no shutdown',
    'ipv6 address 2001:db8:9::1/64', 'exit', 'ipv6 unicast-routing', 'end');
  const sp = new CliSession(pc, t, sim);
  // The three lines that used to lose the third one, in the order a person types them.
  sp.run('enable', 'configure terminal', 'interface eth0',
    'ip address 10.9.0.50 255.255.255.0', 'ip default-gateway 10.9.0.1',
    'ipv6 address 2001:db8:9::50/64', 'ipv6 gateway 2001:db8:9::1', 'end');
  ok(/Success rate is 100 percent/.test(text(s1.run('ping 10.9.0.50'))), 'IPv4 reaches the host');
  ok(/Success rate is 100 percent/.test(text(s1.run('ping 2001:db8:9::50'))),
    'and IPv6 reaches the same host, on the same port');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
