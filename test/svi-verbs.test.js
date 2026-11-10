'use strict';
// svi-verbs.test.js - a logical interface has no wire, so the verbs that describe a wire have
// nothing to describe.
//
// The `switchport` family and `port-security` already refused an SVI by name. The three verbs that
// had never been asked the question answered anyway, and two of them printed the model's own
// placeholders as if they were hardware:
//
//   SW1(config-if)#speed 1000     Speed on Vlan20 set to 1G (was virtual)
//   SW1(config-if)#duplex full    Duplex on Vlan20 set to full (was full (default))
//   SW1(config-if)#channel-group 1 mode active
//   Interface Vlan20 added to channel group 1 (LACP active)
//
// and the interface page went on offering all of it, plus the fifteen `switchport`/`port-security`
// rows the parser refused. This suite pins the refusals, the page, and the physical port that keeps
// every one of them.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

function lab() {
  const t = new Topology();
  const d = t.addDevice(find('generic-switch')); d.name = 'SW1';
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable'); s.run('configure terminal');
  return { t: t, d: d, s: s };
}
function onSvi() {
  const env = lab();
  env.s.run('interface vlan 20');
  env.s.run('ip address 10.0.20.1 255.255.255.0');
  return env;
}
function onPort(port) {
  const env = lab();
  env.s.run('interface ' + (port || 'Fa0/1'));
  return env;
}
const VALUES = { port: 'Fa0/1', id: '10', ip: '10.0.0.1', mask: '255.255.255.0', vlan: '10', n: '10',
  addr: '10.0.0.1', mac: '00:11:22:33:44:55', vrid: '1', group: '1', priority: '100', seconds: '60' };
function fill(line) {
  return line.split(/\s+/).map(function (t) {
    if (t.indexOf('|') !== -1) t = t.split('|')[0];
    if (/^\[.*\]$/.test(t)) t = t.replace(/[\[\]]/g, '').split('|')[0];
    return t.replace(/<([a-z0-9-]+)>/gi, function (m, k) { return VALUES[k] || '10'; });
  }).join(' ').trim();
}
function rowsOf(env) {
  return text(env.s.run('?')).split('\n').map(function (l) { return l.trim(); })
    .filter(function (l) { return /^[a-z]/.test(l) && l.indexOf('%') === -1 && !/^Available commands/.test(l); })
    .map(function (l) { return l.split(/\s{2,}/)[0]; });
}

console.log('An SVI has no wire:');
{
  const env = onSvi();
  for (const [cmd, why] of [
    ['speed 1000', /nothing is transmitted at a rate here/],
    ['no speed', /nothing is transmitted at a rate here/],
    ['duplex full', /it has no duplex/],
    ['no duplex', /it has no duplex/],
    ['channel-group 1 mode active', /cannot join a link aggregation group/],
    ['no channel-group', /cannot join a link aggregation group/]
  ]) {
    const out = text(env.s.run(cmd));
    ok(why.test(out), 'refused: "' + cmd + '"');
    ok(/is a logical interface/.test(out), 'and it says what the interface is');
    ok(!/virtual|was \?/.test(out), 'and invents no hardware state (' + cmd + ')');
  }
  // The message has to be usable: it names where the setting does belong.
  ok(/member ports/.test(text(env.s.run('speed 1000'))), 'speed points at the member ports');
  ok(/show etherchannel/.test(text(env.s.run('channel-group 1 mode active'))),
    'channel-group points at the view that would have listed it');
  ok(/No link aggregation groups/.test(text(env.s.run('show etherchannel'))),
    'and no group was created behind the refusal');
}

console.log('\nWhat an SVI does have is still there:');
{
  const env = onSvi();
  ok(/set to 9000/.test(text(env.s.run('mtu 9000'))), 'mtu applies to an SVI (it is an IP thing)');
  ok(/MTU on Vlan20 back to 1500/.test(text(env.s.run('no mtu'))),
    'and so does its removal (which takes no argument, like `no speed`)');
  ok(/IP address set on Vlan20/.test(text(env.s.run('ip address 10.0.20.2 255.255.255.0'))),
    'the address is what the interface is for');
  ok(!/logical interface/.test(text(env.s.run('shutdown'))), 'and shutdown is a state, not a wire');
}

console.log('\nThe page follows the interface it describes:');
{
  const svi = rowsOf(onSvi());
  const phys = rowsOf(onPort());
  const wire = /switchport|port-security|^speed|^duplex|channel-group|encapsulation|no speed|no duplex/;
  ok(svi.filter(function (r) { return wire.test(r); }).length === 0,
    'no wire verb is offered on an SVI (' + svi.length + ' rows)');
  ok(phys.filter(function (r) { return wire.test(r); }).length > 15,
    'while a physical port keeps all of them (' + phys.length + ' rows)');
  ok(svi.length >= 25, 'the SVI page is still a page, not an empty list (' + svi.length + ')');
  ok(svi.filter(function (r) { return /^mtu|^ip address|^ip helper-address|^shutdown|^description/.test(r); }).length >= 4,
    'and the rows an SVI really has are on it');
  // Both ways: every row the SVI page still shows must not be refused for being logical.
  let walked = 0;
  for (const syn of svi) {
    const cmd = fill(syn.split(' / ')[0].replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim());
    // Ordinary control flow, not an exemption: session verbs and the removal half are walked by
    // their own assertions, and a removal has nothing to say about the positive page.
    if (!cmd || /^(help|exit|end|no\b)/.test(cmd)) continue;
    const out = text(onSvi().s.run(cmd)).split('\n')[0];
    walked++;
    ok(!/logical interface/.test(out), 'shown and accepted (or refused for another reason): "' + cmd + '"');
  }
  ok(walked >= 12, 'the walk typed ' + walked + ' rows of the SVI page');
  // And every row it hides really is refused there.
  for (const cmd of ['switchport mode access', 'switchport port-security', 'speed 1000',
    'duplex full', 'channel-group 1 mode active']) {
    ok(/logical interface|physical port|not a switchport|no duplex|rate here|aggregation/.test(
      text(onSvi().s.run(cmd))), 'hidden because it is refused: "' + cmd + '"');
  }
}

console.log('\nA physical port is unchanged:');
{
  const env = onPort('Fa0/1');
  ok(/Speed on Fa0\/1 set to 1G/.test(text(env.s.run('speed 1000'))), 'speed sets');
  ok(/Duplex on Fa0\/1 set to full/.test(text(env.s.run('duplex full'))), 'duplex sets');
  ok(/added to channel group 1/.test(text(env.s.run('channel-group 1 mode active'))), 'channel-group joins');
  ok(/no link aggregation groups|Group/.test(text(env.s.run('show etherchannel'))),
    'and the group exists in the view');
  ok(/Switchport mode access on Fa0\/1/.test(text(env.s.run('switchport mode access'))),
    'switchport still works on a port');
  ok(/Speed on Fa0\/1 back to negotiation/.test(text(env.s.run('no speed'))), 'and no speed reverts');
  ok(/MTU on Fa0\/1 is already the default 1500/.test(text(env.s.run('no mtu'))),
    'the split row still carries no mtu');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
