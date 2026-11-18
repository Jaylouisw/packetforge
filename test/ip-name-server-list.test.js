'use strict';
// One `ip name-server` line carries up to six addresses, and the order typed is the order asked.
//
// The vendor syntax is `ip name-server server-address1 [server-address2 ... server-address6]`, and the DNS
// configuration guide says it in words - "Specifies one or more hosts (up to six) that can function as a name
// server", with the worked example `Device(config)# ip name-server 172.16.1.111 172.16.1.2`
// (https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/ip-addressing/b-ip-addressing/m_configuring_dns.html,
// and the parameter table's "a maximum of six name servers" in
// https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-i3.html). An
// access-point configuration guide states the ordering rule: "You can specify up to six name servers. Separate
// each server address with a space. The first server specified is the primary server."
// (https://www.cisco.com/c/en/us/td/docs/wireless/access_point/15-3-3-JB/configuration/guide/cg_book.pdf)
//
// This console read `tokens[2]` and nothing else, so the documented two-address form stored the first address,
// answered "Name server 172.16.1.111", and threw the second away silently - a configuration line that lost
// half of itself without a word, the defect class of #2004. The list already existed in the model
// (`config.dnsServers`, walked in order by `_domainServersFor()`), so nothing here is a new feature: it is the
// documented shape of an existing command.
//
// What is *not* asserted, because no transcript in hand settles it: the sentence a live IOS prints when a line
// names a seventh server, and whether a second `ip name-server` line appends to or replaces the list. See
// research/ip-name-server-list.md. The refusals below are this console's own words, not quoted vendor text.
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
// Only what the console answered, with the echoed command line left out: `runCommands` prefixes each
// command with the prompt it was typed at, and this device's prompt carries the model and the device name.
function configure(env, cmds) {
  const session = new CliSession(env.d, env.t, null);
  const out = [];
  for (const c of ['enable', 'configure terminal'].concat(cmds).concat(['end'])) {
    out.push.apply(out, session.run(c).output.map(String));
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

console.log('A line with several addresses configures all of them, in the order typed');
{
  const env = lab();
  const out = configure(env, ['ip name-server 172.16.1.111 172.16.1.2']);
  ok(refusals(out).length === 0, 'the documented two-address line is accepted', JSON.stringify(out));
  ok(JSON.stringify(servers(env)) === JSON.stringify(['172.16.1.111', '172.16.1.2']),
    'both addresses are stored, primary first', JSON.stringify(servers(env)));
  ok(out.filter(function (l) { return /^Name server /.test(l); }).length === 2,
    'and each address gets its own receipt', JSON.stringify(out));
  ok(out[0] === 'Name server 172.16.1.111' && out[1] === 'Name server 172.16.1.2',
    'the receipts are in typed order', JSON.stringify(out));
}

console.log('');
console.log('The order survives into what the box does with the list');
{
  const env = lab();
  configure(env, ['ip name-server 10.9.9.9 8.8.8.8 1.1.1.1']);
  const text = show(env, 'show ip dns');
  const line = text.split('\n').filter(function (l) { return /^Name servers this device asks:/.test(l); })[0] || '';
  ok(line === 'Name servers this device asks: 10.9.9.9, 8.8.8.8, 1.1.1.1',
    '`show ip dns` names the servers in the order they will be asked', line);
}

console.log('');
console.log('A line is parsed whole before it is applied');
{
  const env = lab();
  const out = configure(env, ['ip name-server 10.0.0.9 flurbish']);
  ok(refusals(out).length === 1, 'one bad word refuses the line', JSON.stringify(out));
  ok(/^% Invalid name server "flurbish"/.test(refusals(out)[0]), 'and the refusal names the word',
    refusals(out)[0]);
  ok(servers(env).length === 0, 'the good address on that line is not stored either',
    JSON.stringify(servers(env)));
}

console.log('');
console.log('Six addresses fit on a line, seven do not');
{
  const env = lab();
  const six = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5', '10.0.0.6'];
  const out = configure(env, ['ip name-server ' + six.join(' ')]);
  ok(refusals(out).length === 0, 'six addresses are accepted', JSON.stringify(out));
  ok(servers(env).length === 6, 'all six are stored', JSON.stringify(servers(env)));

  const over = configure(lab(), ['ip name-server ' + six.concat(['10.0.0.7']).join(' ')]);
  ok(refusals(over).length === 1, 'a seventh address on one line is refused', JSON.stringify(over));
  ok(/at most six addresses on one line/.test(refusals(over)[0]) &&
    /nothing was configured/.test(refusals(over)[0]),
    'the refusal names the limit and says nothing was changed', refusals(over)[0]);
}

console.log('');
console.log('The limit is the whole list, not just one line');
{
  const env = lab();
  configure(env, ['ip name-server 10.0.0.1 10.0.0.2 10.0.0.3', 'ip name-server 10.0.0.4 10.0.0.5 10.0.0.6']);
  ok(servers(env).length === 6, 'two lines of three fill the list', JSON.stringify(servers(env)));

  const over = configure(env, ['ip name-server 10.0.0.7']);
  ok(refusals(over).length === 1, 'a seventh server across lines is refused', JSON.stringify(over));
  ok(/already has 6 name servers/.test(refusals(over)[0]), 'the refusal says how many are already there',
    refusals(over)[0]);
  ok(servers(env).length === 6 && servers(env)[5] === '10.0.0.6',
    'and the list is untouched', JSON.stringify(servers(env)));

  const again = configure(env, ['ip name-server 10.0.0.1']);
  ok(refusals(again).length === 0, 'retyping an address already in the list is accepted',
    JSON.stringify(again));
  ok(servers(env).length === 6, 'and changes nothing', JSON.stringify(servers(env)));
}

console.log('');
console.log('A single address behaves exactly as it did');
{
  const env = lab();
  const out = configure(env, ['ip name-server 10.0.0.9']);
  ok(out.length === 1 && out[0] === 'Name server 10.0.0.9', 'one address, one receipt', JSON.stringify(out));

  const bare = configure(lab(), ['ip name-server']);
  ok(/^% Incomplete command: ip name-server <address>/.test(refusals(bare)[0]),
    'a bare `ip name-server` is still incomplete, not invalid', refusals(bare)[0]);

  const bad = configure(lab(), ['ip name-server 300.1.1.1']);
  ok(/^% Invalid name server "300\.1\.1\.1"/.test(refusals(bad)[0]), 'an out-of-range address is still refused',
    refusals(bad)[0]);
}

console.log('');
console.log('A backup carries every server on the list');
{
  const env = lab();
  configure(env, ['ip name-server 172.16.1.111 172.16.1.2 10.9.9.9']);
  const text = show(env, 'show running-config');
  const lines = text.split('\n').filter(function (l) { return /^ip name-server /.test(l); });
  ok(lines.length === 3, 'one line per address, as this console has always printed them',
    JSON.stringify(lines));
  ok(lines.join(' ') === 'ip name-server 172.16.1.111 ip name-server 172.16.1.2 ip name-server 10.9.9.9',
    'in the order the box will ask them', JSON.stringify(lines));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
