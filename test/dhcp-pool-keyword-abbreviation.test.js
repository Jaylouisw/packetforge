'use strict';
// `(dhcp-config)#` shortens its keywords -- `net`, `def`, `dns`, `lea inf`, `exi`
//
// Cisco writes the abbreviation rule for "commands and keywords" and names no mode in it: "you can abbreviate
// commands and keywords to the number of characters that allow a unique abbreviation" (Cisco IOS XE 16
// Fundamentals Configuration Guide, Using the Cisco IOS Command-Line Interface,
// https://cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/configuration/xe-16/fundamentals-xe-16-book/cf-cli-basics.html).
// This console applies it to the prompt's first word, the view word after `show`, the first word of a config line
// and the interface sub-mode - and the DHCP pool was the one prompt left out: every shortening answered
// `% Unrecognized DHCP pool command`, the sentence a typo gets, about a line a box accepts.
//
// Operators write it that way: `Router(dhcp-config)#net 192.168.100.0 255.255.255.0` / `#def 192.168.100.1` /
// `#dns 192.168.100.1` (https://www.scribd.com/document/503286513/02-JOBSHEET-DNSNAT-CISCO),
// `CME_RTR(dhcp-config)# net 192.168.10.0 255.255.255.0` (https://www.scribd.com/document/687806885/NET201Lesson6-),
// `R2(dhcp-config)#net ...` and `#exi` (https://es.scribd.com/document/380024270/Configuracion-de-Routers-y-Switches),
// and `ip dhcp p` followed by `net ...` (https://blog.csdn.net/weixin_57619594/article/details/147009200).
// research/dhcp-pool-keyword-abbreviation.md records which of those captures are Packet Tracer rather than
// hardware, and why the vendor's own rule - not a simulator's prompt - is the evidence this console follows.
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = require('path').join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /ISR 4331/.test(s.model); });

function session(lines) {
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  const dev = t.getDevice('r1');
  const s = new CliSession(dev, t, null);
  const outputs = [];
  ['enable', 'configure terminal'].concat(lines || []).forEach(function (c) {
    const r = s.run(c);
    outputs.push(((r && r.output) || []).join('\n'));
  });
  return { dev: dev, s: s, outputs: outputs, last: outputs[outputs.length - 1] || '' };
}
function pool(dev, name) {
  const p = (dev.config.dhcpPools || []).filter(function (x) { return x.name === name; })[0] || null;
  return p;
}

console.log('Every shortening reaches the same door as the whole word:');
{
  const env = session([
    'ip dhcp pool lan',
    'net 192.168.10.0 255.255.255.0',
    'def 192.168.10.1',
    'dns 8.8.8.8',
    'rang 192.168.10.100 192.168.10.110',
    'lea inf',
    'ho 192.168.10.104 aa:bb:cc:00:00:98'
  ]);
  const p = pool(env.dev, 'lan');
  ok(!!p, 'the pool exists');
  ok(p && p.network === '192.168.10.0', '`net` set the network', p && p.network);
  ok(p && p.mask === '255.255.255.0', 'and the mask that travelled with it', p && p.mask);
  ok(p && p.gateway === '192.168.10.1', '`def` set the default router', p && p.gateway);
  ok(p && p.dns === '8.8.8.8', '`dns` set the name server', p && p.dns);
  ok(p && p.rangeStart === '192.168.10.100' && p.rangeEnd === '192.168.10.110',
    '`rang` set both ends of the range', p && (p.rangeStart + '-' + p.rangeEnd));
  ok(p && p.leaseSec === 'infinite', '`lea inf` is the infinite lease, not a missing number', p && String(p.leaseSec));
  ok(p && p.reservations && p.reservations['aa:bb:cc:00:00:98'] === '192.168.10.104',
    '`ho` made the reservation', p && JSON.stringify(p.reservations));
  ok(env.outputs.every(function (o) { return !/Unrecognized DHCP pool/.test(o); }),
    'and not one of the six lines was called unrecognized');
}

console.log('');
console.log('The whole spellings still work, which is the control:');
{
  const env = session([
    'ip dhcp pool lan',
    'network 192.168.10.0 255.255.255.0',
    'default-router 192.168.10.1',
    'dns-server 9.9.9.9',
    'range 192.168.10.100 192.168.10.110',
    'lease infinite'
  ]);
  const p = pool(env.dev, 'lan');
  ok(p && p.network === '192.168.10.0' && p.gateway === '192.168.10.1' && p.dns === '9.9.9.9',
    'the full words set the same fields', p && JSON.stringify(p));
  ok(p && p.leaseSec === 'infinite', 'and `lease infinite` is unchanged', p && String(p.leaseSec));
}

