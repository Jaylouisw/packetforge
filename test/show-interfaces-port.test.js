'use strict';
// What `show interfaces <port>` was asked, what it answered, and what `no vlan` was allowed to touch (#1289).
//
// Three separate lies in one corner of the console:
//
//  1. `show interfaces Fa0/1` printed every port on the box. The answer to a question about one socket was
//     the whole switch, and on a 48-port model the socket asked about could be eight screens down.
//  2. The same block never said which VLAN the port is in, or whether it is a trunk - the switchport
//     configuration only existed in `show vlan` (membership) and `show running-config` (the lines). The
//     command an operator opens first said `ip: unassigned` about a port whose whole job is its VLAN.
//  3. `no vlan 20` counted ports that *carry* the VLAN by looking only at the access VLAN and at an allowed
//     list stored as an array, so a trunk allowing all VLANs was invisible to it, and a native VLAN staged
//     on an access port was invisible too. Removing the VLAN then cleared that stored value in silence.
//
// And one in the session: `exit` from config mode dropped two levels, to user EXEC.
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
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

function lab() {
  const t = new Topology();
  const d = t.addDevice(SWITCH, 'sw');
  const sim = new Simulator(t);
  return { t: t, d: d, sim: sim,
    run: function (lines) { return runCommands(d, t, sim, lines).lines; },
    cfg: function (lines) { return ['enable', 'configure terminal'].concat(lines).concat(['end']); } };
}

