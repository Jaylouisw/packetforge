'use strict';
// A DHCP pool that names no mask: which subnet does the box serve?
//
// The vendor's answer is the address's own class, not a fixed /24: the `network (DHCP)` entry carries
// "Command Default: The natural mask is used." and, in the same entry, "If the mask or prefix length is not
// specified, the class A, B, or C natural mask is used." (Cisco IOS IP Addressing Services Command Reference,
// IOS XE 3SE, `network` (DHCP)). PacketForge answered every bare `network` with /24, so `network 10.20.30.0`
// served 254 addresses where a box serves 16,777,214, and `network 172.16.4.9` was a /24 where a box serves
// the whole /16 - the pool an operator wrote, silently a different pool from the one the box would build.
//
// The rule is one function (dhcp.naturalMaskFor) read by one normaliser, and this file pins the three classes
// at the console - the view an operator reads - plus the spellings that must keep overriding it.
const path = require('path');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const dhcp = require('../engine/dhcp');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;
const { loadCatalog } = require('../devices/registry');
const NL = String.fromCharCode(10);
const TICK = String.fromCharCode(0x2713);
const CROSS = String.fromCharCode(0x2717);

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ' + TICK + ' ' + msg); }
  else { failed++; console.error('  ' + CROSS + ' ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /^ISR 4331$/.test(s.model); }) ||
  specs.find(function (s) { return /ISR 4331/.test(s.model); });

// One router, its console, and whatever pool lines are handed to it.
function box(lines) {
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  const cli = new CliSession(t.getDevice('r1'), t, new Simulator(t));
  cli.run('enable');
  cli.run('configure terminal');
  (lines || []).forEach(function (l) { cli.run(l); });
  return { t: t, cli: cli };
}
function say(ctx, cmd) { return (ctx.cli.run(cmd).output || []).join(NL); }
function has(text, needle) { return text.indexOf(needle) !== -1; }

console.log('');
console.log('The natural mask follows the class of the address:');
{
  const a = box(['ip dhcp pool A', 'network 10.20.30.0', 'exit']);
  const textA = say(a, 'show ip dhcp pool');
  ok(has(textA, '10.0.0.1 - 10.255.255.254'), 'class A: 10.20.30.0 serves the whole /8', textA);
  ok(has(textA, 'Total addresses                : 16777214'), 'and the total is the /8 one, not 254', textA);

  const b = box(['ip dhcp pool B', 'network 172.16.4.9', 'exit']);
  const textB = say(b, 'show ip dhcp pool');
  ok(has(textB, '172.16.0.1 - 172.16.255.254'), 'class B: 172.16.4.9 serves the whole /16', textB);
  ok(has(textB, 'Total addresses                : 65534'), 'and the total is the /16 one', textB);

  const c = box(['ip dhcp pool C', 'network 192.168.10.7', 'exit']);
  const textC = say(c, 'show ip dhcp pool');
  ok(has(textC, '192.168.10.1 - 192.168.10.254'), 'class C: 192.168.10.7 serves that /24', textC);
  ok(has(textC, 'Total addresses                : 254'), 'and the total is unchanged at 254', textC);
}

console.log('');
console.log('An explicit mask still wins, and a bare line replaces the old one:');
{
  const d = box(['ip dhcp pool D', 'network 10.20.30.0 255.255.255.0', 'exit']);
  const textD = say(d, 'show ip dhcp pool');
  ok(has(textD, '10.20.30.1 - 10.20.30.254'), 'a stated /24 on a class A address is the /24', textD);
  ok(has(textD, 'Total addresses                : 254'), 'and the total is 254', textD);

  // `network` replaces the pool subnet; it does not merge into the previous line mask. Re-entering the same
  // address without the mask is therefore a move back to /8, not a no-op.
  const e = box(['ip dhcp pool E', 'network 10.20.30.0 255.255.255.0', 'network 10.20.30.0', 'exit']);
  const textE = say(e, 'show ip dhcp pool');
  ok(has(textE, '10.0.0.1 - 10.255.255.254'), 'a second bare `network` drops the earlier mask', textE);

  // The /prefix spelling is the documented alternative to a mask and still names the subnet exactly.
  const f = box(['ip dhcp pool F', 'network 10.20.30.0/24', 'exit']);
  const textF = say(f, 'show ip dhcp pool');
  ok(has(textF, '10.20.30.1 - 10.20.30.254'), '`network 10.20.30.0/24` keeps its /24', textF);
}

console.log('');
console.log('Allocation reads the same subnet the view prints:');
{
  const pool = dhcp.normalizePool({ name: 'B', network: '172.16.4.9' });
  ok(pool.mask === '255.255.0.0' && pool.network === '172.16.0.0',
    'normalisation keeps one mask for every reader', pool.mask + ' ' + pool.network);
  ok(dhcp.poolCapacity(pool) === 65534, 'capacity is the /16 one', String(dhcp.poolCapacity(pool)));
  const first = dhcp.nextFreeIp(pool, dhcp.createLeaseState());
  ok(first === '172.16.0.1', 'the first address offered is the subnet first usable one', first);
  ok(dhcp.ipInPool(pool, '172.16.255.1') === true, 'an address in the far end of the /16 is in the pool');
  ok(dhcp.ipInPool(pool, '172.17.0.1') === false, 'an address in the next /16 is not');
  ok(dhcp.validatePool(pool).ok, 'and the pool validates as written',
    JSON.stringify(dhcp.validatePool(pool).errors));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
