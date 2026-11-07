'use strict';
// ipv6-slaac.test.js -- proves IPv6 hosts can configure themselves from the wire.
//
// Router advertisement is how IPv6 actually hands out addresses: nothing is typed
// into the host, the router says which prefix the link uses, and the host splices
// its own EUI-64 identifier onto it. This test covers the message format, the CLI
// that configures a router, and the whole solicitation/advertisement exchange in
// the forwarding path - including the cases that must NOT autoconfigure.
const path = require('path');
const { Topology, Simulator, runCommands, ipv6, ra } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')');
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(vendor, model) {
  const s = catalog.find(function (x) { return x.vendor === vendor && x.model === model; });
  if (!s) throw new Error('missing spec ' + vendor + '/' + model);
  return s;
}

// Independent construction of the address a host should form: prefix bits from
// the advertisement, identifier bits from its own MAC. Deliberately not calling
// ra.deriveAddress() - the assertion has to be able to disagree with it.
function expectedSlaac(prefix, mac) {
  const groups = ipv6.parseIpv6(prefix).groups.slice(0, 4);
  const eui = ipv6.eui64FromMac(mac).split(':');
  for (const hex of eui) groups.push(parseInt(hex, 16));
  return ipv6.formatIpv6(groups);
}

function cli(t, dev, cmds, exec) {
  const pre = exec ? ['enable'] : ['enable', 'configure terminal'];
  return runCommands(dev, t, null, pre.concat(cmds)).lines;
}

// ---------------------------------------------------------------------------
// 1. The message on the wire (ICMPv6 133/134, RFC 4861 §4)
// ---------------------------------------------------------------------------

console.log('A router advertisement is really encoded as ICMPv6 type 134:');
const msg = ra.buildRa({
  m: true, o: true,
  routerLifetime: 900, reachableTime: 30000, retransTimer: 1000,
  prefixes: [{ prefix: '2001:db8:1::1234', prefixLen: 64, validLifetime: 7200, preferredLifetime: 3600 }],
  srcMac: '02:00:00:00:00:01'
});
const wire = ra.encodeRa(msg);

ok(Buffer.isBuffer(wire), 'encodeRa returns octets, not an object');
eq(wire[0], ra.RA_TYPE, 'the first octet is the ICMPv6 type');
eq(wire[0], 134, 'and that type is 134 (router advertisement)');
eq(wire.length, 16 + 8 + 32, 'header + source link-layer address + one prefix option');
eq((wire[5] & 0x80) !== 0, true, 'M flag lives in the flags octet');
eq((wire[5] & 0x40) !== 0, true, 'O flag sits next to it');
eq(wire.readUInt16BE(6), 900, 'router lifetime is a 16-bit field at offset 6');
eq(wire.readUInt32BE(8), 30000, 'reachable time is a 32-bit field at offset 8');
eq(wire.readUInt32BE(12), 1000, 'retrans timer is a 32-bit field at offset 12');
eq(wire[16], ra.OPT_SOURCE_LLADDR, 'first option is the source link-layer address (type 1)');
eq(wire[17], 1, 'and it is one 8-octet unit long');
eq(wire.subarray(18, 24).toString('hex'), '020000000001', 'the option carries the MAC bytes');
eq(wire[24], ra.OPT_PREFIX_INFO, 'second option is prefix information (type 3)');
eq(wire[25], 4, 'four 8-octet units = 32 octets');
eq(wire[26], 64, 'the prefix length octet holds the /64');
eq((wire[27] & 0x80) !== 0 && (wire[27] & 0x40) !== 0, true, 'L and A are both set');
eq(wire.readUInt32BE(28), 7200, 'valid lifetime is carried');
eq(wire.readUInt32BE(32), 3600, 'preferred lifetime is carried');
eq(ipv6.formatIpv6([0, 0, 0, 0, 0, 0, 0, 0].map(function (_, i) {
  return wire.readUInt16BE(40 + i * 2);
})), '2001:db8:1::', 'the prefix option carries the prefix, not the configured host bits');

