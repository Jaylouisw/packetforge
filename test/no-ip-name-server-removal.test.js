'use strict';
// `no ip name-server <address>` removes the address it names, and leaves every other resolver alone.
//
// The vendor's no-form carries the addresses to remove: `no ip name-server [vrf vrf-name] server-address1
// [server-address2...server-address6]`, with the sentence "To remove the addresses specified, use the no form of
// this command"
// (https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-i3.html). A switch
// guide says it in the singular - "To remove a name server address, use the `no ip name-server`
// server-address global configuration command" (Catalyst 3750-X/3560-X Software Configuration Guide,
// 15.0(2)SE, Administering the Switch) - and an Oracle Exadata procedure on a Cisco 4948 removes three
// configured servers with three separate one-address lines, noting "Each current DNS IP address to be changed
// needs to be erased"
// (https://docs.oracle.com/en/engineered-systems/exadata-database-machine/dbmmn/change-dns-server-address-cisco-4948-ethernet-switch.html).
//
// This console read none of the words: the branch cleared `config.dnsServers` and printed `Name servers
// cleared`, so `no ip name-server 8.8.8.8` silently removed 1.1.1.1 too, and a word that was not an address
// did the same. docs/CLI.md recorded the hole ("A per-address removal is the fix, and until it lands this page
// records what the console does") and the help index already promised "removes a name server".
//
// What is *not* asserted against a transcript: the sentence a live IOS prints for an address that is not on
// the list, and whether a bare `no ip name-server` is accepted on IOS proper. Both refusals below are this
// console's own words; research/no-ip-name-server-removal.md says so and names what would settle each.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = catalog.find(function (x) { return x.model === 'ISR 4331'; }) ||
  catalog.find(function (x) { return /ISR|ASR/.test(x.model); });

function lab() {
  const t = new Topology();
  const d = t.addDevice(spec, 'r1');
  d.config.dnsServers = [];
  return { t: t, d: d };
}
function configure(env, cmds) {
  const session = new CliSession(env.d, env.t, null);
  const out = [];
  for (const c of ['enable', 'configure terminal'].concat(cmds).concat(['end'])) {
    out.push.apply(out, session.run(c).output.map(String)
      .filter(function (l) { return !/^Enter configuration commands, one per line\./.test(l); }));
  }
  return out;
}
function servers(env) { return (env.d.config.dnsServers || []).slice(); }
function show(env, cmd) {
  const s = new Simulator(env.t);
  s.setRunTime(60000);
  return runCommands(env.d, env.t, s, ['enable', cmd]).lines.map(String).join('\n');
}
function refusals(lines) { return lines.filter(function (l) { return /^%/.test(l); }); }

console.log('The address named is the address removed');
{
  const env = lab();
  configure(env, ['ip name-server 1.1.1.1 8.8.8.8 9.9.9.9']);
  const out = configure(env, ['no ip name-server 8.8.8.8']);
  ok(refusals(out).length === 0, 'a configured address is removed without a refusal', JSON.stringify(out));
  ok(JSON.stringify(servers(env)) === JSON.stringify(['1.1.1.1', '9.9.9.9']),
    'and the two servers it did not name are still there, in order', JSON.stringify(servers(env)));
  ok(out.length === 1 && out[0] === 'Name server 8.8.8.8 removed',
    'the receipt names the address that was removed', JSON.stringify(out));
}

console.log('');
console.log('Removing the primary promotes the next server');
{
  const env = lab();
  configure(env, ['ip name-server 1.1.1.1 8.8.8.8']);
  configure(env, ['no ip name-server 1.1.1.1']);
  const line = show(env, 'show ip dns').split('\n')
    .filter(function (l) { return /^Name servers this device asks:/.test(l); })[0] || '';
  ok(line === 'Name servers this device asks: 8.8.8.8',
    'the surviving server is now the one the box asks first', line);
}
console.log('');
console.log('Naming an address that is not on the list changes nothing');
{
  const env = lab();
  configure(env, ['ip name-server 1.1.1.1 8.8.8.8']);
  const out = configure(env, ['no ip name-server 8.8.8.8']);
  const again = configure(env, ['no ip name-server 8.8.8.8']);
  ok(refusals(again).length === 1, 'a second removal of the same address is refused', JSON.stringify(again));
  ok(/^% Not a name server: 8\.8\.8\.8 - nothing was removed$/.test(refusals(again)[0]),
    'the refusal names the address and says nothing was removed', refusals(again)[0]);
  ok(JSON.stringify(servers(env)) === JSON.stringify(['1.1.1.1']),
    'and the remaining server is untouched', JSON.stringify(servers(env)));
  ok(refusals(out).length === 0 && out[0] === 'Name server 8.8.8.8 removed',
    'the first removal did happen', JSON.stringify(out));
}

