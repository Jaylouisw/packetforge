'use strict';
// `no` reads only the tokens it needs and ignores the rest, so a `?` typed at the end of a `no` line where the
// operator expected help was read as one more token to ignore, and the line acted (#1694):
//
//   no hostname ?           cleared the hostname
//   no vlan 42 name ?       removed VLAN 42, with a receipt that read like success
//   no description ?        cleared the port's description
//
// #1685 and #1691 refused the key where the console would *store* it as a name (the key came alone in a value
// position). Here the key comes last and the damage is done by the words before it - `no vlan 42` is a complete,
// destructive line on its own - so a check in the value position cannot help. The refusal runs before any `no`
// branch acts, and is written in the words of the branch it stopped, so it answers the question the operator was
// asking. A `?` inside a longer word (`no vlan 42 name lab?1`) is not the key and is left alone.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const cli = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = function (m) { return catalog.find(function (x) { return x.model === m; }); };

function env(model) {
  const t = new Topology();
  const dev = t.addDevice(spec(model || 'ISR 4331'), 'd1');
  const sim = new Simulator(t);
  const s = new cli.CliSession(dev, t, sim);
  const say = function (cmd) {
    const res = s.run(cmd) || {};
    const lines = res.output || [];
    return lines.length ? lines[lines.length - 1] : '';
  };
  s.run('enable');
  return { t: t, dev: dev, s: s, sim: sim, say: say, run: function (c) { return s.run(c) || {}; } };
}

function config(e) {
  return ((e.run('show running-config').output) || []).join('\n');
}

// Every refusal says the same four things: it is a refusal, it names the key, it names the branch's syntax, and
// it says nothing happened - the last of which is what a `no` line otherwise never says, because it acts.
function refusalShape(said, syntax, changedWord, label) {
  ok(/^\s*%/.test(said), label + ': the answer is a refusal, not a receipt', said);
  ok(/help key/.test(said), label + ': it names the key for what it is', said);
  ok(new RegExp(syntax).test(said), label + ': and the syntax of the branch it stopped (' + syntax + ')', said);
  ok(new RegExp('nothing was ' + changedWord).test(said), label + ': and says nothing was ' + changedWord, said);
}

section('1. `no vlan 42 name ?` removes nothing - the VLAN is still there');
{
  const e = env('Catalyst2960');
  e.say('configure terminal');
  e.say('vlan 42 name lab');
  const said = e.say('no vlan 42 name ?');
  refusalShape(said, 'no vlan <id>', 'removed', 'no vlan 42 name ?');
  ok(!/VLAN 42 removed/.test(said), 'the answer is not the receipt a real removal gives', said);
  ok(/^\s*42\s+lab/m.test(((e.run('show vlan').output) || []).join('\n')), '`show vlan` still lists VLAN 42 as lab');
  ok(/^\s*vlan 42 lab$/m.test(config(e)), 'and the running-config still carries it',
    config(e).split('\n').filter(function (l) { return /vlan/.test(l); }).join(' | '));
  const good = e.say('no vlan 42');
  ok(/VLAN 42 removed/.test(good), 'a real `no vlan 42` still removes it', good);
  ok(!/^\s*42\s/m.test(((e.run('show vlan').output) || []).join('\n')), 'and the table no longer lists it');
}

section('2. `no hostname ?` clears nothing - the name survives');
{
  const e = env('ISR 4331');
  e.say('configure terminal');
  e.say('hostname lab-1');
  const said = e.say('no hostname ?');
  refusalShape(said, 'no hostname', 'cleared', 'no hostname ?');
  ok(!/Hostname cleared/.test(said), 'the answer is not "Hostname cleared"', said);
  ok(e.dev.name === 'lab-1', 'the box still answers to lab-1', e.dev.name);
  ok(e.dev.config.hostname === 'lab-1', 'and its config still holds the hostname', String(e.dev.config.hostname));
  ok(/^\s*hostname lab-1$/m.test(config(e)), 'and the running-config still prints it');
  const good = e.say('no hostname');
  ok(/Hostname cleared/.test(good), 'a real `no hostname` still clears it', good);
  ok(e.dev.config.hostname === null, 'and the config no longer holds one', String(e.dev.config.hostname));
}

section('3. `no description ?` clears nothing - the port keeps its description');
{
  const e = env('Catalyst2960');
  e.say('configure terminal');
  e.say('interface Fa0/1');
  e.say('description uplink to core');
  const said = e.say('no description ?');
  refusalShape(said, 'no description', 'cleared', 'no description ?');
  ok(!/Description removed/.test(said), 'the answer is not "Description removed: uplink to core"', said);
  const iface = function () { return Array.from(e.dev.interfaces.values())[0]; };
  ok(iface().description === 'uplink to core', 'the port still carries the description it had', String(iface().description));
  ok(/^\s*description uplink to core$/m.test(config(e)), 'and the running-config still prints it');
  const good = e.say('no description');
  ok(/Description removed: uplink to core/.test(good), 'a real `no description` still clears it, and says what it removed', good);
  ok(iface().description === '', 'and the port is left with none', String(iface().description));
}

