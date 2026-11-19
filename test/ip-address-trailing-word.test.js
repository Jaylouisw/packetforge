'use strict';
// `ip address` reads one optional word after the mask, and refuses every other word instead of applying the
// address anyway.
//
// The line a box documents is `ip address ip-address mask [secondary]`, and the reference says what that word
// buys: "An interface can have one primary IP address and multiple secondary IP addresses"
// (https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/ip_address.htm).
// Its own worked example prints the primary and two `secondary` lines on one interface, so `secondary` ADDS an
// address - it does not replace the primary:
//
//     interface ethernet 0
//     ip address 131.108.1.27 255.255.255.0
//     ip address 192.31.7.17 255.255.255.0 secondary
//     ip address 192.31.8.17 255.255.255.0 secondary
//
// Any other word is a parse error, not a success: `% Invalid input detected at '^' marker.` is the message
// Cisco's CLI chapter defines as "You entered the command incorrectly", with the caret under the token it could
// not read (https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/configuration/xe-16-6/
// fundamentals-xe-16-6-book/cf-cli-basics.pdf).
//
// This console dropped the word and set the address anyway, which made `... secondary` a *replacement* of the
// primary reported as "IP address set": a port holding 10.0.0.1/24 came back holding 10.0.0.2/24 with nothing
// said about the first address. One address per port is what this model has - the front panel and
// `show ip interface brief` print that one - so `secondary` cannot be honoured here; it is refused by name and
// nothing is changed.
//
// The same silence covered two neighbours of the same handler: `ip address dhcp 5` put the port into DHCP
// client mode, and `no ip address foo` removed the address the port held.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const { displayName } = require('../engine/iface-name');
const netLib = require('../engine/net');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

function lab(spec) {
  const t = new Topology();
  const d = t.addDevice(spec || ROUTER, 'r1');
  const sim = new Simulator(t);
  const cli = new CliSession(d, t, sim);
  cli.run('enable');
  cli.run('configure terminal');
  const port = [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; })[0].name;
  const ipOf = function (name) {
    const i = d.interfaces.get(name);
    return i.ip ? i.ip + '/' + netLib.prefixOf(i.mask) : null;
  };
  const say = function (line, iface) {
    const target = iface || port;
    return cli.run('interface ' + target).output.concat(cli.run(line).output).concat(cli.run('exit').output);
  };
  const refusals = function (lines) {
    return lines.filter(function (l) { return /^\s*%/.test(l); }).join(' | ');
  };
  const brief = function (name) {
    const row = cli.run('show ip interface brief').output.filter(function (l) {
      return l.indexOf(displayName(name || port) + ' ') === 0;
    })[0] || '';
    return row.replace(/\s+/g, ' ').trim();
  };
  const dump = function () { return JSON.stringify(d.config); };
  return { t: t, d: d, sim: sim, cli: cli, port: port, ipOf: ipOf, say: say, refusals: refusals,
    brief: brief, dump: dump };
}

console.log('');
console.log('1. `secondary` is refused by name and leaves the primary address alone');
{
  const env = lab();
  env.say('ip address 10.0.0.1 255.255.255.0');
  ok(env.ipOf(env.port) === '10.0.0.1/24', 'the primary address is set', env.ipOf(env.port));
  const before = env.dump();
  const said = env.say('ip address 10.0.0.2 255.255.255.0 secondary');
  const text = env.refusals(said);
  ok(/secondary/.test(text), 'the refusal names the word back', text);
  ok(/one address per port/.test(text), 'and says why it cannot be honoured here', text);
  ok(/not changed/.test(text), 'and says nothing was changed', text);
  ok(env.ipOf(env.port) === '10.0.0.1/24', 'the port still holds the primary address', env.ipOf(env.port));
  ok(env.dump() === before, 'and no configuration was written', env.dump().slice(0, 120));
  ok(/10\.0\.0\.1/.test(env.brief()), 'show ip interface brief still prints 10.0.0.1', env.brief());
}

