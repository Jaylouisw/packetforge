'use strict';
// `ip routing` - the switch the console could describe and could not set (#fidelity: ip routing default).
//
// Two of the console's answers about routing were already written and could not be reached on the hardware that
// needs them. `show ip route` prints two shapes: the codes legend over a routing table for a box that routes, and
// `Default gateway is not set` over the Host/Gateway cache for a box that does not. Which shape a device got was
// decided by a catalogue capability, so a Catalyst that is sold with L3 forwarding printed a routing table from
// the moment it was placed - in the state its own documentation says it does not ship in:
//
//   "By default, the switch is in Layer 2 switching mode and IP routing is disabled. To use the Layer 3
//    capabilities of the switch, you must enable IP routing."
//   - Catalyst 3560 Software Configuration Guide, Configuring IP Unicast Routing
//   - and the Catalyst 9300 defaults table: "IP routing | Disabled."
//
// The load-bearing section is the third: the same box, the same cables, the same addresses, and one command
// between "this packet is forwarded" and "this packet dies on the box". A flag that only changed what `show ip
// route` prints would be a lie told to whoever reads the table instead of pinging.
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
const pick = function (model) { return catalog.filter(function (s) { return s.model === model; })[0]; };
const L3SWITCH = pick('WS-C3560CX-8PC-S');
const L2SWITCH = pick('Catalyst2960');
const ROUTER = pick('ASR 1001-X');

function eth(d) {
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
}

function solo(spec, id) {
  const t = new Topology();
  const d = t.addDevice(spec, id || 'd1');
  const sim = new Simulator(t);
  const cli = new CliSession(d, t, sim);
  return { t: t, sim: sim, d: d, cli: cli };
}

function show(env, dev, cmd) {
  const cli = new CliSession(dev, env.t, env.sim);
  return ((cli.run(cmd).output) || []).map(String);
}

// pc1 -- sw1 -- pc2, one routed port per PC, so the only thing between the two subnets is sw1's own forwarding.
// The switch is configured the way an operator configures one: L3 forwarding is hardware, `ip routing` is a line
// somebody types, and this lab is the "after".
function lab() {
  const t = new Topology();
  const sw = t.addDevice(L3SWITCH, 'sw1');
  const pc1 = t.addDevice(pick('generic-pc'), 'pc1');
  const pc2 = t.addDevice(pick('generic-pc'), 'pc2');
  const ports = eth(sw);
  t.connect('pc1', 'eth0', 'sw1', ports[2].name);
  t.connect('pc2', 'eth0', 'sw1', ports[3].name);
  const sim = new Simulator(t);
  runCommands(sw, t, sim, [
    'configure terminal',
    'ip routing',
    'interface ' + ports[2].name, 'ip address 10.0.10.1 255.255.255.0',
    'interface ' + ports[3].name, 'ip address 10.0.20.1 255.255.255.0'
  ]);
  runCommands(pc1, t, sim, [
    'configure terminal', 'interface eth0', 'ip address 10.0.10.2 255.255.255.0',
    'exit', 'ip default-gateway 10.0.10.1'
  ]);
  runCommands(pc2, t, sim, [
    'configure terminal', 'interface eth0', 'ip address 10.0.20.2 255.255.255.0',
    'exit', 'ip default-gateway 10.0.20.1'
  ]);
  return { t: t, sim: sim, sw: sw, pc1: pc1, pc2: pc2, ports: ports };
}

function cfg(env, lines) {
  const cli = new CliSession(env.sw, env.t, env.sim);
  cli.run('enable');
  cli.run('configure terminal');
  const out = [];
  for (const line of lines) out.push(...((cli.run(line).output) || []).map(String));
  cli.run('end');
  return out;
}