// A subinterface is an interface too, so the block pattern has to match both kinds.
function blocks(lines) { return lines.filter(function (l) { return /\((ethernet|subinterface)/.test(l); }); }

console.log('');
console.log('`show interfaces <port>` answers about the port that was named:');
{
  const env = lab();
  const one = env.run(['show interfaces Fa0/1']);
  ok(blocks(one).length === 1, 'one port block, not eight', String(blocks(one).length));
  ok(/^Fa0\/1 /.test(blocks(one)[0]), 'and it is the port that was asked for', blocks(one)[0]);

  const all = env.run(['show interfaces']);
  ok(blocks(all).length === env.d.interfaces.size, '`show interfaces` with no name still lists every port',
    blocks(all).length + ' of ' + env.d.interfaces.size);

  // The name is resolved by the same table `interface Fa0/1` uses, so every spelling works.
  const spellings = ['Fa0/1', 'fa0/1', 'Fa0/1 '];
  const got = spellings.map(function (sp) {
    const b = blocks(env.run(['show interfaces ' + sp]));
    return b.length === 1 ? b[0].split(' ')[0] : 'n=' + b.length;
  });
  const distinct = [...new Set(got)];
  ok(distinct.length === 1 && distinct[0] === 'Fa0/1', 'every spelling of one socket answers about it',
    JSON.stringify(got));

  // The two commands have to agree about which sockets exist: a name `interface` refuses must not be answered
  // with a port list, and a name it accepts must be answerable here. One table, two callers.
  const probes = ['Fa0/1', 'fa0/1', 'Fa9/9', 'eth1', 'GigabitEthernet0/1', 'Fa0/1.10'];
  let disagreements = [];
  for (const sp of probes) {
    const ifaceOut = env.run(['enable', 'configure terminal', 'interface ' + sp, 'description probe-' + sp,
      'exit', 'end']).join(' ');
    const accepts = !/Unrecognized|does not exist|No interface/.test(ifaceOut);
    const answered = blocks(env.run(['show interfaces ' + sp])).length > 0;
    if (accepts !== answered) disagreements.push(sp + ' (interface:' + accepts + ' show:' + answered + ')');
  }
  ok(disagreements.length === 0, probes.length + ' spellings: both commands agree on what exists',
    JSON.stringify(disagreements));

  const unknown = env.run(['show interfaces Fa9/9']).filter(function (l) { return /^%/.test(l); });
  ok(unknown.length === 1 && /No interface Fa9\/9/.test(unknown[0]),
    'a name that matches nothing is refused by name, not answered with a list', JSON.stringify(unknown));
  ok(blocks(env.run(['show interfaces Fa9/9'])).length === 0, 'and prints no port block at all');
}

console.log('');
console.log('...and says what the port does with a frame:');
{
  const env = lab();
  env.run(['enable', 'configure terminal', 'vlan 20', 'name sales',
    'interface Fa0/1', 'switchport access vlan 20', 'exit',
    'interface Fa0/2', 'switchport mode trunk', 'switchport trunk native vlan 30',
    'switchport trunk allowed vlan 10,20', 'exit',
    'interface Fa0/3', 'switchport trunk native vlan 20', 'exit', 'end']);

  const access = env.run(['show interfaces Fa0/1']).filter(function (l) { return /switchport/.test(l); });
  ok(access.length === 1 && /switchport: access VLAN 20$/.test(access[0]),
    'an access port names its access VLAN', JSON.stringify(access));

  const trunk = env.run(['show interfaces Fa0/2']).filter(function (l) { return /switchport/.test(l); });
  ok(trunk.length === 1 && /switchport: trunk · native 30 · allowed 10,20/.test(trunk[0]),
    'a trunk names its native VLAN and its allowed list', JSON.stringify(trunk));

  const staged = env.run(['show interfaces Fa0/3']).filter(function (l) { return /switchport/.test(l); });
  ok(staged.length === 1 && /trunk staged: native 20 \(not in use\)/.test(staged[0]),
    'a staged trunk parameter is marked as staged, not reported as in force', JSON.stringify(staged));

  // The line has to agree with the data plane's own answer, or it is a second opinion.
  const vlanLib = require('../engine/vlan');
  for (const port of ['Fa0/1', 'Fa0/2', 'Fa0/3']) {
    const iface = env.d.interfaces.get(port);
    const verdict = vlanLib.classifyEgress(iface.vlan, iface.vlan.mode === 'trunk' ? 20 : iface.vlan.accessVlan);
    const line = env.run(['show interfaces ' + port]).filter(function (l) { return /switchport/.test(l); })[0];
    const saysTrunk = /switchport: trunk/.test(line);
    ok(saysTrunk === (iface.vlan.mode === 'trunk'),
      port + ': the line names the mode the data plane uses', line);
    ok(((verdict.action || 'drop') !== 'drop') === (iface.vlan.mode === 'trunk' ||
      Number(iface.vlan.accessVlan) === Number(iface.vlan.accessVlan)),
      port + ': and the VLAN it names is the one that can carry', line);
  }

  // A port with no switchport configuration says nothing rather than claiming a mode.
  const bare = env.d.interfaces.get('Fa0/5');
  bare.vlan = null;
  const none = env.run(['show interfaces Fa0/5']).filter(function (l) { return /switchport/.test(l); });
  ok(none.length === 0, 'a port with no switchport configuration prints no switchport line',
    JSON.stringify(none));

  // A routed port is not a switchport, even though the engine fills a default `vlan` object for every
  // interface: printing "switchport: access, access VLAN 1" beside a router address claims a mode it has not
  // got.
  const ROUTER = catalog.filter(function (s) { return s.model === 'generic-router'; })[0];
  const rt = new Topology();
  const rd = rt.addDevice(ROUTER, 'r1');
  const rsim = new Simulator(rt);
  runCommands(rd, rt, rsim, ['enable', 'configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'end']);
  const rid = rd.interfaces.keys().next().value;
  const rline = runCommands(rd, rt, rsim, ['show interfaces ' + rid]).lines
    .filter(function (l) { return /switchport/.test(l); });
  ok(rline.length === 0, 'a router port prints no switchport line', JSON.stringify(rline));
}

console.log('');
console.log('`no vlan <id>` counts every port that depends on the VLAN:');
{
  // A trunk allowing all VLANs carries the one being removed. The old guard looked only at an allowed list
  // stored as an array, so this port was invisible and the VLAN went out from under it.
  const env = lab();
  env.run(['enable', 'configure terminal', 'vlan 20',
    'interface Fa0/4', 'switchport mode trunk', 'exit', 'end']);
  const out = env.run(['enable', 'configure terminal', 'no vlan 20', 'end'])
    .filter(function (l) { return /^%|VLAN 20 removed/.test(l); });
  ok(out.length === 1 && /still carried by 1 port\(s\): Fa0\/4/.test(out[0]),
    'a trunk allowing all VLANs counts as carrying it', JSON.stringify(out));
  ok(env.d.config.vlans && env.d.config.vlans[20], 'and the VLAN is still there');

  // The native VLAN on a trunk is named as such.
  const env2 = lab();
  env2.run(['enable', 'configure terminal', 'vlan 20',
    'interface Fa0/2', 'switchport mode trunk', 'switchport trunk native vlan 20', 'exit', 'end']);
  const out2 = env2.run(['enable', 'configure terminal', 'no vlan 20', 'end'])
    .filter(function (l) { return /^%|VLAN 20 removed/.test(l); });
  ok(/still carried by 1 port\(s\): Fa0\/2 \(native\)/.test(out2.join(' ')),
    'a native VLAN is named as the native VLAN', JSON.stringify(out2));
}

console.log('');
console.log('A port that only references the VLAN protects it too:');
{
  // The port does not carry VLAN 20 - it is an access port - but it is staged for it, and removing the VLAN
  // used to clear that stored value with no message at all.
  const env = lab();
  env.run(['enable', 'configure terminal', 'vlan 20',
    'interface Fa0/3', 'switchport trunk native vlan 20', 'switchport trunk allowed vlan 10,20', 'exit', 'end']);
  const before = JSON.stringify(env.d.interfaces.get('Fa0/3').vlan);
  const out = env.run(['enable', 'configure terminal', 'no vlan 20', 'end'])
    .filter(function (l) { return /^%|VLAN 20 removed/.test(l); });
  ok(/still referenced by 1 port\(s\)/.test(out.join(' ')), 'the staged reference refuses the removal',
    JSON.stringify(out));
  ok(/trunk native/.test(out.join(' ')) && /trunk allowed/.test(out.join(' ')),
    'and names both kinds of reference', JSON.stringify(out));
  ok(/clear that first/.test(out.join(' ')), 'with the instruction rather than the carried-port one',
    JSON.stringify(out));
  ok(JSON.stringify(env.d.interfaces.get('Fa0/3').vlan) === before,
    'and the port\'s staged configuration is untouched', JSON.stringify(env.d.interfaces.get('Fa0/3').vlan));

  // Once each reference is cleared, the VLAN can go - and says so.
  env.run(['enable', 'configure terminal', 'interface Fa0/3',
    'no switchport trunk native vlan', 'no switchport trunk allowed vlan', 'exit', 'end']);
  const after = env.run(['enable', 'configure terminal', 'no vlan 20', 'end'])
    .filter(function (l) { return /^%|VLAN 20 removed/.test(l); });
  ok(after.length === 1 && /VLAN 20 removed/.test(after[0]), 'with nothing left, the VLAN is removed',
    JSON.stringify(after));
}

console.log('');
console.log('...and a port that carries it is named as carrying it, not as referencing it:');
{
  const env = lab();
  env.run(['enable', 'configure terminal', 'vlan 20',
    'interface Fa0/1', 'switchport access vlan 20', 'exit',
    'interface Fa0/2', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'exit', 'end']);
  const out = env.run(['enable', 'configure terminal', 'no vlan 20', 'end'])
    .filter(function (l) { return /^%/.test(l); });
  ok(/still carried by 2 port\(s\)/.test(out.join(' ')), 'both carrier kinds are counted', JSON.stringify(out));
  ok(/Fa0\/1/.test(out.join(' ')) && /Fa0\/2/.test(out.join(' ')), 'and both are named', JSON.stringify(out));
}

console.log('');
console.log('Every interface a device has is listed, subinterfaces after their parent:');
{
  const ROUTER = catalog.filter(function (s) { return s.model === 'generic-router'; })[0];
  const t = new Topology();
  const rd = t.addDevice(ROUTER, 'r1');
  const sim = new Simulator(t);
  const run = function (lines) { return runCommands(rd, t, sim, lines).lines; };
  run(['enable', 'configure terminal', 'interface Gi0/0.10', 'ip address 10.9.9.1 255.255.255.0', 'exit',
    'interface Gi0/0.20', 'ip address 10.10.9.1 255.255.255.0', 'exit', 'end']);
  const listed = blocks(run(['show interfaces'])).map(function (l) { return l.split(' ')[0]; });
  ok(listed.length === rd.interfaces.size, 'all ' + rd.interfaces.size + ' interfaces are listed, not ' +
    (rd.interfaces.size - 2), JSON.stringify(listed));
  ok(listed.indexOf('Gi0/0.10') !== -1 && listed.indexOf('Gi0/0.20') !== -1,
    'including both subinterfaces', JSON.stringify(listed));
  ok(listed.indexOf('Gi0/0.10') === listed.indexOf('Gi0/0') + 1,
    'each subinterface follows its parent', JSON.stringify(listed));
  const sub = run(['show interfaces Gi0/0.10']).filter(function (l) { return /ip: /.test(l); });
  ok(/10\.9\.9\.1\/24/.test(sub.join(' ')), 'and the subinterface block shows the address it holds',
    JSON.stringify(sub));
}

console.log('');
console.log('`exit` from config mode goes up one level, to privileged EXEC:');
{
  const t = new Topology();
  const d = t.addDevice(SWITCH, 'sw');
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  ok(/#$/.test(s.prompt()), 'the session is privileged to begin with', s.prompt());
  s.run('configure terminal');
  ok(/\(config\)#$/.test(s.prompt()), 'config mode', s.prompt());
  s.run('exit');
  ok(/#$/.test(s.prompt()) && !/>$/.test(s.prompt()),
    '`exit` lands on `#`, not on `>`: it went up two levels and reported lost privileges', s.prompt());
  s.run('configure terminal');
  s.run('interface Fa0/1');
  s.run('exit');
  ok(/\(config\)#$/.test(s.prompt()), '`exit` from an interface block is still config mode', s.prompt());
  s.run('interface Fa0/1');
  s.run('end');
  ok(/#$/.test(s.prompt()), 'and `end` is privileged EXEC from an interface block', s.prompt());
  s.run('configure terminal');
  s.run('end');
  ok(/#$/.test(s.prompt()), 'and from config mode', s.prompt());
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
