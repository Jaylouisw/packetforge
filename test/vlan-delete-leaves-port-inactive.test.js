'use strict';
// `no vlan 22`: the VLAN goes, and the access ports on it stay assigned to it and go inactive.
//
// The one question: what does a real switch do when a VLAN is deleted while ports are assigned to it? This
// console refused the command outright ("% VLAN 22 is still carried by 1 port(s): Fa0/1 - move them off it
// first"), which is not what the device does. Cisco's "Deleting a VLAN" caution: "When you delete a VLAN, any
// ports assigned to that VLAN become inactive. They remain associated with the VLAN (and thus inactive) until
// you assign them to a new VLAN." (Catalyst 9200 Configuration Guide, Configuring VLANs; the same sentence is
// in the 6500 15.4SY, IE3500 17.17, ESS3300 and micro-switch 15.2(7)E guides.) The observable consequences
// recorded on the same pages, and in Cisco's own troubleshooting doc and the CCNAv7 chapter 4.4 transcript:
//
//   * the port keeps `switchport access vlan 22` - "A port remembers what VLAN it is assigned to, even if the
//     VLAN itself is deleted" (Cisco TAC, Troubleshoot Switch Port and Interface Problems);
//   * `show interfaces` calls it `down (inactive)`, and `show interfaces switchport` prints
//     `Access Mode VLAN: 10 (Inactive)` (CCNAv7 transcript);
//   * `show vlan` loses the row *and* the port - "VLAN 10 is now missing ... port Fa0/6 has not been
//     reassigned to the default VLAN" (same transcript);
//   * re-creating the VLAN brings the ports back with no interface command: "Re-creating the missing VLAN
//     would automatically reassign the hosts to it".
//
// A trunk that carries the VLAN is the other half of the same question, and it now behaves the same way:
// the VLAN goes, the trunk's `switchport trunk allowed vlan ...` line stays exactly as typed, and the port
// simply stops carrying a VLAN the database no longer holds. Two operators answer the configuration half on
// Cisco Community - "No, you need to remove it manually from the trunk interface" (deleting VLAN) and "only
// deleting it ("no vlan 30") won't make it disappear from the interface's config" (removing and deleting a
// vlan from a trunk) - and the Catalyst 9300 trunk guide makes membership the intersection of enabled,
// existing and allowed (research/trunk-allowed-vlan-on-vlan-delete.md).
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
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }
function SW() { return spec('generic-switch'); }
function PC() { return spec('generic-pc'); }
function allUp(replies) { return replies.every(function (r) { return r.success; }); }
function lines(list) { return (list || []).map(String); }