const decoded = ra.parseRa(wire);
ok(decoded.valid === true && decoded.error === null, 'the octets parse back');
eq(decoded.ra.type, 134, 'parsed type is 134');
eq(decoded.ra.m, true, 'M survives the round trip');
eq(decoded.ra.o, true, 'O survives the round trip');
eq(decoded.ra.routerLifetime, 900, 'router lifetime survives');
eq(decoded.ra.reachableTime, 30000, 'reachable time survives');
eq(decoded.ra.retransTimer, 1000, 'retrans timer survives');
eq(decoded.ra.srcMac, '02:00:00:00:00:01', 'source link-layer address survives');
eq(decoded.ra.prefixes.length, 1, 'one prefix information option');
eq(decoded.ra.prefixes[0].prefix, '2001:db8:1::', 'prefix address is exact');
eq(decoded.ra.prefixes[0].prefixLen, 64, 'prefix length is exact');
eq(decoded.ra.prefixes[0].onLink, true, 'L flag is read back');
eq(decoded.ra.prefixes[0].autonomous, true, 'A flag is read back');
eq(decoded.ra.prefixes[0].validLifetime, 7200, 'valid lifetime is read back');
eq(decoded.ra.prefixes[0].preferredLifetime, 3600, 'preferred lifetime is read back');
eq(decoded.ra.options.map(function (o) { return o.type; }).join(','), '1,3',
  'options are walked in order (source LLA, then prefix)');

console.log('\nA router solicitation is ICMPv6 type 133:');
const rsWire = ra.encodeRs(ra.buildRs({ srcMac: '02:00:00:00:00:01' }));
eq(rsWire[0], 133, 'the first octet is 133 (router solicitation)');
eq(rsWire.length, 16, 'header plus a source link-layer address option');
const rsBack = ra.parseRs(rsWire);
ok(rsBack.valid === true, 'the solicitation parses back');
eq(rsBack.rs.srcMac, '02:00:00:00:00:01', 'and keeps the sender MAC');

console.log('\nThe two multicast groups every IPv6 host knows:');
eq(ra.ALL_NODES, 'ff02::1', 'all-nodes is ff02::1');
eq(ra.ALL_NODES_MAC, '33:33:00:00:00:01', 'mapped to 33:33:00:00:00:01');
eq(ra.ALL_ROUTERS, 'ff02::2', 'all-routers is ff02::2');
eq(ra.ALL_ROUTERS_MAC, '33:33:00:00:00:02', 'mapped to 33:33:00:00:00:02');

console.log('\nSLAAC address = advertised prefix + the host\'s own EUI-64:');
const MAC = '02:00:00:00:00:11';
eq(ra.deriveAddress('2001:db8:7::', 64, MAC), '2001:db8:7::ff:fe00:11',
  'the identifier is spliced onto the prefix');
eq(ra.deriveAddress('2001:db8:7::/64', 64, MAC), '2001:db8:7::ff:fe00:11',
  'a prefix given with its length works too');
eq(ra.deriveAddress('', 64, MAC), '', 'an empty prefix yields no address');
eq(ra.deriveAddress('2001:db8:7::', 64, 'ff:ff:ff:ff:ff:ff'), '',
  'a group MAC has no EUI-64, so no address');
ok(ipv6.prefixContains6('2001:db8:7::/64', ra.deriveAddress('2001:db8:7::', 64, MAC)),
  'the derived address is inside the advertised prefix');

console.log('\nAutoconfiguration rules (A flag, prefix length, lifetime):');
const pio = { prefix: '2001:db8:1::', prefixLen: 64, autonomous: true, onLink: true, validLifetime: 100 };
eq(ra.canAutoconfigure(pio), true, 'an A=1 /64 with a live lifetime is usable');
eq(ra.canAutoconfigure(Object.assign({}, pio, { autonomous: false })), false,
  'A=0 means on-link only: no address is formed');
