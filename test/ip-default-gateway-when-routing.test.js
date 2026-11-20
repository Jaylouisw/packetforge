'use strict';
// `ip default-gateway` is a host default, and a routing box is not a host (#fidelity).
//
// The command is scoped by the vendor to the case where IP routing is off: "You can use the ip default-gateway
// global configuration command to define a default gateway when IP routing is disabled on a device" (Cisco IOS
// IP Routing: Protocol-Independent Configuration Guide, 16.11, "Default Routes"). The Catalyst 3750 configuration
// guide's feature table lists "IP default gateway - Disabled" and its procedure says "define a default gateway
// (router) when IP routing is disabled". Operators meet the consequence as the classic "ip routing broke my
// default gateway": the line stays in `show running-config`, and nothing leaves by it
// (https://community.cisco.com/t5/routing/ip-routing-command-on-a-layer-2-switch/td-p/582837 - "While the ip
// default-gateway will be retained in the configuration the only time that it will be used is when ip routing is
// disabled").
//
// This console did the opposite on a device that routes: `show ip route` printed
// `S*  0.0.0.0/0  [254/0] via 10.9.9.1` - a row no box installs, above the line "Gateway of last resort is not
// set" that contradicted it - and `routeTo()` handed every uncovered destination to that gateway, so a lab with
// `ip routing` and only a `ip default-gateway` forwarded traffic the real device drops. research/
// ip-default-gateway-when-routing.md holds the sources and what is still open.
const path = require('path');
const { Device, Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const L3SWITCH = catalog.filter(function (s) { return /WS-C3560G-24TS-S/.test(s.model); })[0];
const L2SWITCH = catalog.filter(function (s) { return /C2960X-24TS-L/.test(s.model); })[0];

// One routed port, so the gateway has a subnet it can sit on and a destination it cannot reach directly.
function lab(spec) {
  const dev = new Device('d1', spec);
  const ports = [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  ports[0].ip = '10.9.9.2'; ports[0].mask = '255.255.255.0';
  dev.name = 'd1';
  const cli = new CliSession(dev, null, null);
  function run(cmd) { return ((cli.run(cmd) || {}).output || []).map(String); }
  run('enable'); run('configure terminal');
  return { dev: dev, cli: cli, run: run };
}

function routeLines(env) {
  return env.run('show ip route');
}
function defaultRows(lines) {
  return lines.filter(function (l) { return /^\S+\s+0\.0\.0\.0\/0\s/.test(l); });
}
function gatewayLine(lines) {
  return lines.filter(function (l) { return /^Gateway of last resort is/.test(l); })[0] || '';
}
// The configuration file is a privileged-EXEC view, so read it and step back into config mode - the caller is
// usually mid-configuration and the next command it types is a config one.
function configText(env) {
  env.run('end');
  const text = env.run('show running-config').join('\n');
  env.run('configure terminal');
  return text;
}

console.log('');
console.log('A router runs IP routing from the factory, so the command configures nothing it uses:');
{
  const env = lab(ROUTER);
  ok(env.dev.isL3() === true, 'the router is a routing box before anything is typed', String(env.dev.isL3()));
  const said = env.run('ip default-gateway 10.9.9.1');
  ok(said.join(' ').indexOf('%') === -1, 'the command is accepted, not refused', said.join(' | '));
  ok(env.dev.config.defaultGateway === '10.9.9.1', 'and the value is stored', String(env.dev.config.defaultGateway));

  const lines = routeLines(env);
  ok(defaultRows(lines).length === 0, 'no 0.0.0.0/0 row is printed for it', defaultRows(lines).join(' | '));
  ok(gatewayLine(lines) === 'Gateway of last resort is not set', 'the gateway of last resort is not set',
    gatewayLine(lines));
  const look = env.dev.routeTo('198.51.100.7');
  ok(look === null, 'and an uncovered destination has no route, rather than leaving by the gateway',
    JSON.stringify(look));

  const cfg = configText(env);
  ok(/^ip default-gateway 10\.9\.9\.1$/m.test(cfg), 'the line stays in the running-config, as on the box', cfg);
  ok(/^ip routing$/m.test(cfg) === false, 'and `ip routing` is still the platform default, so it is not printed', cfg);
}

console.log('');
console.log('The same box with routing turned off behaves like the host the command is for:');
{
  const env = lab(ROUTER);
  env.run('ip default-gateway 10.9.9.1');
  const said = env.run('no ip routing');
  ok(said.join(' ').indexOf('%') === -1, '`no ip routing` is accepted', said.join(' | '));
  const lines = routeLines(env);
  ok(lines[0] === 'Default gateway is 10.9.9.1', 'the table is the host shape, naming the gateway', lines[0]);
  ok(defaultRows(lines).length === 0, 'with no route rows at all', defaultRows(lines).join(' | '));
  const look = env.dev.routeTo('198.51.100.7');
  ok(!!look && look.via === '10.9.9.1', 'and the gateway now forwards for it', JSON.stringify(look));
}

console.log('');
console.log('Turning routing on removes the default it was providing, and turning it off brings it back:');
{
  const env = lab(ROUTER);
  env.run('no ip routing');
  env.run('ip default-gateway 10.9.9.1');
  ok(!!env.dev.routeTo('198.51.100.7'), 'while routing is off, traffic leaves by the gateway');
  env.run('ip routing');
  ok(env.dev.routeTo('198.51.100.7') === null,
    'after `ip routing` it does not, which is the loss operators report',
    JSON.stringify(env.dev.routeTo('198.51.100.7')));
  ok(/^ip default-gateway 10\.9\.9\.1$/m.test(configText(env)), 'and the configured line is still there');
  env.run('no ip routing');
  ok(!!env.dev.routeTo('198.51.100.7'), 'turning routing off again makes the gateway useful again');
}

console.log('');
console.log('A routing box with a static default has one default, the one it was given:');
{
  const env = lab(ROUTER);
  env.run('ip default-gateway 10.9.9.254');
  env.run('ip route 0.0.0.0 0.0.0.0 10.9.9.1');
  const lines = routeLines(env);
  const rows = defaultRows(lines);
  ok(rows.length === 1, 'only the static default is printed', rows.join(' | '));
  ok(/\[1\/0\]/.test(rows[0] || ''), 'at the distance it was configured with', rows[0]);
  ok(gatewayLine(lines).indexOf('10.9.9.1') !== -1, 'and it is the gateway of last resort', gatewayLine(lines));
  const look = env.dev.routeTo('198.51.100.7');
  ok(!!look && look.via === '10.9.9.1', 'which is where packets go', JSON.stringify(look));
}

console.log('');
console.log('A Catalyst that does not route keeps the behaviour it always had:');
{
  const env = lab(L3SWITCH);
  ok(env.dev.ipRoutingEnabled() === false, 'the 3560 does not route until told to', String(env.dev.config.ipRouting));
  env.run('ip default-gateway 10.9.9.1');
  const lines = routeLines(env);
  ok(lines[0] === 'Default gateway is 10.9.9.1', 'it prints the host shape', lines[0]);
  ok(!!env.dev.routeTo('198.51.100.7'), 'and forwards by the gateway it was given');

  const env2 = lab(L2SWITCH);
  env2.run('ip default-gateway 10.9.9.1');
  ok(env2.dev.isL3() === false, 'a 2960 has no routing to enable at all', String(env2.dev.isL3()));
  ok(!!env2.dev.routeTo('198.51.100.7'), 'so the gateway is the only way off its subnet, as it always was');
  const said = env2.run('ip routing');
  ok(said.join(' ').indexOf('%') !== -1, 'and `ip routing` is refused for want of the hardware', said.join(' | '));
}

console.log('');
console.log('A lease is not a typed gateway: a routing box installs the lease\'s router as a default route:');
{
  // Two routers cabled together; the left one is the DHCP server. The right one routes (it is a router), so the
  // router address it is handed becomes `S* 0.0.0.0/0 [254/0]` in its table, not `ip default-gateway` in its
  // configuration - a line nobody typed does not appear in the file.
  const t = new Topology('dhcp');
  const r1 = t.addDevice(catalog.filter(function (x) { return x.model === 'generic-router'; })[0], 'r1');
  const r2 = t.addDevice(catalog.filter(function (x) { return x.model === 'generic-router'; })[0], 'r2');
  t.connect('r1', 'Gi0/0', 'r2', 'Gi0/0');
  const sim = new Simulator(t);
  function cfg(dev, cmds) { return runCommands(dev, t, sim, ['enable', 'configure terminal'].concat(cmds)).lines || []; }
  cfg(r1, ['interface Gi0/0', 'ip address 10.5.5.1 255.255.255.0', 'exit',
    'ip dhcp pool P', 'network 10.5.5.0 255.255.255.0', 'default-router 10.5.5.1',
    'range 10.5.5.100 10.5.5.110', 'exit', 'end']);
  cfg(r2, ['interface Gi0/0', 'ip address dhcp', 'end']);
  sim.setRunTime(5000);
  sim.computeDhcp();

  const iface = r2.interfaces.get('Gi0/0');
  ok(!!iface.ip, 'the client got a lease', String(iface.ip));
  ok(r2.dhcpGateway === '10.5.5.1', 'and remembers the router it was handed', String(r2.dhcpGateway));
  const lines = runCommands(r2, t, sim, ['end', 'show ip route']).lines || [];
  const rows = defaultRows(lines);
  ok(rows.length === 1 && /\[254\/0\] via 10\.5\.5\.1/.test(rows[0]),
    'the lease is a default route at distance 254', rows.join(' | '));
  ok(gatewayLine(lines).indexOf('10.5.5.1') !== -1, 'and it is the gateway of last resort', gatewayLine(lines));
  ok(r2.config.defaultGateway === null, 'the lease did not become `ip default-gateway`', String(r2.config.defaultGateway));
  const cfgLines = runCommands(r2, t, sim, ['show running-config']).lines || [];
  ok(!cfgLines.some(function (l) { return /^ip default-gateway/.test(l); }),
    'so no `ip default-gateway` line appears in the file', cfgLines.filter(function (l) { return /default-gateway/.test(l); }).join(' | '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