section('4. the other `no` heads that ignore trailing tokens: a key there changes nothing either');
{
  const e = env('Catalyst2960');
  e.say('configure terminal');
  e.say('spanning-tree priority 4096');
  e.say('access-list 10 permit any');
  refusalShape(e.say('no spanning-tree ?'), 'no spanning-tree', 'cleared', 'no spanning-tree ?');
  ok(e.dev.config.stpPriority === 4096, 'the bridge priority is still set', String(e.dev.config.stpPriority));
  refusalShape(e.say('no access-list 10 ?'), 'no access-list <number>', 'removed', 'no access-list 10 ?');
  ok(e.dev.config.acls && e.dev.config.acls['10'], 'access list 10 still exists',
    JSON.stringify(Object.keys(e.dev.config.acls || {})));
  ok(/access-list 10 permit any/.test(config(e)), 'and is still in the running-config');

  const r = env('ISR 4331');
  r.say('configure terminal');
  r.say('ip route 10.9.0.0 255.255.0.0 10.0.0.2');
  r.say('ip nat pool p1 1.1.1.1 1.1.1.2 netmask 255.255.255.0');
  refusalShape(r.say('no ip route 10.9.0.0 255.255.0.0 10.0.0.2 ?'),
    'no ip route <prefix> <mask> <gateway>', 'removed', 'no ip route ... ?');
  ok(/^\s*ip route 10\.9\.0\.0 255\.255\.0\.0 10\.0\.0\.2$/m.test(config(r)), 'the static route is still there',
    config(r).split('\n').filter(function (l) { return /ip route/.test(l); }).join(' | '));
  refusalShape(r.say('no ip nat pool p1 ?'), 'no ip nat pool <name>', 'removed', 'no ip nat pool p1 ?');
  ok(r.dev.config.nat && r.dev.config.nat.pools && r.dev.config.nat.pools.p1, 'NAT pool p1 still exists',
    JSON.stringify(Object.keys((r.dev.config.nat || {}).pools || {})));

  const p = env('ISR 4331');
  p.say('configure terminal');
  p.say('interface Gi0/0/0');
  p.say('ip address 10.0.0.1 255.255.255.0');
  p.say('shutdown');
  refusalShape(p.say('no ip address ?'), 'no ip address', 'cleared', 'no ip address ?');
  const port = function () { return p.dev.interfaces.get('Gi0/0/0') || Array.from(p.dev.interfaces.values())[0]; };
  ok(port().ip === '10.0.0.1', 'the address is still on the port', String(port().ip));
  refusalShape(p.say('no shutdown ?'), 'no shutdown', 'changed', 'no shutdown ?');
  ok(port().enabled === false, 'and the port is still shut down', String(port().enabled));
}

section('5. in DHCP pool mode, `no network ?` and `no pool ?` remove nothing');
{
  const e = env('ISR 4331');
  e.say('configure terminal');
  e.say('ip dhcp pool p1');
  e.say('network 10.1.1.0 255.255.255.0');
  e.say('range 10.1.1.10 10.1.1.50');
  refusalShape(e.say('no network ?'), 'no network', 'cleared', 'no network ?');
  const pool = function () {
    return (e.dev.config.dhcpPools || []).find(function (x) { return x.name === 'p1'; });
  };
  ok(pool() && pool().network === '10.1.1.0', 'the pool still has its network', JSON.stringify(pool() && pool().network));
  refusalShape(e.say('no pool ?'), 'no pool', 'removed', 'no pool ?');
  ok(pool(), 'the pool still exists', JSON.stringify((e.dev.config.dhcpPools || []).map(function (x) { return x.name; })));
  ok(e.s.mode === 'dhcp-pool', 'and the session is still inside it, so the next line lands in the same pool', e.s.mode);
}

section('6. only a whole token is the key: `no vlan 42 name lab?1` is not a keypress');
{
  const e = env('Catalyst2960');
  e.say('configure terminal');
  e.say('vlan 42 name lab');
  const said = e.say('no vlan 42 name lab?1');
  ok(!/help key/.test(said), 'the line is not refused as a keypress', said);
  ok(/VLAN 42 removed/.test(said), 'it runs the branch it names, as before', said);
  ok(!/^\s*42\s/m.test(((e.run('show vlan').output) || []).join('\n')),
    'and the VLAN is gone, because that is what `no vlan 42` says');
}

section('7. a bare `no ?` is the one line where the key is a question, and it changes nothing');
{
  const e = env('Catalyst2960');
  e.say('configure terminal');
  e.say('vlan 42 name lab');
  const said = e.say('no ?');
  ok(/^\s*%/.test(said) && /Incomplete command/.test(said), 'it is answered as a short line, not as a command', said);
  ok(/type `\?` on its own/.test(said), 'and points at the key that does answer the question', said);
  ok(/^\s*42\s/m.test(((e.run('show vlan').output) || []).join('\n')), 'VLAN 42 is still there');
  const f = env('Catalyst2960');
  f.say('configure terminal');
  f.say('interface Fa0/1');
  f.say('description lab');
  const inIface = f.say('no ?');
  ok(/^\s*%/.test(inIface), 'and interface mode answers the same way', inIface);
  ok(Array.from(f.dev.interfaces.values())[0].description === 'lab', 'with the description still in place');
}

section('8. an unrecognised `no` head with a trailing key still changes nothing');
{
  const e = env('Catalyst2960');
  e.say('configure terminal');
  const said = e.say('no flurbish ?');
  ok(/^\s*%/.test(said), 'the answer is a refusal', said);
  ok(/help key/.test(said), 'it names the key', said);
  ok(/nothing was changed/.test(said), 'and says nothing was changed', said);
}

console.log('\n' + (failed ? 'FAILED' : 'OK') + ' \u2014 ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