eq(ra.canAutoconfigure(Object.assign({}, pio, { prefixLen: 65 })), false,
  'a /65 leaves less than an interface identifier, so it cannot carry one');
eq(ra.canAutoconfigure(Object.assign({}, pio, { validLifetime: 0 })), false,
  'an expired prefix is not used');
eq(ra.canAutoconfigure(null), false, 'junk is not autoconfigurable');

console.log('\nJunk never throws, and a broken message is reported not guessed:');
const short = ra.parseRa(Buffer.alloc(4));
ok(short.valid === false && short.error.code === 'E_SHORT', 'a 4-octet message is E_SHORT');
const wrong = ra.parseRa(Buffer.alloc(16));
ok(wrong.valid === false && wrong.error.code === 'E_ICMP_TYPE', 'a zeroed header is not an RA');
const truncated = ra.parseRa(wire.subarray(0, 40));
ok(truncated.valid === false && truncated.error.code === 'E_OPTION_TRUNCATED',
  'an option that overruns the message is refused');
let threw = 0;
const JUNK = [null, undefined, 0, 42, NaN, true, '', 'nope', {}, [], function () {}, Symbol('x')];
for (const j of JUNK) {
  for (const fn of [ra.buildRa, ra.encodeRa, ra.parseRa, ra.buildRs, ra.encodeRs, ra.parseRs,
    ra.normalizeConfig, ra.normalizePrefixInfo, ra.canAutoconfigure]) {
    try { fn(j); } catch (e) { threw++; }
  }
  try { ra.deriveAddress(j, 64, MAC); } catch (e) { threw++; }
  try { ra.deriveAddress('2001:db8::', 64, j); } catch (e) { threw++; }
}
eq(threw, 0, 'no entry point throws on malformed input');
ok(ra.parseRa('not-octets').valid === false, 'a string is refused, not thrown');
eq(ra.normalizeConfig(null).enabled, false, 'a missing config advertises nothing');
eq(ra.normalizeConfig(null).routerLifetime, ra.DEFAULTS.routerLifetime, 'and still has a sane lifetime');

// ---------------------------------------------------------------------------
// 2. The CLI grammar
// ---------------------------------------------------------------------------

const t = new Topology();
const r1 = t.addDevice(spec('generic', 'generic-router'));
const sw1 = t.addDevice(spec('generic', 'generic-switch'));
const h1 = t.addDevice(spec('generic', 'generic-pc'));
const h2 = t.addDevice(spec('generic', 'generic-pc'));
r1.name = 'R1'; sw1.name = 'SW1'; h1.name = 'H1'; h2.name = 'H2';
t.connect(h1.id, 'eth0', sw1.id, 'Fa0/1');
t.connect(r1.id, 'Gi0/0', sw1.id, 'Fa0/3');
t.connect(r1.id, 'Gi0/1', h2.id, 'eth0');

console.log('\nConfiguring a router through the CLI:');
// Address the interfaces first, the way a real build goes: a router advertises
// the prefix it is attached to, so it needs an address in it before the
// advertisement means anything.
cli(t, r1, ['interface Gi0/0', 'ipv6 address 2001:db8:aa::1/64', 'exit',
  'interface Gi0/1', 'ipv6 address 2001:db8:bb::1/64']);
let out = cli(t, r1, ['ipv6 nd ra enable']);
ok(/router advertisements enabled/.test(out.join(' ')), 'CLI accepts "ipv6 nd ra enable"');
eq(r1.config.ra.enabled, true, 'and stores the intent');

out = cli(t, r1, ['ipv6 nd ra disable']);
ok(/router advertisements disabled/.test(out.join(' ')), 'CLI accepts "ipv6 nd ra disable"');
eq(r1.config.ra.enabled, false, 'and stores that too');
cli(t, r1, ['ipv6 nd ra enable']);