console.log('');
console.log('A line is applied whole or not at all');
{
  const env = lab();
  configure(env, ['ip name-server 1.1.1.1 8.8.8.8']);
  const out = configure(env, ['no ip name-server 4.4.4.4 1.1.1.1']);
  ok(refusals(out).length === 1, 'one unknown address refuses the whole line', JSON.stringify(out));
  ok(/4\.4\.4\.4/.test(refusals(out)[0]) && /nothing was removed/.test(refusals(out)[0]),
    'the refusal names the address it could not find', refusals(out)[0]);
  ok(JSON.stringify(servers(env)) === JSON.stringify(['1.1.1.1', '8.8.8.8']),
    'the configured address on that line was not removed either', JSON.stringify(servers(env)));
}
console.log('');
console.log('A word that is not an address is a parse error, not a wipe');
{
  const env = lab();
  configure(env, ['ip name-server 1.1.1.1']);
  const out = configure(env, ['no ip name-server flurbish']);
  ok(refusals(out).length === 1 && /^% Invalid name server "flurbish"/.test(refusals(out)[0]),
    'the positive form\'s sentence is used for the bad word', JSON.stringify(out));
  ok(JSON.stringify(servers(env)) === JSON.stringify(['1.1.1.1']),
    'and the list is not touched', JSON.stringify(servers(env)));
}

console.log('');
console.log('Several addresses on one line remove several servers');
{
  const env = lab();
  configure(env, ['ip name-server 1.1.1.1 8.8.8.8 9.9.9.9']);
  const out = configure(env, ['no ip name-server 1.1.1.1 9.9.9.9 9.9.9.9']);
  ok(refusals(out).length === 0, 'two addresses, one of them repeated, are accepted', JSON.stringify(out));
  ok(out.filter(function (l) { return / removed$/.test(l); }).length === 2,
    'and a repeated address gets one receipt, not two', JSON.stringify(out));
  ok(JSON.stringify(servers(env)) === JSON.stringify(['8.8.8.8']),
    'the server nobody named survives', JSON.stringify(servers(env)));
}

console.log('');
console.log('Emptying the list is still possible, and says so honestly');
{
  const env = lab();
  configure(env, ['ip name-server 1.1.1.1 8.8.8.8']);
  const out = configure(env, ['no ip name-server']);
  ok(out.length === 1 && out[0] === 'Name servers cleared', 'the bare form still clears the list',
    JSON.stringify(out));
  ok(servers(env).length === 0, 'and the list is empty', JSON.stringify(servers(env)));

  const none = configure(lab(), ['no ip name-server']);
  ok(refusals(none).length === 1 && /^% No name servers configured/.test(refusals(none)[0]),
    'on a box with no servers, the bare form no longer claims to have cleared something', JSON.stringify(none));
  ok(/ip name-server <address>/.test(refusals(none)[0]), 'and the refusal names the command that adds one',
    refusals(none)[0]);
}
console.log('');
console.log('A backup carries exactly the servers that are left');
{
  const env = lab();
  configure(env, ['ip name-server 1.1.1.1 8.8.8.8 9.9.9.9', 'no ip name-server 8.8.8.8']);
  const lines = show(env, 'show running-config').split('\n')
    .filter(function (l) { return /^ip name-server /.test(l); });
  ok(lines.join(' ') === 'ip name-server 1.1.1.1 ip name-server 9.9.9.9',
    'the removed server is gone and the rest are printed in order', JSON.stringify(lines));

  configure(env, ['no ip name-server 1.1.1.1', 'no ip name-server 9.9.9.9']);
  const none = show(env, 'show running-config').split('\n')
    .filter(function (l) { return /^ip name-server /.test(l); });
  ok(none.length === 0, 'removing the last server leaves no line at all', JSON.stringify(none));
}

console.log('');
console.log('Add, remove, add again round-trips');
{
  const env = lab();
  const before = show(env, 'show running-config');
  configure(env, ['ip name-server 10.0.0.9']);
  configure(env, ['no ip name-server 10.0.0.9']);
  const after = show(env, 'show running-config');
  ok(after === before, 'a server added and removed leaves the printed config byte for byte as it was',
    JSON.stringify({ before: before, after: after }));
  const readd = configure(env, ['ip name-server 10.0.0.9']);
  ok(refusals(readd).length === 0 && JSON.stringify(servers(env)) === JSON.stringify(['10.0.0.9']),
    'and the address can be configured again afterwards', JSON.stringify(readd));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
