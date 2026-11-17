'use strict';
// nat-default-timeouts.test.js -- the ageing defaults are Cisco's published ones.
//
// The model held a TCP translation for one hour and every other protocol for five minutes. Cisco's
// `ip nat translation (timeout)` reference gives tcp-timeout 86400 s, udp-timeout 300 s, icmp-timeout
// 60 s, and the general `timeout` 86400 s:
//   https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-i4.html
// The IE9300 configuration guide says the same in prose (established TCP 24 hours, UDP 5 minutes,
// ICMP 1 minute):
//   https://www.cisco.com/c/en/us/td/docs/switches/lan/cisco_ie9300/software/17_7/ip-addressing-config-ie93xx/g-ie93xx-l3-nat/t-config-address-translation-timeouts.html
// research/nat-default-timeouts.md records what is modelled and what is not (FIN/RST, SYN, DNS).
//
// Pure library checks: no device, no topology, no clock. Steps are seconds.

const nat = require('../engine/nat');

let passed = 0;
let failed = 0;

function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

function eq(actual, expected, msg) {
  ok(actual === expected, msg, 'got ' + JSON.stringify(actual));
}

function pkt(proto, srcIp) {
  return { protocol: proto, srcIp: srcIp || '192.168.1.10', srcPort: proto === 'tcp' || proto === 'udp' ? 40000 : null,
    dstIp: '203.0.113.9', dstPort: proto === 'tcp' || proto === 'udp' ? 443 : null };
}

// One dynamic rule, one address in the pool, so the one entry is the only thing that can expire.
function oneEntry(proto, step) {
  const t = nat.createNatTable();
  t.rules.push(nat.normalizeRule({ type: 'dynamic', insideLocal: '192.168.1.0/24',
    insideGlobal: '203.0.113.5-203.0.113.5', protocol: proto }));
  const made = nat.translateOutbound(t, pkt(proto), step || 0);
  if (made.action !== 'translate') throw new Error('setup: ' + made.action + ' ' + (made.reason || ''));
  return t;
}

console.log('');
console.log('The defaults are the vendor\'s protocol timers');
{
  eq(nat.DEFAULT_TIMEOUTS.icmp, 60, 'ICMP is held for 60 seconds');
  eq(nat.DEFAULT_TIMEOUTS.udp, 300, 'UDP is held for 300 seconds');
  eq(nat.DEFAULT_TIMEOUTS.tcp, 86400, 'established TCP is held for 86400 seconds (24 hours)');
  eq(nat.DEFAULT_TIMEOUTS.default, 86400, 'every other protocol takes the general 86400-second timeout');
  eq(nat.timeoutFor(null, 'tcp'), 86400, 'timeoutFor() reads the TCP default');
  eq(nat.timeoutFor(null, 'gre'), 86400, 'timeoutFor() gives GRE the general default');
  eq(nat.timeoutFor({ tcp: 60 }, 'tcp'), 60, 'a configured value still wins over the default');
}

console.log('');
console.log('A TCP translation is idle, not dead, after an hour');
{
  const t = oneEntry('tcp');
  eq(nat.expireTranslations(t, null, 3600), 0,
    'one hour of silence does not expire a TCP translation (the old one-hour default did)');
  eq(nat.expireTranslations(t, null, 86399), 0, 'and it is still there one second before 24 hours');
  eq(nat.expireTranslations(t, null, 86400), 1, 'it expires at 24 hours of silence');
  eq(t.translations.length, 0, 'the table is empty afterwards');
}

console.log('');
console.log('The overrides are still per-protocol');
{
  const udp = oneEntry('udp');
  eq(nat.expireTranslations(udp, null, 299), 0, 'UDP survives 299 seconds');
  eq(nat.expireTranslations(udp, null, 300), 1, 'and expires at 300 seconds');

  const icmp = oneEntry('icmp');
  eq(nat.expireTranslations(icmp, null, 59), 0, 'ICMP survives 59 seconds');
  eq(nat.expireTranslations(icmp, null, 60), 1, 'and expires at 60 seconds');

  const gre = oneEntry('gre');
  eq(nat.expireTranslations(gre, null, 3600), 0, 'a non-TCP/UDP/ICMP flow is not treated as UDP');
  eq(nat.expireTranslations(gre, null, 86400), 1, 'it follows the general 24-hour timeout');
}

console.log('');
console.log('Use restarts the idle clock at the longer default');
{
  const t = oneEntry('tcp', 0);
  nat.translateOutbound(t, pkt('tcp'), 3600);
  eq(nat.expireTranslations(t, null, 3600 + 86399), 0,
    'a TCP translation used at one hour survives another 24 hours of silence');
  eq(nat.expireTranslations(t, null, 3600 + 86400), 1, 'and then expires');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
