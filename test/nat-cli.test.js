'use strict';
// NAT, from the console to the wire (#1366).
//
// engine/nat.js is a full model - static, dynamic and PAT, with a live translation table and ageing - and the
// flow path calls it, translating on the way out and back in and emitting `nat-drop` when a rule cannot
// translate. Nothing in the product ever wrote `config.nat`, so `Simulator._isNat()` was always false: a lab
// could not configure NAT at all, and the mechanism was unreachable from every surface.
//
// This file checks the reachability rather than re-testing the library: the commands, their refusals, the
// translations a real flow produces, the reports, and the save.
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const cliModule = require('../engine/cli');
const natLib = require('../engine/nat');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = require('path').join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /ISR 4331/.test(s.model); });
const HOST = specs.find(function (s) { return /Raspberry Pi 5/.test(s.model); });

// inside host ---- r1 (NAT) ---- outside host
function lab() {
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  t.addDevice(HOST, 'in1');
  t.addDevice(HOST, 'out1');
  const c = function (a, ap, b, bp) { t.connect(a, ap, b, bp, { mediaId: '1000base-t', speedMbps: 1000 }); };
  c('r1', 'Gi0/0/0', 'in1', 'eth0');     // 192.168.10.1/24, inside
  c('r1', 'Gi0/0/1', 'out1', 'eth0');    // 203.0.113.1/24, outside
  const r1 = t.getDevice('r1');
  r1.interfaces.get('Gi0/0/0').ip = '192.168.10.1'; r1.interfaces.get('Gi0/0/0').mask = '255.255.255.0';
  r1.interfaces.get('Gi0/0/1').ip = '203.0.113.1'; r1.interfaces.get('Gi0/0/1').mask = '255.255.255.0';
  const in1 = t.getDevice('in1');
  in1.interfaces.get('eth0').ip = '192.168.10.50'; in1.interfaces.get('eth0').mask = '255.255.255.0';
  in1.config.defaultGateway = '192.168.10.1';
  const out1 = t.getDevice('out1');
  out1.interfaces.get('eth0').ip = '203.0.113.9'; out1.interfaces.get('eth0').mask = '255.255.255.0';
  out1.config.defaultGateway = '203.0.113.1';
  return { t: t, sim: new Simulator(t) };
}
function run(env, devId, cmds) {
  const s = new CliSession(env.t.getDevice(devId), env.t, env.sim);
  const out = [];
  for (const c of cmds) out.push(((s.run(c) || {}).output || []).join('\n'));
  return out.join('\n');
}
function configured(env, cmds) {
  return run(env, 'r1', ['enable', 'configure terminal'].concat(cmds));
}