console.log('');
console.log('A deleted VLAN takes its access ports inactive, and keeps them assigned:');
{
  const t = new Topology();
  const pc1 = t.addDevice(PC(), 'pc1');
  const pc2 = t.addDevice(PC(), 'pc2');
  const sw = t.addDevice(SW(), 'sw1');
  t.connect(pc1.id, 'eth0', sw.id, 'Fa0/1');
  t.connect(pc2.id, 'eth0', sw.id, 'Fa0/2');

  const sim = new Simulator(t);
  runCommands(pc1, t, sim, ['configure terminal', 'interface eth0', 'ip address 192.168.10.10 255.255.255.0']);
  runCommands(pc2, t, sim, ['configure terminal', 'interface eth0', 'ip address 192.168.10.20 255.255.255.0']);
  const cli = new CliSession(sw, t, sim);
  const say = function (c) { return lines(cli.run(c).output); };
  cli.run('enable');

  cli.run('configure terminal');
  say('vlan 22');
  say('interface Fa0/1');
  say('switchport access vlan 22');
  say('interface Fa0/2');
  say('switchport access vlan 22');
  cli.run('end');
  ok(allUp(sim.ping(pc1.id, '192.168.10.20', { count: 2 }).replies), 'both hosts in VLAN 22 can reach each other');

  cli.run('configure terminal');
  const removed = say('no vlan 22');
  cli.run('end');
  ok(!removed.some(function (l) { return /^\s*%/.test(l); }), 'the VLAN is not refused: the device deletes it', JSON.stringify(removed));
  ok(removed.some(function (l) { return /VLAN 22 removed/.test(l); }), 'and says the VLAN is gone', JSON.stringify(removed));
  ok(removed.some(function (l) { return /Fa0\/1, Fa0\/2 are now inactive/.test(l); }),
    'and names the ports the deletion took down', JSON.stringify(removed));

  const vlanTable = say('show vlan brief').join('\n');
  ok(!/^22\s/m.test(vlanTable), 'show vlan brief loses the row', vlanTable);
  ok(!/Fa0\/1/.test(vlanTable) && !/Fa0\/2/.test(vlanTable),
    'and does not put the ports back under VLAN 1', vlanTable);

  const running = say('show running-config').join('\n');
  ok(/switchport access vlan 22/.test(running), 'the port keeps its assignment in the running config', running);
  ok(!/^vlan 22$/m.test(running), 'while the VLAN itself is no longer configured', running);

  const block = say('show interfaces Fa0/1').join('\n');
  ok(/status: down \(inactive\)/.test(block), 'show interfaces reports the port down (inactive)', block);
  ok(/switchport: access VLAN 22/.test(block), 'and still reports the assignment it is waiting on', block);
  ok(!allUp(sim.ping(pc1.id, '192.168.10.20', { count: 2 }).replies),
    'the hosts cannot pass traffic through an inactive port');
  ok(!sim.ping(pc1.id, '192.168.10.20', { count: 2 }).replies.some(function (r) { return r.success; }),
    'not even one reply');
  ok(sw.macTables.has(22) === false || sw.macTables.get(22).size === 0,
    'and the MAC entries learned in the deleted VLAN are gone');

  cli.run('configure terminal');
  say('vlan 22');
  cli.run('end');
  const restored = say('show interfaces Fa0/1').join('\n');
  ok(/status: up, protocol: up/.test(restored), 're-creating the VLAN takes the port out of the inactive state', restored);
  // The drop counter keeps the history: frames refused while the VLAN was gone stay refused, and stay counted.
  ok(/drops \(inactive port: access VLAN 22 does not exist/.test(restored),
    'and remembers what it dropped while it was down', restored);
  ok(/Fa0\/1/.test(say('show vlan brief').join('\n')), 'and the port is back in the VLAN row');
  ok(allUp(sim.ping(pc1.id, '192.168.10.20', { count: 2 }).replies), 'and the hosts talk again');
}

console.log('');
console.log('A trunk that carries it keeps its line, and stops carrying the VLAN:');
{
  // One switch, one trunk, and the VLAN on its allowed list. `no vlan 22` is a database operation: the line
  // is configuration and survives it, and the trunk stops carrying 22 because 22 no longer exists.
  const t = new Topology();
  const sw = t.addDevice(SW(), 'sw1');
  const sim = new Simulator(t);
  const cli = new CliSession(sw, t, sim);
  const say = function (c) { return lines(cli.run(c).output); };
  cli.run('enable');
  cli.run('configure terminal');
  say('vlan 22');
  say('interface Fa0/4');
  say('switchport mode trunk');
  say('switchport trunk allowed vlan 10,22');
  cli.run('end');
  cli.run('configure terminal');
  const out = say('no vlan 22');
  cli.run('end');
  ok(!out.some(function (l) { return /^\s*%/.test(l); }), 'a trunk that carries the VLAN does not stop the removal',
    JSON.stringify(out));
  ok(out.some(function (l) { return /VLAN 22 removed/.test(l); }), 'the VLAN is removed', JSON.stringify(out));
  ok(out.some(function (l) { return /Fa0\/4 stops carrying VLAN 22/.test(l); }),
    'the trunk is named as one that stops carrying it', JSON.stringify(out));
  ok(/configuration is unchanged/.test(out.join(' ')), 'and its configuration is said to be unchanged',
    JSON.stringify(out));
  ok(!(sw.config.vlans && sw.config.vlans[22]), 'and the VLAN is gone from the database');
  const running = say('show running-config').join('\n');
  ok(/switchport trunk allowed vlan 10,22/.test(running), 'the allowed list is still in the backup, as typed', running);
  const block = say('show interfaces Fa0/4').join('\n');
  ok(/switchport: trunk/.test(block) && /allowed 10,22/.test(block),
    'and `show interfaces` still prints the trunk settings it holds', block);
  ok(!/^22\s/m.test(say('show vlan brief').join('\n')), '`show vlan brief` has no row for it');
}

console.log('');
console.log('And a trunk stops forwarding in it, on both sides of the deletion:');
{
  // Two switches joined by a trunk that allows 22, hosts in 22 at each end. Deleting 22 on the far switch must
  // stop the traffic even though its trunk still lists 22: a trunk port is a member of a VLAN only if the VLAN
  // exists. The tagged frames arriving on that trunk are dropped and counted, and no MAC is learned in a VLAN
  // the box does not have.
  const t = new Topology();
  const pc1 = t.addDevice(PC(), 'pc1');
  const pc2 = t.addDevice(PC(), 'pc2');
  const sw1 = t.addDevice(SW(), 'sw1');
  const sw2 = t.addDevice(SW(), 'sw2');
  t.connect(pc1.id, 'eth0', sw1.id, 'Fa0/1');
  t.connect(pc2.id, 'eth0', sw2.id, 'Fa0/2');
  t.connect(sw1.id, 'Fa0/8', sw2.id, 'Fa0/8');
  const sim = new Simulator(t);
  runCommands(pc1, t, sim, ['configure terminal', 'interface eth0', 'ip address 192.168.22.10 255.255.255.0']);
  runCommands(pc2, t, sim, ['configure terminal', 'interface eth0', 'ip address 192.168.22.20 255.255.255.0']);
  const setup = function (sw, access) {
    return ['enable', 'configure terminal', 'vlan 22',
      'interface ' + access, 'switchport access vlan 22',
      'interface Fa0/8', 'switchport mode trunk', 'switchport trunk allowed vlan 22', 'end'];
  };
  runCommands(sw1, t, sim, setup(sw1, 'Fa0/1'));
  runCommands(sw2, t, sim, setup(sw2, 'Fa0/2'));
  ok(allUp(sim.ping(pc1.id, '192.168.22.20', { count: 2 }).replies), 'the hosts talk across the trunk');

  const cli2 = new CliSession(sw2, t, sim);
  cli2.run('enable');
  cli2.run('configure terminal');
  const out = lines(cli2.run('no vlan 22').output);
  cli2.run('end');
  ok(out.some(function (l) { return /Fa0\/8 stops carrying VLAN 22/.test(l); }),
    'the far switch says its trunk stops carrying 22', JSON.stringify(out));
  ok(!sim.ping(pc1.id, '192.168.22.20', { count: 2 }).replies.some(function (r) { return r.success; }),
    'nothing crosses the trunk into the deleted VLAN');
  const dropped = lines(cli2.run('show interfaces Fa0/8').output).join('\n');
  ok(/drops \(VLAN 22 is not in the VLAN database x\d+\)/.test(dropped),
    'and the ingress frames are counted with the reason', dropped);
  ok(!sw2.macTables.has(22), 'nothing is learned in a VLAN the box does not have');

  // Re-creating the VLAN is enough: the allowed list never changed, so the trunk carries 22 again.
  cli2.run('configure terminal');
  cli2.run('vlan 22');
  cli2.run('end');
  ok(allUp(sim.ping(pc1.id, '192.168.22.20', { count: 2 }).replies),
    're-creating the VLAN brings the trunk back with no interface command');
}

console.log('');
console.log('...and so does a voice VLAN, which is a reference too (#1701):');
{
  // `switchport voice vlan 22` on an access port is live - the port carries tagged frames in 22 - so deleting
  // VLAN 22 would leave the port pointing at a VLAN that no longer exists. It was the one reference `no vlan`
  // did not look at: the VLAN went and the port kept `switchport voice vlan 22`
  // (research/voice-vlan-port-mode.md).
  const t = new Topology();
  const sw = t.addDevice(SW(), 'sw1');
  const sim = new Simulator(t);
  const cli = new CliSession(sw, t, sim);
  const say = function (c) { return lines(cli.run(c).output); };
  cli.run('enable');
  cli.run('configure terminal');
  say('vlan 22');
  say('interface Fa0/3');
  const stored = say('switchport voice vlan 22');
  ok(!/stored/.test(stored.join(' ')), 'the voice VLAN is taken into use on an access port, with no storage note',
    JSON.stringify(stored));
  cli.run('end');

  cli.run('configure terminal');
  const out = say('no vlan 22');
  cli.run('end');
  ok(out.some(function (l) { return /still referenced by 1 port\(s\): Fa0\/3 \(voice\)/.test(l); }),
    'the voice VLAN refuses the removal, and is named', JSON.stringify(out));
  ok(/clear that first/.test(out.join(' ')), 'with the instruction rather than the carried-port one', JSON.stringify(out));
  ok(!out.some(function (l) { return /VLAN 22 removed/.test(l); }), 'and the VLAN is not removed', JSON.stringify(out));
  ok(sw.config.vlans && sw.config.vlans[22], 'so the VLAN is still there', JSON.stringify(sw.config.vlans || {}));
  ok(Number(sw.interfaces.get('Fa0/3').vlan.voiceVlan) === 22, 'and the port still holds the reference',
    JSON.stringify(sw.interfaces.get('Fa0/3').vlan));

  // Cleared, the reference stops protecting it - and the VLAN goes with the ordinary receipt.
  cli.run('configure terminal');
  say('interface Fa0/3');
  say('switchport voice vlan none');
  cli.run('end');
  cli.run('configure terminal');
  const after = say('no vlan 22');
  cli.run('end');
  ok(after.some(function (l) { return /VLAN 22 removed/.test(l); }), 'once cleared, the VLAN can go',
    JSON.stringify(after));
  ok(!(sw.config.vlans && sw.config.vlans[22]), 'and it is gone', JSON.stringify(sw.config.vlans || {}));
}

console.log('');
console.log('Summary: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