console.log('');
console.log('A Catalyst leaves the factory in Layer 2 mode; a router does not:');
{
  const sw = solo(L3SWITCH, 'sw1');
  ok(sw.d.hasCap('l3-forward') === true, 'the 3560 has the hardware to route', String(sw.d.hasCap('l3-forward')));
  ok(sw.d.ipRoutingEnabled() === false, 'and does not route until told to', String(sw.d.config.ipRouting));
  ok(sw.d.isL3() === false, 'so nothing that asks `isL3()` gets a routing answer', String(sw.d.isL3()));
  const table = show(sw, sw.d, 'show ip route');
  ok(table[0] === 'Default gateway is not set', 'the table is the gateway/Host shape', table.join(' | '));
  ok(!table.some(function (l) { return /^Codes:/.test(l); }), 'with no codes legend, because there is no table', table.join(' | '));
  const text = show(sw, sw.d, 'show running-config');
  ok(!text.some(function (l) { return /^(no )?ip routing$/.test(l); }),
    'and the file prints nothing, because that state is the default', text.filter(function (l) { return /ip routing/.test(l); }).join(' | '));

  const r = solo(ROUTER, 'r1');
  ok(r.d.ipRoutingEnabled() === true, 'a router routes out of the box', String(r.d.config.ipRouting));
  ok(show(r, r.d, 'show ip route').some(function (l) { return /^Codes:/.test(l); }),
    'and its `show ip route` is the routing table', show(r, r.d, 'show ip route').join(' | '));
  const rtext = show(r, r.d, 'show running-config');
  ok(!rtext.some(function (l) { return /^(no )?ip routing$/.test(l); }),
    'which a router does not print either - "you can\'t see it with show running-config because it\'s enabled by default"',
    rtext.filter(function (l) { return /ip routing/.test(l); }).join(' | '));
}

console.log('');
console.log('The command exists where the hardware can route, and only there:');
{
  const env = lab();
  ok(env.sw.ipRoutingEnabled() === true, 'the lab switch was told to route', String(env.sw.config.ipRouting));
  const off = cfg(env, ['no ip routing']);
  ok(/IP routing disabled/.test(off.join(' ')), 'and `no ip routing` is accepted', off.join(' | '));
  const again = cfg(env, ['no ip routing']);
  ok(/IP routing is already disabled/.test(again.join(' ')), 'twice is a receipt, not a second change', again.join(' | '));
  const back = cfg(env, ['ip routing']);
  ok(/IP routing enabled/.test(back.join(' ')), 'and `ip routing` turns it back on', back.join(' | '));

  // An argument is refused rather than ignored: `ip routing fast` must not be read as `ip routing`.
  const junk = cfg(env, ['ip routing fast']);
  ok(/takes no argument/.test(junk.join(' ')), 'a word after the command is refused', junk.join(' | '));
  ok(env.sw.ipRoutingEnabled() === true, 'and the previous state is untouched', String(env.sw.config.ipRouting));

  // A box with no L3 forwarding has no such line in its parser. The refusal names the missing capability rather
  // than pretending to store a setting that nothing consults - and it does so in both directions.
  const sw2 = solo(L2SWITCH, 'sw2');
  sw2.cli.run('enable'); sw2.cli.run('configure terminal');
  const both = ((sw2.cli.run('ip routing').output) || []).concat((sw2.cli.run('no ip routing').output) || []).map(String);
  ok(both.length === 2 && both.every(function (l) {
    return /cannot route between networks: it has no l3-forward capability/.test(l);
  }), 'a 2960 refuses both directions, naming the capability', both.join(' | '));
  ok(sw2.d.config.ipRouting === null, 'and nothing was stored', String(sw2.d.config.ipRouting));
}

console.log('');
console.log('The table and the data path answer the same question:');
{
  const env = lab();
  const before = show(env, env.sw, 'show ip route');
  ok(before.some(function (l) { return /^Codes:/.test(l); }), 'routing on prints the routing table', before.join(' | '));
  const ping = show(env, env.pc1, 'ping 10.0.20.2');
  ok(/Success rate is 100 percent \(5\/5\)/.test(ping.join(' ')), 'and a packet crosses the box', ping.slice(-3).join(' | '));

  cfg(env, ['no ip routing']);
  const after = show(env, env.sw, 'show ip route');
  ok(after[0] === 'Default gateway is not set', 'routing off prints the gateway/Host shape', after.join(' | '));
  ok(!after.some(function (l) { return /^Codes:/.test(l); }),
    'and no codes legend, because there is no table to head', after.join(' | '));
  const dead = show(env, env.pc1, 'ping 10.0.20.2 2');
  ok(/Success rate is 0 percent \(0\/2\)/.test(dead.join(' ')), 'the same ping now fails', dead.slice(-3).join(' | '));
  ok(/packet not for us and not routable \(dropped by sw1\)/.test(dead.join(' ')),
    'and the drop is attributed to sw1, the box that stopped forwarding', dead.join(' | '));

  // Owning an address is a host function, not a routing one - so the box still answers for its own ports.
  const own = show(env, env.pc1, 'ping 10.0.10.1 2');
  ok(/Success rate is 100 percent \(2\/2\)/.test(own.join(' ')),
    'while its own address still answers, because routing off does not make it deaf', own.join(' | '));

  // A static route is configuration: it stays written down and stops being installed, which is what IOS does -
  // "the static routes you enter afterwards will remain in the running config but won't make it to the routing
  // table as it is no longer a router now" (https://learningnetwork.cisco.com/s/question/0D53i00000KsrT5CAJ).
  cfg(env, ['ip route 10.9.0.0 255.255.0.0 10.0.20.2']);
  const hidden = show(env, env.sw, 'show ip route');
  ok(!hidden.some(function (l) { return /10\.9\.0\.0/.test(l); }),
    'a static route is not installed while routing is off', hidden.join(' | '));
  const written = show(env, env.sw, 'show running-config').filter(function (l) { return /^ip route /.test(l); });
  ok(written.indexOf('ip route 10.9.0.0 255.255.0.0 10.0.20.2') !== -1,
    'but it is still in the running-config', written.join(' | '));

  cfg(env, ['ip routing']);
  const pingBack = show(env, env.pc1, 'ping 10.0.20.2');
  ok(/Success rate is 100 percent \(5\/5\)/.test(pingBack.join(' ')),
    'and `ip routing` puts the packet back on the wire', pingBack.slice(-3).join(' | '));
  ok(show(env, env.sw, 'show ip route').some(function (l) { return /^S\s+10\.9\.0\.0/.test(l); }),
    'with the static route installed again', show(env, env.sw, 'show ip route').join(' | '));
}