out = cli(t, r1, ['ipv6 nd prefix 2001:db8:aa::/64']);
ok(/2001:db8:aa::\/64 advertised/.test(out.join(' ')), 'CLI accepts "ipv6 nd prefix <prefix>/<len>"');
eq(r1.config.ra.prefixes.length, 1, 'one prefix is advertised');
eq(r1.config.ra.prefixes[0].prefix, '2001:db8:aa::', 'the prefix is stored canonicalised');
eq(r1.config.ra.prefixes[0].prefixLen, 64, 'with its length');
eq(r1.config.ra.prefixes[0].onLink, true, 'L is on by default');
eq(r1.config.ra.prefixes[0].autonomous, true, 'A is on by default (hosts may use it)');
eq(r1.config.ra.prefixes[0].validLifetime, ra.DEFAULTS.validLifetime, 'default valid lifetime');
eq(r1.config.ra.prefixes[0].preferredLifetime, ra.DEFAULTS.preferredLifetime, 'default preferred lifetime');

out = cli(t, r1, ['ipv6 nd prefix 2001:db8:bb::/64 valid 3600 preferred 1800']);
ok(/valid 3600s, preferred 1800s/.test(out.join(' ')), 'CLI accepts explicit lifetimes');
eq(r1.config.ra.prefixes.length, 2, 'the second prefix is added alongside the first');

out = cli(t, r1, ['ipv6 nd prefix 2001:db8:aa::/64 valid 100 preferred 50']);
eq(r1.config.ra.prefixes.length, 2, 're-issuing a prefix replaces it rather than duplicating');
const aa = r1.config.ra.prefixes.filter(function (p) { return p.prefix === '2001:db8:aa::'; })[0];
eq(aa.validLifetime, 100, 'the replacement carries the new valid lifetime');
cli(t, r1, ['ipv6 nd prefix 2001:db8:aa::/64']);

console.log('\nThe parser refuses what would be nonsense on the wire:');
out = cli(t, r1, ['ipv6 nd prefix 2001:db8:zz::/64']);
ok(/% Invalid IPv6 prefix/.test(out.join(' ')), 'a malformed prefix is rejected');
out = cli(t, r1, ['ipv6 nd prefix 2001:db8:aa::/64 valid 100 preferred 200']);
ok(/% Preferred lifetime .* cannot exceed the valid lifetime/.test(out.join(' ')),
  'a preferred lifetime longer than the valid one is rejected');
out = cli(t, r1, ['ipv6 nd prefix 2001:db8:aa::/64 valid soon']);
ok(/% Invalid lifetime/.test(out.join(' ')), 'a non-numeric lifetime is rejected');
out = cli(t, r1, ['ipv6 nd prefix 2001:db8:aa::/64 bogus 5']);
ok(/% Unexpected "bogus"/.test(out.join(' ')), 'an unknown keyword is rejected');
out = cli(t, r1, ['ipv6 nd ra lifetime 0']);
ok(/router lifetime 0s .*not a default router/.test(out.join(' ')), 'a zero router lifetime is allowed');
out = cli(t, r1, ['ipv6 nd ra lifetime 70000']);
ok(/% Router lifetime out of range/.test(out.join(' ')), 'a lifetime past the 16-bit field is rejected');
cli(t, r1, ['ipv6 nd ra lifetime 1800']);

console.log('\nFlags and suppression:');
out = cli(t, r1, ['ipv6 nd ra managed']);
ok(/M \(managed\) flag set/.test(out.join(' ')), 'CLI accepts "ipv6 nd ra managed"');
eq(r1.config.ra.m, true, 'M flag stored');
out = cli(t, r1, ['no ipv6 nd ra managed']);
ok(/M \(managed\) flag cleared/.test(out.join(' ')), 'and "no ipv6 nd ra managed" clears it');
eq(r1.config.ra.m, false, 'M flag cleared');
out = cli(t, r1, ['ipv6 nd suppress-ra']);
ok(/suppressed: solicited advertisements only/.test(out.join(' ')), 'CLI accepts "ipv6 nd suppress-ra"');
eq(r1.config.ra.suppress, true, 'suppression stored');
out = cli(t, r1, ['no ipv6 nd suppress-ra']);
eq(r1.config.ra.suppress, false, '"no ipv6 nd suppress-ra" turns it back on');