console.log('');
console.log('The commands the model needs, and their refusals:');
{
  const env = lab();
  const added = configured(env, ['ip nat pool WAN 203.0.113.1 203.0.113.1 netmask 255.255.255.0',
    'ip nat inside source list 192.168.10.0/24 pool WAN overload']);
  ok(/NAT pool "WAN" 203\.0\.113\.1 - 203\.0\.113\.1/.test(added), 'a pool is created and named back to the operator', added.split('\n')[0]);
  ok(/ip nat inside source list 192\.168\.10\.0\/24 pool WAN overload/.test(added),
    'and the PAT rule prints in the spelling that would create it again');
  const rules = env.t.getDevice('r1').config.nat.rules;
  ok(rules.length === 1 && rules[0].type === 'pat', 'one PAT rule is stored', JSON.stringify(rules[0] && rules[0].type));

  const dup = configured(env, ['ip nat pool WAN 203.0.113.5 203.0.113.6 netmask 255.255.255.0']);
  ok(/already exists/.test(dup), 'a second pool with the same name is refused', dup.slice(0, 90));

  const backwards = configured(env, ['ip nat pool BAD 203.0.113.9 203.0.113.1 netmask 255.255.255.0']);
  ok(/ends before it starts/.test(backwards), 'a pool that runs backwards is refused', backwards.slice(0, 70));

  const acl = configured(env, ['ip nat inside source list 10 interface Gi0/0/1 overload']);
  ok(/ACL number/.test(acl) && /takes the inside local addresses/.test(acl),
    'an ACL number is refused with what this model wants instead', acl.slice(0, 110));

  const multi = configured(env, ['ip nat pool TWO 203.0.113.1 203.0.113.2 netmask 255.255.255.0',
    'ip nat inside source list 192.168.10.0/24 pool TWO overload']);
  ok(/PAT overloads one address/.test(multi), 'overload on a multi-address pool is refused, naming why', multi.slice(0, 120));

  const noIface = configured(env, ['ip nat inside source list any interface Gi0/0/9 overload']);
  ok(/Interface not found/.test(noIface), 'a rule against a port that does not exist is refused', noIface.slice(0, 60));

  const badStatic = configured(env, ['ip nat inside source static 192.168.10.50 not-an-ip']);
  ok(/Usage: ip nat inside source static/.test(badStatic), 'a static rule with a bad address gets the usage line');
  const badProto = configured(env, ['ip nat inside source static 192.168.10.50 203.0.113.5 icmp 8']);
  ok(/needs tcp or udp/.test(badProto), 'a static rule with a protocol that cannot carry a port is refused', badProto.slice(0, 90));

  ok(env.t.getDevice('r1').config.nat.rules.length === 1, 'none of the refusals stored a rule');
}

console.log('');
console.log('A packet that needs translating gets translated:');
{
  const env = lab();
  configured(env, ['ip nat pool WAN 203.0.113.1 203.0.113.1 netmask 255.255.255.0',
    'ip nat inside source list 192.168.10.0/24 pool WAN overload']);
  const ping = run(env, 'in1', ['enable', 'ping 203.0.113.9']);
  ok(/success|reply|Received/i.test(ping), 'the inside host reaches the outside host', ping.split('\n').slice(-2).join(' / '));
  const table = env.t.getDevice('r1').natTable;
  ok(!!table && table.translations.length > 0, 'and the router holds a live translation',
    table ? String(table.translations.length) : 'no table');
  const tr = table && table.translations[0];
  ok(tr && tr.insideLocal === '192.168.10.50', 'the inside local is the host', tr && tr.insideLocal);
  ok(tr && tr.insideGlobal === '203.0.113.1', 'translated to the pool address', tr && tr.insideGlobal);

  const shown = run(env, 'r1', ['enable', 'show ip nat translations']);
  ok(/Inside global|Pro/.test(shown), 'show ip nat translations prints the table', shown.split('\n')[0]);
  ok(shown.indexOf('192.168.10.50') !== -1, 'with the host in it', shown.slice(0, 120));
  ok(shown.indexOf('203.0.113.1') !== -1, 'and the address it was translated to');

  const stats = run(env, 'r1', ['enable', 'show ip nat statistics']);
  ok(/Inside source rules: 1/.test(stats), 'statistics counts the rules', stats.split('\n')[0]);
  ok(/0 static, 0 dynamic, 1 PAT overload/.test(stats), 'by type', stats.split('\n')[0]);
  ok(/Active translations: [1-9]/.test(stats), 'and the live translations', stats.split('\n')[1]);
}

console.log('');
console.log('Without a rule, nothing is translated:');
{
  const env = lab();
  const ping = run(env, 'in1', ['enable', 'ping 203.0.113.9']);
  ok(/success|reply|Received/i.test(ping), 'the ping still works when there is no NAT to apply',
    ping.split('\n').slice(-1).join(''));
  ok(!env.t.getDevice('r1').natTable, 'and no translation table was even created');

  const shown = run(env, 'r1', ['enable', 'show ip nat translations']);
  ok(/No translations/.test(shown) && /no packet needing NAT has crossed/.test(shown),
    'the report says nothing needed translating, rather than showing an empty table', shown.slice(0, 110));
  const noRules = run(env, 'r1', ['enable', 'show ip nat rules']);
  ok(/% No NAT rules configured/.test(noRules), 'and that there are no rules either');
}