console.log('');
console.log('The printed line is the one that differs from the default:');
{
  const env = lab();
  const on = show(env, env.sw, 'show running-config');
  ok(on.some(function (l) { return l === 'ip routing'; }),
    'a Catalyst that was told to route says so, because that is not its default', on.slice(-3).join(' | '));
  ok(on[on.length - 1] === 'end', 'and the file still ends with `end`', on.slice(-2).join(' | '));

  cfg(env, ['no ip routing']);
  const off = show(env, env.sw, 'show running-config');
  ok(!off.some(function (l) { return /^(no )?ip routing$/.test(l); }),
    'put back in its default state, it prints neither line', off.filter(function (l) { return /ip routing/.test(l); }).join(' | '));

  cfg(env, ['ip routing']);
  const back = show(env, env.sw, 'show running-config');
  ok(back.join('\n') === on.join('\n'), 'and typing it again returns the file to exactly what it was');
}

console.log('');
console.log('A saved lab remembers the switch, and only when there was something to remember:');
{
  const env = lab();
  const withRouting = Topology.fromJSON(JSON.parse(JSON.stringify(env.t.serialize())));
  const sw = [...withRouting.devices.values()].filter(function (d) { return d.id === 'sw1'; })[0];
  ok(sw && sw.ipRoutingEnabled() === true, 'a lab saved routing reloads routing', sw ? String(sw.config.ipRouting) : 'no device');

  cfg(env, ['no ip routing']);
  const reloaded = Topology.fromJSON(JSON.parse(JSON.stringify(env.t.serialize())));
  const sw2 = [...reloaded.devices.values()].filter(function (d) { return d.id === 'sw1'; })[0];
  ok(sw2 && sw2.ipRoutingEnabled() === false, 'and one saved in the default state reloads in the default state',
    sw2 ? String(sw2.config.ipRouting) : 'no device');
  // A document that says nothing must not grow the field: the default is the platform's, and writing it into
  // every board would freeze today's answer into every file a user saves.
  const fresh = solo(L3SWITCH, 'sw9');
  ok(fresh.d.serialize().config.ipRouting === undefined, 'a box that was never told anything writes no field',
    JSON.stringify(fresh.d.serialize().config.ipRouting));

  // The other direction, on the platform whose default is "on": the box that was turned off must come back off.
  const r = solo(ROUTER, 'r1');
  r.cli.run('enable'); r.cli.run('configure terminal'); r.cli.run('no ip routing'); r.cli.run('end');
  const doc = JSON.parse(JSON.stringify(r.t.serialize()));
  const back = Topology.fromJSON(doc);
  const r2 = [...back.devices.values()].filter(function (d) { return d.id === 'r1'; })[0];
  ok(r2 && r2.ipRoutingEnabled() === false, 'a router saved with routing off comes back off',
    r2 ? String(r2.config.ipRouting) : 'no device');
  ok(back.serialize().devices[0].config.ipRouting === false, 'and the document carries the `no` line it prints',
    JSON.stringify(back.serialize().devices[0].config.ipRouting));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
