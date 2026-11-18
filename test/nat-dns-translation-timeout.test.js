'use strict';
// nat-dns-translation-timeout.test.js -- a DNS translation ages out in 60 seconds, not 300.
//
// The NAT ageing note (research/nat-default-timeouts.md) recorded `dns-timeout` as an unresolved gap with the
// evidence "already in hand". The evidence says what the timer is for, and it is not a protocol:
//
//   * `ip nat translation (timeout)` - "dns-timeout ... applies to connections to the Domain Name System
//     (DNS). The default is 60 seconds." Its usage guidelines give the contrast this model needs, in one
//     sentence: "When port translation is configured, each entry contains more information about the traffic
//     that is using the translation, which gives you finer control over translation entry timeouts. Non-DNS
//     UDP translations time out after 5 minutes, and DNS times out in 1 minute."
//       https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-i4.html
//   * The DNS ALG is enabled by default, so this is not an opt-in: "The DNS ALG feature is enabled as soon as
//     NAT is configured on the device", and `no ip nat service dns udp` is how it is turned off.
//       https://www.cisco.com/c/en/us/support/docs/csa/cisco-sa-alg-dos-hbBS7SZE.html
//   * The ALG's default port is 53; `ip nat service dns udp port <n>` moves it.
//       https://cisco.com/c/en/us/td/docs/routers/sdwan/command/iosxe/qualified-cli-command-reference-guide/m-NAT-commands.html
//
// So a UDP entry in the port-translation table whose destination is port 53 is a DNS translation and takes
// the 60-second timer; every other UDP entry keeps 300. What is not modelled, and is pinned below as such:
// the TCP side of the ALG, a non-default ALG port, and DNS payload rewriting.
//
// research/nat-dns-translation-timeout.md has the sources and what would settle the open parts.

const path = require('path');
const nat = require('../engine/nat');
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0;
let failed = 0;