console.log('');
console.log('`excluded-address` is one door spelled three ways, and the two-word form keeps its middle word:');
{
  const env = session([
    'ip dhcp pool lan',
    'excluded-address 192.168.10.1',
    'excluded address 192.168.10.2',
    'excl 192.168.10.3'
  ]);
  const p = pool(env.dev, 'lan');
  const ex = (p && Array.isArray(p.excluded)) ? p.excluded : [];
  ok(ex.length === 3, 'three addresses were excluded, not two and a word', JSON.stringify(ex));
  ok(ex.indexOf('192.168.10.2') !== -1 && ex.indexOf('address') === -1,
    '`excluded address <ip>` stored the address and not the word "address"', JSON.stringify(ex));
  ok(ex.indexOf('192.168.10.3') !== -1, '`excl` reached the same door', JSON.stringify(ex));
  const env2 = session(['ip dhcp pool lan', 'excluded-address 192.168.10.1', 'excluded address 192.168.10.2',
    'no excluded address 192.168.10.2']);
  const ex2 = (pool(env2.dev, 'lan') || {}).excluded || [];
  ok(ex2.length === 1 && ex2[0] === '192.168.10.1',
    'and `no excluded address <ip>` removes that one address', JSON.stringify(ex2));
  const env3 = session(['ip dhcp pool lan', 'excluded-address 192.168.10.1', 'no excl 192.168.10.1']);
  ok((((pool(env3.dev, 'lan') || {}).excluded) || []).length === 0,
    '`no excl` removes it too', JSON.stringify((pool(env3.dev, 'lan') || {}).excluded));
}

console.log('');
console.log('The `no` side shortens, and an exact spelling is never made a rival of a longer word:');
{
  const env = session(['ip dhcp pool lan', 'net 192.168.10.0 255.255.255.0', 'lea 1', 'no net']);
  const p = pool(env.dev, 'lan');
  ok(p && p.network === undefined, '`no net` cleared the network', p && JSON.stringify(p));
  ok(/Network cleared/.test(env.last), 'and said so', env.last);
  const env2 = session(['ip dhcp pool lan', 'no po']);
  ok(!pool(env2.dev, 'lan'), '`no po` removed the whole pool');
  ok(/Removed DHCP pool/.test(env2.last), 'and said so', env2.last);
}

console.log('');
console.log('A shortening that could be two words is refused with both named, and changes nothing:');
{
  const env = session(['ip dhcp pool lan', 'network 192.168.10.0 255.255.255.0', 'e']);
  ok(/Ambiguous DHCP pool command "e"/.test(env.last), '`e` is ambiguous', env.last);
  ok(/exit/.test(env.last) && /end/.test(env.last) && /excluded-address/.test(env.last),
    'and the refusal names every word it could have been', env.last);
  ok(pool(env.dev, 'lan').network === '192.168.10.0', 'nothing was applied');
  const env2 = session(['ip dhcp pool lan', 'n']);
  ok(/Ambiguous DHCP pool command "n"/.test(env2.last) && /network/.test(env2.last) && /\bno\b/.test(env2.last),
    '`n` is ambiguous between `network` and `no`', env2.last);
  const env3 = session(['ip dhcp pool lan', 'h']);
  ok(/Ambiguous DHCP pool command "h"/.test(env3.last), '`h` is ambiguous between `host` and `help`', env3.last);
  const env4 = session(['ip dhcp pool lan', 'foo 1']);
  ok(/Unrecognized DHCP pool command: foo 1/.test(env4.last),
    'a word the mode really does not have keeps the sentence it had', env4.last);
}

console.log('');
console.log('`lease` numbers are untouched, and the shortened words leave the mode too:');
{
  const env = session(['ip dhcp pool lan', 'lease 0']);
  ok(/longer than zero/.test(env.last), '`lease 0` is still refused as a zero-length lease', env.last);
  const env2 = session(['ip dhcp pool lan', 'lease xyz']);
  ok(/Incomplete command: lease/.test(env2.last), 'and a word that is not a number is still incomplete', env2.last);
  const env3 = session(['ip dhcp pool lan', 'exi']);
  ok(env3.s.mode !== 'dhcp-pool', '`exi` leaves the pool, as `exit` does', env3.s.mode);
  const env4 = session(['ip dhcp pool lan', 'en']);
  ok(env4.s.mode === 'enable', '`en` leaves for privileged EXEC, as `end` does', env4.s.mode);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