console.log('\n"show ipv6 nd" prints what the device would advertise:');
out = cli(t, r1, ['show ipv6 nd'], true).join('\n');
ok(/Advertise\s+: enabled/.test(out), 'shows that advertising is on');
ok(/M=0 O=0/.test(out), 'shows the M and O flags');
ok(/router lifetime 1800s/.test(out), 'shows the router lifetime');
ok(/2001:db8:aa::\/64/.test(out) && /2001:db8:bb::\/64/.test(out), 'lists both prefixes');
ok(/Gi0\/0 \(2001:db8:aa::\/64\)/.test(out) && /Gi0\/1 \(2001:db8:bb::\/64\)/.test(out),
  'and says which prefix would leave which port');

console.log('\nA bridge cannot advertise, and the CLI says why:');
out = cli(t, sw1, ['ipv6 nd ra enable']);
ok(/% SW1 cannot advertise: it has no l3-forward capability/.test(out.join(' ')),
  'the switch is refused with the reason, not a silent no-op');
eq(sw1.config.ra, null, 'and nothing is stored');
out = cli(t, sw1, ['ipv6 nd prefix 2001:db8:dd::/64']);
ok(/% SW1 cannot advertise/.test(out.join(' ')), 'a prefix is refused the same way');
out = cli(t, sw1, ['show ipv6 nd'], true).join('\n');
ok(/Advertise\s+: unavailable/.test(out), 'show ipv6 nd reports it as unavailable');

console.log('\n"ipv6 address autoconfig" is an interface verb:');
out = cli(t, h1, ['interface eth0', 'ipv6 address autoconfig']);
ok(/autoconfig on eth0/.test(out.join(' ')), 'CLI accepts "ipv6 address autoconfig"');
eq(h1.interfaces.get('eth0').autoconfig, true, 'the interface is marked as waiting');
eq(Object.keys(h1.config.ip6).length, 0, 'and it holds no address yet');
out = cli(t, h1, ['show ipv6 nd'], true).join('\n');
ok(/Autoconfig\s+: eth0 \(waiting for a router\)/.test(out), 'show ipv6 nd says it is waiting');

// ---------------------------------------------------------------------------
// 3. The exchange itself: RS out, RA back, address formed
// ---------------------------------------------------------------------------

console.log('\nThe exchange, with no IPv6 address configured on the host:');
cli(t, h1, ['interface eth0', 'ipv6 address autoconfig']);
cli(t, h2, ['interface eth0', 'ipv6 address autoconfig']);

eq(Object.keys(h1.config.ip6).length, 0, 'H1 starts with zero configured IPv6 addresses');
eq(h1.config.gateway6, null, 'and no default gateway');

const sim = new Simulator(t);
sim.announceRa();

const h1Mac = h1.interfaces.get('eth0').mac;
const wantA = expectedSlaac('2001:db8:aa::', h1Mac);
eq(h1.config.ip6.eth0 && h1.config.ip6.eth0.addr, wantA,
  'H1 formed ' + wantA + ' from the advertised prefix and its own MAC');
eq(h1.config.ip6.eth0.autoconfig, true, 'the address is flagged as learned, not configured');
ok(ipv6.prefixContains6('2001:db8:aa::/64', h1.config.ip6.eth0.addr),
  'and it is inside the advertised prefix');
eq(h1.config.ip6.eth0.prefix, 64, 'the adopted prefix length is the advertised one');

