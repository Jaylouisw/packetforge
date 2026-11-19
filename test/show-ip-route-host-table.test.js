'use strict';
// A box that does not route has no routing table, and IOS does not print one for it (#1627).
//
// `show ip route` on a Catalyst with `ip routing` off answers with the default gateway over the host/redirect
// cache - three lines, no codes legend:
//
//   Default gateway is not set
//   Host               Gateway           Last Use    Total Uses  Interface
//   ICMP redirect cache is empty
//
// Two Cisco configuration guides print the positive form, in the "Configuring a Default Gateway" task where
// `ip default-gateway` is verified with `show ip route`:
//   https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/18ew/configuration/guide/config/supcfg.html
//   https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/15-1-2/XE_340/configuration/guide/config/supcfg.html
// Field captures of the negative form on a 2960 and a 3560:
//   https://community.cisco.com/t5/switching/ip-route-0-0-versus-ip-default-gateway/td-p/812905
//   https://community.cisco.com/t5/switching/not-sure-what-i-m-missing-switch-reaching-outside-network/td-p/3702977
// The header's spacing is the one in the `show ip redirects` command reference, which prints the same table:
//   https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp/command/iap-cr-book/iap-s1.html
//
// This console answered every device with the router's shape: the codes legend, then the `S*` row standing for
// the configured gateway. Neither line is something a non-routing box prints.
const path = require('path');
const { Topology, Device, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return /Catalyst2960$/.test(s.model); })[0];
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];

// The vendor's header, spelled out rather than copied from the engine: 15 spaces after Host, 11 after Gateway,
// 4 after Last Use, 2 after Total Uses.
const HEADER = 'Host' + ' '.repeat(15) + 'Gateway' + ' '.repeat(11) + 'Last Use' + ' '.repeat(4) +
  'Total Uses' + ' '.repeat(2) + 'Interface';

function lines(dev, cmds) {
  const cli = new CliSession(dev, null, null);
  for (const c of cmds || []) cli.run(c);
  return cli.run('show ip route').output.map(String);
}

console.log('');
console.log('A switch that does not route answers with its gateway, not a routing table:');
{
  const dev = new Device('sw1', SWITCH);
  ok(dev.isL3() === false, 'a Catalyst 2960 does not route');
  const out = lines(dev);
  ok(out.length === 3, 'three lines, no more', JSON.stringify(out));
  ok(out[0] === 'Default gateway is not set', 'the first line says the gateway is not set', out[0]);
  ok(out[1] === HEADER, 'the second is the vendor\'s Host/Gateway header, spacing included', out[1]);
  ok(out[2] === 'ICMP redirect cache is empty', 'the third is the empty redirect cache', out[2]);
  ok(!out.some(function (l) { return /^Codes:/.test(l); }), 'and there is no codes legend',
    JSON.stringify(out));
}

console.log('');
console.log('A configured gateway is printed in the same line, verbatim:');
{
  const dev = new Device('sw1', SWITCH);
  const out = lines(dev, ['configure terminal', 'ip default-gateway 10.0.0.1', 'end']);
  ok(out[0] === 'Default gateway is 10.0.0.1', 'the line names the gateway that was configured', out[0]);
  ok(out.length === 3, 'and the answer is still three lines', JSON.stringify(out));
  const cfg = new CliSession(dev, null, null).run('show running-config').output.join('\n');
  ok(/ip default-gateway 10\.0\.0\.1/.test(cfg), 'the configuration still carries the gateway', cfg);

  const cleared = lines(dev, ['configure terminal', 'no ip default-gateway', 'end']);
  ok(cleared[0] === 'Default gateway is not set', 'removing it returns the negative line', cleared[0]);
}

console.log('');
console.log('The gateway row is not smuggled back in under another code:');
{
  const dev = new Device('sw1', SWITCH);
  const out = lines(dev, ['configure terminal', 'ip default-gateway 10.0.0.1', 'end']);
  ok(!out.some(function (l) { return /0\.0\.0\.0\/0|\bS\*/.test(l); }),
    'no default-route row and no S* code', JSON.stringify(out));
  ok(!out.some(function (l) { return /via /.test(l); }), 'no next hop is printed anywhere', JSON.stringify(out));
}

console.log('');
console.log('Asking for one prefix on a box with no table is still refused, not answered by the gateway:');
{
  const dev = new Device('sw1', SWITCH);
  const out = new CliSession(dev, null, null).run('show ip route 10.0.0.0').output.map(String);
  ok(!out.some(function (l) { return /^Default gateway is/.test(l); }),
    'the gateway answer is not used as a stand-in for the table', JSON.stringify(out));
}

console.log('');
console.log('A box that routes is untouched:');
{
  const t = new Topology();
  const dev = t.addDevice(ROUTER);
  const ports = [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  ports[0].ip = '10.1.2.3'; ports[0].mask = '255.255.255.0';
  const cli = new CliSession(dev, t, null);
  const out = cli.run('show ip route').output.map(String);
  // `L - local` leads because the table now carries the host route for the interface address, and because the
  // box's own legend leads with it (research/local-route-in-show-ip-route.md).
  ok(/^Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP$/.test(out[0]),
    'the codes legend still leads, with the asterisk it uses defined', out.join(' | '));
  ok(out[5].indexOf('* - candidate default') !== -1,
    'and the asterisk the table prints is defined inside the block', out[5]);
  ok(out[9] === 'Gateway of last resort is not set', 'and the router sentence is under the block', out[9]);
  ok(!out.some(function (l) { return /ICMP redirect cache/.test(l); }),
    'no host/redirect cache is printed by a router', JSON.stringify(out));
}

console.log('');
console.log('The rule follows the routing capability, not the vendor name:');
{
  const dev = new Device('sw1', SWITCH);
  var claimed = 0;
  // Force the opposite capability on the same hardware and the router shape comes back: the shape is a
  // consequence of isL3(), which is what decides whether the box builds a table at all.
  dev.hasCap = function () { return true; };
  const out = new CliSession(dev, null, null).run('show ip route').output.map(String);
  if (/^Codes:/.test(out[0])) claimed++;
  ok(claimed === 1, 'a box that can forward gets the table back', out[0]);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