console.log('');
console.log('2. Any other word after the mask is refused, and the address is not applied');
{
  const env = lab();
  const before = env.dump();
  const said = env.say('ip address 10.0.0.9 255.255.255.0 nonsense');
  const text = env.refusals(said);
  ok(/nonsense/.test(text), 'the word is quoted back', text);
  ok(/only "secondary"/.test(text), 'and the line says which word this command does take', text);
  ok(env.ipOf(env.port) === null, 'no address was set', String(env.ipOf(env.port)));
  ok(env.dump() === before, 'and no configuration was written', env.dump().slice(0, 120));

  const p = lab();
  const saidPrimary = p.say('ip address 10.0.0.9 255.255.255.0 primary');
  ok(/primary/.test(p.refusals(saidPrimary)), 'primary is refused too - a box has no such keyword',
    p.refusals(saidPrimary));
  ok(p.ipOf(p.port) === null, 'and it does not set the address', String(p.ipOf(p.port)));
}

console.log('');
console.log('3. The same line on a switch port does not slip through');
{
  const env = lab(SWITCH);
  const before = env.dump();
  const said = env.say('ip address 10.0.0.9 255.255.255.0 secondary');
  ok(/secondary/.test(env.refusals(said)), 'a switch port refuses secondary the same way', env.refusals(said));
  ok(env.ipOf(env.port) === null, 'and holds no address afterwards', String(env.ipOf(env.port)));
  ok(env.dump() === before, 'with the configuration untouched', env.dump().slice(0, 120));
}

console.log('');
console.log('4. ip address dhcp with a word is refused and the method does not change');
{
  const env = lab();
  const before = env.dump();
  const said = env.say('ip address dhcp 5');
  const text = env.refusals(said);
  ok(/"5"/.test(text), 'the word is quoted back', text);
  ok(/takes no argument/.test(text), 'and the line says dhcp takes none', text);
  ok(env.d.interfaces.get(env.port).dhcp !== true, 'the port is not a DHCP client', env.brief());
  ok(/unset/.test(env.brief()), 'and show ip interface brief still says the method is unset', env.brief());
  ok(env.dump() === before, 'and no configuration was written', env.dump().slice(0, 120));
}

console.log('');
console.log('5. no ip address with a word is refused and the address stays');
{
  const env = lab();
  env.say('ip address 10.0.0.1 255.255.255.0');
  const before = env.dump();
  const said = env.say('no ip address foo');
  const text = env.refusals(said);
  ok(/foo/.test(text), 'the word is quoted back', text);
  ok(/nothing was removed/.test(text), 'and the refusal says the address survived', text);
  ok(env.ipOf(env.port) === '10.0.0.1/24', 'the address is still on the port', env.ipOf(env.port));
  ok(env.dump() === before, 'and no configuration was written', env.dump().slice(0, 120));
}

console.log('');
console.log('6. The documented forms still work');
{
  const env = lab();
  const said = env.say('ip address 10.0.0.5 255.255.255.0');
  ok(/IP address set on/.test(said.join(' ')), 'ip address <ip> <mask> still sets the primary', said.join(' | '));
  ok(env.ipOf(env.port) === '10.0.0.5/24', 'and the port holds it', env.ipOf(env.port));
  env.say('ip address 10.0.0.6 255.255.255.0');
  ok(env.ipOf(env.port) === '10.0.0.6/24', 'a second plain address line still replaces the primary',
    env.ipOf(env.port));
  const cleared = env.say('no ip address');
  ok(env.ipOf(env.port) === null, 'no ip address still clears it', cleared.join(' | '));

  const dhcp = lab();
  const dhcpSaid = dhcp.say('ip address dhcp');
  ok(dhcp.d.interfaces.get(dhcp.port).dhcp === true, 'ip address dhcp still makes the port a DHCP client',
    dhcpSaid.join(' | '));
}

console.log('');
if (failed) {
  console.error(passed + ' passed, ' + failed + ' failed');
  process.exit(1);
}
console.log(passed + ' passed, 0 failed');