console.log('');
console.log('Static port forwarding:');
{
  const env = lab();
  const added = configured(env, ['ip nat inside source static 192.168.10.50 203.0.113.1 tcp 8080']);
  ok(/static 192\.168\.10\.50 203\.0\.113\.1 tcp 8080/.test(added), 'the rule is stored and printed', added.split('\n')[0]);
  const rule = env.t.getDevice('r1').config.nat.rules[0];
  ok(rule.type === 'static' && rule.protocol === 'tcp' && rule.port === 8080,
    'as a static tcp rule on port 8080', JSON.stringify({ t: rule.type, p: rule.protocol, port: rule.port }));
  ok(/ip nat inside source static 192\.168\.10\.50 203\.0\.113\.1 tcp 8080/.test(
    run(env, 'r1', ['enable', 'show running-config'])), 'show running-config prints it');
}

console.log('');
console.log('The configuration survives a save:');
{
  const env = lab();
  configured(env, ['ip nat pool WAN 203.0.113.1 203.0.113.1 netmask 255.255.255.0',
    'ip nat inside source list 192.168.10.0/24 pool WAN overload',
    'ip nat inside source static 192.168.10.60 203.0.113.1 tcp 443']);
  run(env, 'in1', ['enable', 'ping 203.0.113.9']);
  const doc = JSON.parse(JSON.stringify(env.t.serialize()));
  const back = Topology.fromJSON(doc, specs);
  const nat = back.getDevice('r1').config.nat;
  ok(nat.rules.length === 2, 'both rules come back', String(nat.rules.length));
  ok(nat.pools.WAN && nat.pools.WAN.start === '203.0.113.1', 'and the pool they name', JSON.stringify(nat.pools.WAN));
  const sim2 = new Simulator(back);
  ok(sim2._isNat(back.getDevice('r1')) === true, 'the reloaded device is a NAT device', String(sim2._isNat(back.getDevice('r1'))));

  // A device with no NAT must not grow a config block on the way through.
  const clean = lab();
  const doc2 = JSON.parse(JSON.stringify(clean.t.serialize()));
  const r1doc = doc2.devices.filter(function (d) { return d.id === 'r1'; })[0];
  ok(!('nat' in r1doc.config), 'a router with no NAT writes no nat block', JSON.stringify(r1doc.config.nat));
}

console.log('');
console.log('Removing things says what it removed:');
{
  const env = lab();
  configured(env, ['ip nat pool WAN 203.0.113.1 203.0.113.1 netmask 255.255.255.0',
    'ip nat inside source list 192.168.10.0/24 pool WAN overload']);
  const inUse = configured(env, ['no ip nat pool WAN']);
  ok(/still used by 1 rule/.test(inUse), 'a pool a rule still uses cannot be removed', inUse.slice(0, 90));
  const removed = configured(env, ['no ip nat inside source']);
  ok(/NAT rule removed: ip nat inside source list/.test(removed), 'removing the rule names the rule', removed.slice(0, 100));
  ok(env.t.getDevice('r1').config.nat.rules.length === 0, 'and it is gone');
  const poolGone = configured(env, ['no ip nat pool WAN']);
  ok(/NAT pool "WAN" removed/.test(poolGone), 'the pool can now be removed', poolGone.slice(0, 60));
  ok(/No NAT pool called "WAN"/.test(configured(env, ['no ip nat pool WAN'])), 'and removing it twice refuses');

  const none = configured(env, ['no ip nat inside source']);
  ok(/No NAT rules configured/.test(none), 'removing a rule that does not exist refuses too', none.slice(0, 60));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