const r1Ll = r1.linkLocal6(r1.interfaces.get('Gi0/0'));
eq(h1.config.gateway6, r1Ll, 'the default gateway is the router\'s link-local (' + r1Ll + ')');
const defRoute = h1.route6To('2001:db8:bb::1');
eq(defRoute && defRoute.type, 'default6', 'the default route is used for another prefix');
eq(defRoute && defRoute.via, r1Ll, 'and points at that router link-local');
eq(defRoute && defRoute.iface, 'eth0', 'out of the interface the advertisement arrived on');

console.log('\nWhat crossed the wire:');
const events = sim.events;
const rsEv = events.filter(function (e) { return e.type === 'rs-send' && e.dev === h1.id; })[0];
ok(!!rsEv, 'H1 sent a router solicitation');
eq(rsEv && rsEv.dst, 'ff02::2', 'the solicitation went to all-routers (ff02::2)');
eq(rsEv && rsEv.mac, '33:33:00:00:00:02', 'addressed to the all-routers MAC');
const rsFrame = events.filter(function (e) {
  return e.type === 'frame' && e.frame && e.frame.nd && e.frame.nd.type === 'rs';
})[0];
eq(rsFrame && rsFrame.frame.dstMac, '33:33:00:00:00:02', 'the frame itself carried that MAC');
eq(rsFrame && rsFrame.frame.etherType, 'nd', 'and travelled as a neighbour-discovery frame');

const raEv = events.filter(function (e) { return e.type === 'ra-send' && e.dev === r1.id; })[0];
ok(!!raEv, 'R1 sent a router advertisement');
eq(raEv && raEv.dst, 'ff02::1', 'to all-nodes (ff02::1)');
eq(raEv && raEv.mac, '33:33:00:00:00:01', 'addressed to the all-nodes MAC');
eq(raEv && raEv.routerLifetime, 1800, 'with the configured router lifetime');
const raFrame = events.filter(function (e) {
  return e.type === 'frame' && e.frame && e.frame.nd && e.frame.nd.type === 'ra';
})[0];
eq(raFrame && raFrame.frame.dstMac, '33:33:00:00:00:01', 'the advertisement frame carried the all-nodes MAC');
ok(!!raFrame && !!raFrame.frame.nd.ra, 'and a decoded advertisement inside it');

const recvEv = events.filter(function (e) { return e.type === 'ra-recv' && e.dev === h1.id; })[0];
ok(!!recvEv, 'H1 logged receiving the advertisement');
eq(recvEv && recvEv.from, r1Ll, 'from the router link-local that became its gateway');
eq(recvEv && recvEv.prefixes.join(','), '2001:db8:aa::/64',
  'carrying the aa::/64 and only that prefix');
const slaacEv = events.filter(function (e) { return e.type === 'slaac-address' && e.dev === h1.id; })[0];
ok(!!slaacEv, 'H1 logged the address it autoconfigured');
eq(slaacEv && slaacEv.addr, wantA, 'the event names the address');
eq(slaacEv && slaacEv.prefixSource, '2001:db8:aa::/64', 'and where it came from');

console.log('\nA router advertises a prefix on the link it is attached to, not everywhere:');
const raOn0 = events.filter(function (e) { return e.type === 'ra-send' && e.dev === r1.id && e.iface === 'Gi0/0'; })[0];
const raOn1 = events.filter(function (e) { return e.type === 'ra-send' && e.dev === r1.id && e.iface === 'Gi0/1'; })[0];
eq(raOn0 && raOn0.prefixes.join(','), '2001:db8:aa::/64', 'Gi0/0 advertises only the aa::/64');
eq(raOn1 && raOn1.prefixes.join(','), '2001:db8:bb::/64', 'Gi0/1 advertises only the bb::/64');

// ---------------------------------------------------------------------------
// 4. And the address is reachable from another host
// ---------------------------------------------------------------------------

console.log('\nAnother host can ping the autoconfigured address:');
const h2Addr = h2.config.ip6.eth0 && h2.config.ip6.eth0.addr;
ok(!!h2Addr && ipv6.prefixContains6('2001:db8:bb::/64', h2Addr),
  'H2 autoconfigured ' + h2Addr + ' from the bb::/64');
