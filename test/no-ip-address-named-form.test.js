'use strict';
// `no ip address <address> <mask>` - the documented two-word form, and the address it does not match.
//
// Cisco's `ip address` reference prints both syntax lines, the second taking the address being removed:
//
//     ip address ip-address mask [secondary]
//     no ip address ip-address mask [secondary]
//
// (https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/ip_address.htm).
// A Cisco defect record's workaround shows an operator using it on a live SVI - `no ip address
// 192.168.1.100 255.255.255.0` then the same line again to refresh it - so the form is not merely syntax
// (CSCvr84846, https://www.findbugzero.com/operational-defect-database/vendors/cisco/defects/CSCvr84846).
//
// The address is matched, not ignored. Asked to remove an address the interface does not hold, a box keeps
// its address and answers `Invalid address`; the reply to the operator whose paste shows that line is "you
// need to match the current ip of the interface"
// (https://community.spiceworks.com/t/removal-of-an-ip-from-a-vlan-in-a-cisco-switch/1057490).
//
// Before this test existed the whole form was refused with a sentence saying the command takes no argument -
// so a configuration file that removed one named address could not be replayed - and before that refusal
// existed the word was dropped and whatever the port held was removed.
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

function lab() {
  const t = new Topology();
  const d = t.addDevice(ROUTER, 'r1');
  const sim = new Simulator(t);
  const cli = new CliSession(d, t, sim);
  cli.run('enable');
  cli.run('configure terminal');
  const ports = [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  const port = ports[0].name;
  const second = (ports[1] || {}).name || null;
  const ipOf = function (name) {
    const i = d.interfaces.get(name || port);
    return i && i.ip ? i.ip + '/' + netLib.prefixOf(i.mask) : null;
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
  const running = function () { return cli.run('show running-config').output.join('\n'); };
  const dump = function () { return JSON.stringify(d.config); };
  return { t: t, d: d, sim: sim, cli: cli, port: port, second: second, ipOf: ipOf, say: say,
    refusals: refusals, brief: brief, running: running, dump: dump };
}

console.log('');
console.log('1. The named address is removed when it is the one the port holds');
{
  const env = lab();
  env.say('ip address 10.0.0.1 255.255.255.0');
  ok(env.ipOf(env.port) === '10.0.0.1/24', 'the port holds 10.0.0.1/24', env.ipOf(env.port));
  ok(/ip address 10\.0\.0\.1 255\.255\.255\.0/.test(env.running()), 'and the running-config prints it');
  const said = env.say('no ip address 10.0.0.1 255.255.255.0');
  ok(env.refusals(said) === '', 'the matching form is accepted - no refusal', env.refusals(said));
  ok(/removed from/.test(said.join(' ')), 'and says what it removed', said.join(' | '));
  ok(env.ipOf(env.port) === null, 'the port holds no address afterwards', String(env.ipOf(env.port)));
  ok(/unassigned/.test(env.brief()), 'show ip interface brief says unassigned', env.brief());
  ok(!/ip address 10\.0\.0\.1/.test(env.running()), 'and the line is gone from the running-config');
}

console.log('');
console.log('2. The mask may be given as a prefix length, as `ip address` accepts it');
{
  const env = lab();
  env.say('ip address 10.0.0.7 255.255.255.0');
  const said = env.say('no ip address 10.0.0.7 24');
  ok(env.refusals(said) === '', '10.0.0.7 24 matches 10.0.0.7/24', env.refusals(said));
  ok(env.ipOf(env.port) === null, 'and the address is removed', String(env.ipOf(env.port)));
}

console.log('');
console.log('3. An address the port does not hold is refused and nothing is removed');
{
  const env = lab();
  env.say('ip address 10.0.0.1 255.255.255.0');
  const before = env.dump();
  const said = env.say('no ip address 10.0.0.9 255.255.255.0');
  const text = env.refusals(said);
  ok(/^% Invalid address/.test(text), 'the answer begins with the vendor\'s two words', text);
  ok(/10\.0\.0\.1\/24/.test(text), 'it names the address the port actually holds', text);
  ok(/nothing was removed/.test(text), 'and says nothing was removed', text);
  ok(env.ipOf(env.port) === '10.0.0.1/24', 'the address is still on the port', env.ipOf(env.port));
  ok(env.dump() === before, 'and no configuration was written', env.dump().slice(0, 120));
}

console.log('');
console.log('4. The right address under the wrong mask is a different address, and is refused');
{
  const env = lab();
  env.say('ip address 10.0.0.1 255.255.255.0');
  const before = env.dump();
  const said = env.say('no ip address 10.0.0.1 255.255.0.0');
  ok(/^% Invalid address/.test(env.refusals(said)), 'a /16 removal of a /24 address is refused',
    env.refusals(said));
  ok(env.ipOf(env.port) === '10.0.0.1/24', 'the /24 address stays', env.ipOf(env.port));
  ok(env.dump() === before, 'with the configuration untouched', env.dump().slice(0, 120));
}

console.log('');
console.log('5. A port with no address says so, and stays empty');
{
  const env = lab();
  const before = env.dump();
  const said = env.say('no ip address 10.0.0.1 255.255.255.0');
  const text = env.refusals(said);
  ok(/^% Invalid address/.test(text), 'the removal of an address that is not there is refused', text);
  ok(/no address/.test(text), 'and the refusal says the port holds none', text);
  ok(env.ipOf(env.port) === null, 'the port is still unassigned', String(env.ipOf(env.port)));
  ok(env.dump() === before, 'and nothing was written', env.dump().slice(0, 120));
}

console.log('');
console.log('6. `secondary` is refused by name and the primary survives');
{
  const env = lab();
  env.say('ip address 10.0.0.1 255.255.255.0');
  const before = env.dump();
  const said = env.say('no ip address 10.0.0.1 255.255.255.0 secondary');
  const text = env.refusals(said);
  ok(/secondary/.test(text), 'the word is named back', text);
  ok(/one address per port/.test(text), 'and the reason is the model\'s single address', text);
  ok(/nothing was removed/.test(text), 'and it says nothing was removed', text);
  ok(env.ipOf(env.port) === '10.0.0.1/24', 'the primary address is still there', env.ipOf(env.port));
  ok(env.dump() === before, 'with the configuration untouched', env.dump().slice(0, 120));
}

console.log('');
console.log('7. An address without its mask is incomplete, not a removal');
{
  const env = lab();
  env.say('ip address 10.0.0.1 255.255.255.0');
  const said = env.say('no ip address 10.0.0.1');
  ok(/^% Incomplete command/.test(env.refusals(said)), 'the missing mask is called incomplete',
    env.refusals(said));
  ok(/<address> <mask>/.test(env.refusals(said)), 'and the refusal prints the form it needs', env.refusals(said));
  ok(env.ipOf(env.port) === '10.0.0.1/24', 'the address stays', env.ipOf(env.port));
}

console.log('');
console.log('8. A word that is not an address is still refused, and the address stays');
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
console.log('9. The bare form is unchanged, and removes a DHCP client by name');
{
  const env = lab();
  env.say('ip address 10.0.0.1 255.255.255.0');
  const said = env.say('no ip address');
  ok(/removed from/.test(said.join(' ')), 'the bare form still removes the address', said.join(' | '));
  ok(env.ipOf(env.port) === null, 'and the port is empty', String(env.ipOf(env.port)));
  ok(/^% No IP address on/.test(env.refusals(env.say('no ip address'))), 'a second bare form says there is none',
    env.refusals(env.say('no ip address')));

  const dhcp = lab();
  dhcp.say('ip address dhcp');
  const dhcpSaid = dhcp.say('no ip address');
  ok(/DHCP client removed/.test(dhcpSaid.join(' ')), 'the bare form removes the DHCP client', dhcpSaid.join(' | '));
}

console.log('');
console.log('10. A learned (leased) address is not a configured one: the named form refuses a DHCP port');
{
  const env = lab();
  env.say('ip address dhcp');
  const before = env.dump();
  const said = env.say('no ip address 10.0.0.1 255.255.255.0');
  const text = env.refusals(said);
  ok(/^% Invalid address/.test(text), 'the named form is refused on a DHCP client', text);
  ok(/DHCP client/.test(text), 'and the refusal says the port is a client', text);
  ok(env.d.interfaces.get(env.port).dhcp === true, 'the port is still a DHCP client');
  ok(env.dump() === before, 'and no configuration was written', env.dump().slice(0, 120));
}

console.log('');
console.log('11. Another port is not touched');
{
  const env = lab();
  if (!env.second) {
    ok(false, 'this device has a second ethernet port to test');
  } else {
    env.say('ip address 10.0.0.1 255.255.255.0');
    env.say('ip address 10.0.1.1 255.255.255.0', env.second);
    const said = env.say('no ip address 10.0.0.1 255.255.255.0');
    ok(env.refusals(said) === '', 'the named removal on the first port is accepted', env.refusals(said));
    ok(env.ipOf(env.port) === null, 'the first port is emptied', String(env.ipOf(env.port)));
    ok(env.ipOf(env.second) === '10.0.1.1/24', 'the second port keeps its address', env.ipOf(env.second));
  }
}

console.log('');
console.log('12. Abbreviations reach the same handler');
{
  const env = lab();
  env.say('ip address 10.0.0.1 255.255.255.0');
  const said = env.say('no ip addr 10.0.0.1 255.255.255.0');
  ok(env.refusals(said) === '', '`no ip addr` is the same command', env.refusals(said));
  ok(env.ipOf(env.port) === null, 'and removes the address', String(env.ipOf(env.port)));
}

console.log('');
if (failed) {
  console.error(passed + ' passed, ' + failed + ' failed');
  process.exit(1);
}
console.log(passed + ' passed, 0 failed');