function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ' + '\u2713' + ' ' + msg); }
  else { failed++; console.error('  ' + '\u2717' + ' ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

function eq(actual, expected, msg) {
  ok(actual === expected, msg, 'got ' + JSON.stringify(actual));
}

// A port-translated (overload) table: one global address, so every entry is a PAT entry and carries the
// destination port of the flow that made it.
function patTable(proto) {
  const t = nat.createNatTable();
  t.rules.push(nat.normalizeRule({ type: 'pat', insideLocal: '192.168.1.0/24',
    insideGlobal: '203.0.113.5', protocol: proto || 'udp' }));
  return t;
}

function udpPacket(dstPort, srcPort) {
  return { protocol: 'udp', srcIp: '192.168.1.10', srcPort: srcPort || 40000,
    dstIp: '198.51.100.53', dstPort: dstPort };
}

function onePat(proto, dstPort, step) {
  const t = patTable(proto);
  const made = nat.translateOutbound(t, udpPacket(dstPort), step || 0);
  if (made.action !== 'translate') throw new Error('setup: ' + made.action + ' ' + (made.reason || ''));
  return t;
}

console.log('');
console.log('DNS is a kind of UDP entry, not a fourth protocol');
{
  eq(nat.DNS_ALG_PORT, 53, 'the DNS ALG listens on its default port, 53');
  eq(nat.DEFAULT_TIMEOUTS.dns, 60, 'dns-timeout defaults to 60 seconds');
  eq(nat.timeoutFor(null, 'udp', nat.DNS_ALG_PORT), 60, 'a UDP entry to port 53 gets the 60-second timer');
  eq(nat.timeoutFor(null, 'udp', '53'), 60, 'and the port may arrive as the string a packet carries');
  eq(nat.timeoutFor(null, 'udp', 54), 300, 'a UDP entry to any other port keeps the 300-second timer');
  eq(nat.timeoutFor(null, 'udp', 5353), 300, 'and a port that merely ends in 53 is not the ALG port');
  eq(nat.timeoutFor(null, 'udp'), 300, 'an entry with no destination port is plain UDP');
  eq(nat.timeoutFor(null, 'tcp', nat.DNS_ALG_PORT), 86400,
    'DNS over TCP is not shortened: the reference puts the 1-minute rule in its UDP sentence, so TCP keeps 24 hours');
  eq(nat.timeoutFor(null, 'icmp', nat.DNS_ALG_PORT), 60, 'ICMP is 60 seconds for its own reason, not this one');
}

console.log('');
console.log('A configured timer wins, and only the timer it names');
{
  eq(nat.timeoutFor({ udp: 600 }, 'udp', nat.DNS_ALG_PORT), 60,
    'a configured udp-timeout does not move a DNS translation - the two are separate timers');
  eq(nat.timeoutFor({ udp: 600 }, 'udp', 54), 600, 'and it does move every other UDP entry');
  eq(nat.timeoutFor({ dns: 90 }, 'udp', nat.DNS_ALG_PORT), 90, 'a configured dns-timeout is the one that applies');
  eq(nat.timeoutFor({ dns: 90 }, 'udp', 54), 300, 'and it leaves ordinary UDP alone');
  eq(nat.timeoutFor({ default: 120 }, 'udp', nat.DNS_ALG_PORT), 120,
    'the general timeout is the fallback, as it is for every other entry');
}

console.log('');
console.log('The entry is gone at 60 seconds of silence, not at 300');
{
  const t = onePat('udp', nat.DNS_ALG_PORT);
  eq(nat.expireTranslations(t, null, 59), 0, 'at 59 s the DNS translation is still in force');
  eq(t.translations.length, 1, 'and still in the table');
  eq(nat.expireTranslations(t, null, 60), 1, 'at 60 s it is aged out');
  eq(t.translations.length, 0, 'and the table is empty');
}

console.log('');
console.log('An ordinary UDP entry is not shortened by its neighbours');
{
  const t = onePat('udp', 54);
  eq(nat.expireTranslations(t, null, 60), 0, 'at 60 s a UDP entry to port 54 is still in force');
  eq(nat.expireTranslations(t, null, 299), 0, 'at 299 s it still is');
  eq(nat.expireTranslations(t, null, 300), 1, 'at 300 s it goes');
}

console.log('');
console.log('A DNS translation that is still being used is not aged');
{
  const t = onePat('udp', nat.DNS_ALG_PORT, 0);
  // The second query to the same destination is the same entry, refreshed: idle time, not a lifetime.
  const again = nat.translateOutbound(t, udpPacket(nat.DNS_ALG_PORT), 45);
  ok(again.action === 'translate' && again.entry && again.entry.hits === 2,
    'a repeat query reuses the entry and counts the hit', again.action);
  eq(nat.expireTranslations(t, null, 100), 0, '55 s after the repeat it is still in force');
  eq(nat.expireTranslations(t, null, 105), 1, '60 s after the repeat it goes, not 60 s after it was made');
}

console.log('');
console.log('A simple dynamic entry keeps the protocol timer, DNS port or not');
{
  // No overload: the destination port is only the first flow's port, so it cannot decide how long an
  // address-sharing entry lives. The vendor's 1-minute sentence is written for port translation.
  const t = nat.createNatTable();
  t.rules.push(nat.normalizeRule({ type: 'dynamic', insideLocal: '192.168.1.0/24',
    insideGlobal: '203.0.113.10-203.0.113.10', protocol: 'udp' }));
  const made = nat.translateOutbound(t, udpPacket(nat.DNS_ALG_PORT), 0);
  ok(made.action === 'translate', 'the dynamic rule translates a DNS-bound flow', made.reason || made.action);
  eq(nat.expireTranslations(t, null, 60), 0, 'at 60 s the dynamic entry is still in force');
  eq(nat.expireTranslations(t, null, 300), 1, 'at 300 s it goes, on the UDP timer');
}

console.log('');
console.log('show ip nat statistics prints the timer it is holding entries to');
{
  const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
  const spec = catalog.find(function (s) { return /ISR 4331/.test(s.model); });
  const topo = new Topology();
  const r1 = topo.addDevice(spec, 'r1');
  const session = new CliSession(r1, topo, new Simulator(topo));
  const lineOf = function () {
    return ((session.run('show ip nat statistics') || {}).output || [])
      .filter(function (l) { return /^Timeouts \(seconds\)/.test(l); })[0] || '';
  };
  const line = lineOf();
  ok(/dns 60/.test(line), 'the DNS timer is on the line', line);
  ok(/^Timeouts \(seconds\): icmp 60, udp 300, dns 60, tcp 86400, other 86400$/.test(line),
    'in the same shape as the others', line);
  if (!r1.config.nat) r1.config.nat = {};
  r1.config.nat.timeouts = { dns: 90 };
  const moved = lineOf();
  ok(/dns 90/.test(moved), 'a configured dns-timeout is what the box reports', moved);
  ok(/udp 300/.test(moved), 'and udp is untouched by it', moved);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