eq(h2.config.ip6.eth0.validLifetime, 3600, 'it took the advertised valid lifetime');
eq(h2.config.ip6.eth0.preferredLifetime, 1800, 'and the preferred lifetime');

let res = new Simulator(t).ping6(h1.id, h2Addr, { count: 2 });
ok(res.replies.every(function (r) { return r.success; }),
  'ping6 H1 -> H2 succeeds with no address configured by hand anywhere');
const echoEv = res.events.filter(function (e) { return e.type === 'icmp6-echo'; })[0];
eq(echoEv && echoEv.from, wantA, 'the echo was sourced from the SLAAC address, not the link-local');
const route6Ev = res.events.filter(function (e) { return e.type === 'route6'; })[0];
ok(!!route6Ev, 'R1 routed the packet');
eq(route6Ev && route6Ev.dev, r1.id, 'the router is the one that forwarded it');

console.log('\nNothing on the host ended up configured by hand:');
const h1Addrs = h1.ip6Addrs();
eq(h1Addrs.length, 1, 'H1 has exactly one global address');
eq(h1Addrs[0].autoconfig, true, 'and it is marked as learned from a router advertisement');

// ---------------------------------------------------------------------------
// 5. M flag: the host must not autoconfigure, and must say why
// ---------------------------------------------------------------------------

console.log('\nAn M-flag advertisement means DHCPv6, so the host must refuse:');
const t3 = new Topology();
const r2 = t3.addDevice(spec('generic', 'generic-router'));
const h3 = t3.addDevice(spec('generic', 'generic-pc'));
r2.name = 'R2'; h3.name = 'H3';
t3.connect(r2.id, 'Gi0/0', h3.id, 'eth0');
cli(t3, r2, ['interface Gi0/0', 'ipv6 address 2001:db8:cc::1/64', 'exit',
  'ipv6 nd ra enable', 'ipv6 nd ra managed', 'ipv6 nd prefix 2001:db8:cc::/64']);
cli(t3, h3, ['interface eth0', 'ipv6 address autoconfig']);
eq(r2.config.ra.m, true, 'R2 is configured to set the M flag');

const sim3 = new Simulator(t3);
sim3.announceRa();
eq(h3.config.ip6.eth0, undefined, 'H3 did NOT autoconfigure an address');
eq(h3.config.gateway6, null, 'and took no default route from a network it cannot join');
const heard3 = sim3.events.filter(function (e) { return e.type === 'ra-recv' && e.dev === h3.id; });
ok(heard3.length > 0, 'H3 did hear the advertisement (' + heard3.length + ' time(s))');
eq(heard3[0] && heard3[0].m, true, 'and saw the M flag on it');
const refused = sim3.events.filter(function (e) { return e.type === 'slaac-refused' && e.dev === h3.id; })[0];
ok(!!refused, 'the refusal is reported as an event rather than swallowed');
ok(refused && /M \(managed\) flag/.test(refused.reason), 'the event names the M flag');
ok(refused && /DHCPv6/.test(refused.reason), 'and explains that the address comes from DHCPv6');
eq(sim3.events.filter(function (e) { return e.type === 'slaac-address' && e.dev === h3.id; }).length, 0,
  'no slaac-address event was emitted');

res = sim3.ping6(h3.id, '2001:db8:cc::1', { count: 1 });
ok(!res.replies[0].success, 'and H3 cannot ping the router: it has no address at all');
ok(res.events.some(function (e) { return e.type === 'drop' && /no IPv6 route/.test(e.reason || ''); }),
  'the drop says there is no IPv6 route, which is the truth');

// ---------------------------------------------------------------------------
// 6. A device without l3-forward never sends an advertisement
// ---------------------------------------------------------------------------

