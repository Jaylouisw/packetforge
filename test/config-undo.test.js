'use strict';
// Anything `show running-config` prints must be removable from the console, and removing something that is
// not there must say so (#1277).
//
// Four features were one-way doors: the console accepted them, the printer printed them, and no `no` form
// existed - so a backup could be read and could not be edited back:
//
//   hostname <name>            no hostname            -> "% Unrecognized config command"
//   ip dhcp pool <name>        no ip dhcp pool <n>    -> parsed as a pool body line, refused as a bad range
//   dns zone <name>            no dns zone <name>     -> "% Unrecognized config command"
//   ip access-group <n> in     no ip access-group     -> "% Unrecognized interface command"
//
// `no vlan <id>` was worse than missing: it printed "VLAN 42 removed" whether or not a VLAN 42 existed, and
// would remove one that ports still carried, after which `show running-config` stopped printing `vlan 42`
// while `show vlan` still listed it from the member ports - two descriptions of one switch that disagreed.
//
// The load-bearing assertion here is not "the message looks right": it is that undoing a command returns
// `show running-config` **byte for byte** to what it was before the command was typed. A config you can edit
// back is the whole point of a backup.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

function ethernets(dev) {
  return [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
}

function fresh(spec) {
  const t = new Topology();
  const d = t.addDevice(spec || ROUTER, 'r1');
  const sim = new Simulator(t);
  return { t: t, d: d, sim: sim, p: ethernets(d)[0].name };
}

function config(env) {
  return (((new CliSession(env.d, env.t, env.sim).run('show running-config').output) || [])
    .map(String)).join('\n');
}

function messages(out) {
  return ((out && out.lines) || []).map(String)
    .filter(function (l) { return /%/.test(l) && !/config|#/.test(l.split('%')[0]); })
    .map(function (l) { return l.slice(l.indexOf('%')).trim(); });
}

// Apply a list of commands (with %P% standing for the first ethernet port) and return the console's output.
function apply(env, cmds) {
  return runCommands(env.d, env.t, env.sim, cmds.map(function (c) {
    return c.replace('%P%', env.p);
  }));
}

// The whole point: add it, see it printed, take it away, get the same config back.
function roundTrip(name, positive, negative, printed) {
  const env = fresh(name.indexOf('switchport') === 0 ? SWITCH : ROUTER);
  const base = config(env);
  apply(env, positive);
  const mid = config(env);
  ok(mid !== base, name + ': the command changes the config');
  ok(printed.test(mid), name + ': and the printer prints it', mid.split('\n').filter(function (l) {
    return printed.test(l);
  }).join(' | '));

  const out = apply(env, negative);
  const msgs = messages(out);
  ok(msgs.length === 0, name + ': the `no` form is accepted', JSON.stringify(msgs));
  const after = config(env);
  ok(after === base, name + ': and the config comes back byte for byte',
    after === base ? '' : 'differs: ' + JSON.stringify({
      lost: base.split('\n').filter(function (l) { return after.indexOf(l) === -1; }),
      added: after.split('\n').filter(function (l) { return base.indexOf(l) === -1; })
    }));
  return env;
}

// Removing something that is not there must refuse, name it, and change nothing.
function refusal(name, negative, expect) {
  const env = fresh();
  const base = config(env);
  const out = apply(env, negative);
  const msgs = messages(out);
  ok(msgs.length === 1, name + ': refuses rather than pretending', JSON.stringify(msgs));
  ok(msgs.length === 1 && expect.test(msgs[0]), name + ': and says what is missing, by name', msgs[0]);
  ok(config(env) === base, name + ': and changes nothing', config(env) === base ? '' : 'config moved');
}

console.log('');
console.log('hostname:');
{
  const env = roundTrip('hostname',
    ['configure terminal', 'hostname ripper', 'end'],
    ['configure terminal', 'no hostname', 'end'],
    /^hostname ripper$/m);
  ok(env.d.name !== 'ripper', 'the canvas label is restored too, not just the config', env.d.name);
  ok(/^hostname ASR 1001-X/m.test(config(env)),
    'and the printed line falls back to the device\'s own name', config(env).split('\n')[0]);
}

console.log('');
console.log('ip dhcp pool:');
{
  roundTrip('ip dhcp pool',
    ['configure terminal', 'ip dhcp pool P1', 'network 10.5.0.0 255.255.255.0',
      'range 10.5.0.10 10.5.0.200', 'default-router 10.5.0.1', 'exit', 'end'],
    ['configure terminal', 'no ip dhcp pool P1', 'end'],
    /^ip dhcp pool P1$/m);
}

console.log('');
console.log('dns zone:');
{
  roundTrip('dns zone',
    ['configure terminal', 'dns zone test.example', 'dns add www A 10.1.2.3', 'end'],
    ['configure terminal', 'no dns zone test.example', 'end'],
    /^dns zone test\.example$/m);
  // The shortcut form: leaving the zone out must not silently do nothing.
  const env = fresh();
  apply(env, ['configure terminal', 'dns zone test.example', 'dns add www A 10.1.2.3', 'end']);
  const out = apply(env, ['configure terminal', 'no dns zone TEST.Example', 'end']);
  ok(messages(out).length === 0, 'a zone is removable by any spelling of its name',
    JSON.stringify(messages(out)));
}

console.log('');
console.log('ip access-group:');
{
  // The access list itself is not what is being undone here, so it exists before the baseline is taken:
  // undoing a binding must leave the list behind, which is why the round trip is done by hand for this one.
  const env0 = fresh();
  apply(env0, ['configure terminal', 'access-list 101 deny ip any any', 'end']);
  const base0 = config(env0);
  apply(env0, ['configure terminal', 'interface %P%', 'ip access-group 101 in', 'end']);
  ok(/^\s+ip access-group 101 in$/m.test(config(env0)), 'ip access-group: the printer prints it');
  const out0 = apply(env0, ['configure terminal', 'interface %P%', 'no ip access-group 101 in', 'end']);
  ok(messages(out0).length === 0, 'ip access-group: the `no` form is accepted', JSON.stringify(messages(out0)));
  ok(config(env0) === base0, 'ip access-group: the binding goes and the list stays',
    config(env0) === base0 ? '' : 'config moved');

  // Unqualified: clears whichever directions are bound.
  const env = fresh();
  apply(env, ['configure terminal', 'access-list 101 deny ip any any',
    'access-list 102 permit ip any any', 'end']);
  const base = config(env);
  apply(env, ['configure terminal', 'interface %P%', 'ip access-group 101 in',
    'ip access-group 102 out', 'end']);
  const out = apply(env, ['configure terminal', 'interface %P%', 'no ip access-group', 'end']);
  ok(messages(out).length === 0, 'the unqualified form is accepted', JSON.stringify(messages(out)));
  ok(config(env) === base, 'and takes both directions off', config(env) === base ? '' : 'config moved');

  // Naming the wrong list must not clear the right one.
  const env2 = fresh();
  apply(env2, ['configure terminal', 'access-list 102 deny ip any any', 'access-list 103 deny ip any any',
    'interface %P%', 'ip access-group 102 in', 'end']);
  const out2 = apply(env2, ['configure terminal', 'interface %P%', 'no ip access-group 103 in', 'end']);
  const msgs2 = messages(out2);
  ok(msgs2.length === 1 && /102/.test(msgs2[0]),
    'naming list 103 while 102 is applied is refused, and says which is applied', msgs2[0]);
  ok(/ip access-group 102 in/.test(config(env2)), 'and 102 is still applied');
}

console.log('');
console.log('vlan:');
{
  roundTrip('vlan',
    ['configure terminal', 'vlan 42', 'end'],
    ['configure terminal', 'no vlan 42', 'end'],
    /^vlan 42 /m);

  // An in-use VLAN cannot be deleted behind the ports' backs.
  const env = fresh(SWITCH);
  apply(env, ['configure terminal', 'vlan 20', 'interface Fa0/3',
    'switchport mode access', 'switchport access vlan 20', 'end']);
  const before = config(env);
  const out = apply(env, ['configure terminal', 'no vlan 20', 'end']);
  const msgs = messages(out);
  ok(msgs.length === 1 && /Fa0\/3/.test(msgs[0]),
    'deleting a VLAN ports still carry is refused, naming the port', msgs[0]);
  ok(/still carried by 1 port/.test(msgs[0] || ''), 'and says how many', msgs[0]);
  ok(config(env) === before, 'and nothing is deleted', config(env) === before ? '' : 'config moved');

  // Move the port off it and it goes.
  apply(env, ['configure terminal', 'interface Fa0/3', 'switchport access vlan 1', 'end']);
  const out2 = apply(env, ['configure terminal', 'no vlan 20', 'end']);
  ok(messages(out2).length === 0, 'once the port is off it, the VLAN can go', JSON.stringify(messages(out2)));
  ok(!/^vlan 20 /m.test(config(env)), 'and the config no longer prints it');
}

console.log('');
console.log('Removing what is not there refuses and changes nothing:');
{
  refusal('no hostname', ['configure terminal', 'no hostname', 'end'], /No hostname set/);
  refusal('no ip dhcp pool', ['configure terminal', 'no ip dhcp pool nope', 'end'], /No DHCP pool named nope/);
  refusal('no dns zone', ['configure terminal', 'no dns zone nope.example', 'end'], /No DNS zone named nope\.example/);
  refusal('no ip access-group', ['configure terminal', 'interface %P%', 'no ip access-group 101 in', 'end'],
    /No access list 101 applied in on/);
  refusal('no vlan', ['configure terminal', 'no vlan 99', 'end'], /VLAN 99 does not exist/);
}

console.log('');
console.log('Every case refuses in the same shape: one sentence, naming the thing');
{
  // One shape for all five: a leading `%`, the thing by name, and no stack-trace vocabulary.
  const shapes = [];
  const env = fresh();
  for (const cmd of ['no hostname', 'no vlan 99']) {
    const m = messages(apply(env, ['configure terminal', cmd, 'end']));
    shapes.push(m[0] || '');
  }
  ok(shapes.every(function (x) { return /^% /.test(x); }), 'each refusal begins with %', JSON.stringify(shapes));
  ok(shapes.every(function (x) { return !/undefined|null|NaN/.test(x); }),
    'and none of them leaks a JS value into the sentence', JSON.stringify(shapes));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