console.log('\nAn advertisement from a bridge is never sent, even if configured:');
const t4 = new Topology();
const sw2 = t4.addDevice(spec('generic', 'generic-switch'));
const h4 = t4.addDevice(spec('generic', 'generic-pc'));
sw2.name = 'SW2'; h4.name = 'H4';
t4.connect(h4.id, 'eth0', sw2.id, 'Fa0/1');
cli(t4, h4, ['interface eth0', 'ipv6 address autoconfig']);
// Bypass the CLI, the way an imported lab file could: the forwarding path is the
// line that has to hold, not the parser.
sw2.config.ra = { enabled: true, prefixes: [{ prefix: '2001:db8:dd::', prefixLen: 64 }] };

const sim4 = new Simulator(t4);
sim4.announceRa();
eq(sim4.events.filter(function (e) { return e.type === 'ra-send' && e.dev === sw2.id; }).length, 0,
  'SW2 put no router advertisement on the wire');
eq(sim4._sendRa(sw2, sw2.interfaces.get('Fa0/1'), { solicited: true }), 0,
  'and asking it to advertise directly returns 0');
eq(sim4.events.filter(function (e) { return e.type === 'slaac-address' && e.dev === h4.id; }).length, 0,
  'H4 learned no address from it');
eq(h4.config.ip6.eth0, undefined, 'H4 is still unaddressed');
ok(sim4.events.some(function (e) { return e.type === 'rs-send' && e.dev === h4.id; }),
  'H4 did ask, so the silence is the bridge\'s, not the host\'s');

// ---------------------------------------------------------------------------
// 7. suppress-ra: no periodic advertisement, but still answers a host that asks
// ---------------------------------------------------------------------------

console.log('\nsuppress-ra stops the periodic advertisement, not the answer:');
const t5 = new Topology();
const r3 = t5.addDevice(spec('generic', 'generic-router'));
const h5 = t5.addDevice(spec('generic', 'generic-pc'));
r3.name = 'R3'; h5.name = 'H5';
t5.connect(r3.id, 'Gi0/0', h5.id, 'eth0');
cli(t5, r3, ['interface Gi0/0', 'ipv6 address 2001:db8:ee::1/64', 'exit',
  'ipv6 nd ra enable', 'ipv6 nd suppress-ra', 'ipv6 nd prefix 2001:db8:ee::/64']);
cli(t5, h5, ['interface eth0', 'ipv6 address autoconfig']);

const sim5 = new Simulator(t5);
sim5.announceRa();
eq(sim5.events.filter(function (e) {
  return e.type === 'ra-send' && e.dev === r3.id && e.solicited === false;
}).length, 0, 'no unsolicited advertisement was sent');
ok(sim5.events.some(function (e) {
  return e.type === 'ra-send' && e.dev === r3.id && e.solicited === true;
}), 'R3 still answered the solicitation');
ok(!!(h5.config.ip6.eth0 && h5.config.ip6.eth0.addr), 'so H5 is addressed anyway');
ok(ipv6.prefixContains6('2001:db8:ee::/64', h5.config.ip6.eth0.addr),
  'inside the suppressed prefix');

// ---------------------------------------------------------------------------
// 8. Withdrawing autoconfiguration withdraws the address
// ---------------------------------------------------------------------------

console.log('\n"no ipv6 address autoconfig" takes the learned address with it:');
out = cli(t, h1, ['interface eth0', 'no ipv6 address autoconfig']);
ok(/SLAAC address 2001:db8:aa::/.test(out.join(' ')), 'the CLI reports the address it removed');
eq(h1.config.ip6.eth0, undefined, 'H1 no longer has the address');
eq(h1.interfaces.get('eth0').autoconfig, false, 'and is no longer waiting for a router');
eq(h1.config.gateway6, null, 'the gateway learned from that advertisement is gone too');

res = new Simulator(t).ping6(h1.id, h2Addr, { count: 1 });
ok(!res.replies[0].success, 'a ping6 from the withdrawn host now fails, as it should');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
