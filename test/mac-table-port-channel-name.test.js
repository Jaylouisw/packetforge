'use strict';
// `show mac address-table` names the port-channel for a frame that arrived on a bundle (#fidelity: EtherChannel).
//
// A real box learns the source address against the *logical* port: Cisco's command reference says
// "The show mac-address-table dynamic command output for an EtherChannel interface changes the port number
// designation (for example, 5/7) to a port group number (for example, Po80)", and a Catalyst 9000 table prints
//
//   Vlan Mac Address    Type     Ports
//   100  20bb.c05e.5318 DYNAMIC  Po1
//
// beside its `DYNAMIC Gi1/0/1` rows. This model learned on the member the frame happened to hash to, so the
// same address was reported on `Fa0/2` on one ping and `Fa0/3` on the next - a fact about one frame, printed
// where the reader expects a fact about where the address is.
//
// What must NOT change: a port that is not in a bundle is still named as itself, a member that never
// negotiated is named as itself (it forwards as an ordinary port), and the member is still on the row data, so
// `show mac address-table interface <member>` still finds what was learned on that cable.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
const PORT = 4;                       // Vlan, Mac Address, Type, Age, Ports
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];
const MAC_B = '0200.0000.0300';       // b's hardware address, as the table prints it
const MAC_LONER = '0200.0000.0200';   // a's, learned on a plain port

// a -- s1 ==(Fa0/2,Fa0/3, channel-group 1)== s2 -- b, with `mode` on both ends of the bundle.
function lab(mode) {
  const t = new Topology();
  const s1 = t.addDevice(SWITCH, 's1');
  const s2 = t.addDevice(SWITCH, 's2');
  const a = t.addDevice(PC, 'a');
  const b = t.addDevice(PC, 'b');
  t.connect('a', 'eth0', 's1', 'Fa0/1');
  t.connect('b', 'eth0', 's2', 'Fa0/1');
  t.connect('s1', 'Fa0/2', 's2', 'Fa0/2');
  t.connect('s1', 'Fa0/3', 's2', 'Fa0/3');
  const sim = new Simulator(t);
  for (const id of ['s1', 's2']) {
    runCommands(t.getDevice(id), t, sim, ['configure terminal',
      'interface Fa0/2', 'channel-group 1 mode ' + (mode || 'active'),
      'interface Fa0/3', 'channel-group 1 mode ' + (mode || 'active'), 'end']);
  }
  runCommands(a, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'end']);
  runCommands(b, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.10 255.255.255.0', 'end']);
  // Traffic both ways, which is what makes both switches learn both ends.
  sim.ping('a', '10.0.0.10', { count: 3 });
  sim.ping('b', '10.0.0.9', { count: 3 });
  return { t: t, sim: sim, s1: s1, s2: s2, a: a, b: b };
}

function rows(env, dev, cmd) {
  return ((new CliSession(dev, env.t, env.sim).run(cmd || 'show mac address-table').output) || [])
    // The Vlan cell is a right-aligned four-character field, so a row begins with spaces before its id
    // (research/mac-table-vlan-cell.md).
    .map(String).filter(function (l) { return /^\s*\d+\s+[0-9a-f]{4}\./.test(l); });
}
function cell(line, i) {
  return String(line || '').trim().split(/\s+/)[i];
}

console.log('');
console.log('A bundled frame is remembered against the port-channel:');
{
  const env = lab('active');
  const s1 = rows(env, env.s1);
  const s2 = rows(env, env.s2);
  const bOnS1 = s1.filter(function (l) { return l.indexOf(MAC_B) !== -1; })[0];
  const aOnS2 = s2.filter(function (l) { return l.indexOf(MAC_LONER) !== -1; })[0];
  ok(!!bOnS1 && cell(bOnS1, PORT) === 'Po1', "the far end's address is on Po1, not on the member it hashed to",
    JSON.stringify(bOnS1));
  ok(!!aOnS2 && cell(aOnS2, PORT) === 'Po1', 'and the same holds on the other switch', JSON.stringify(aOnS2));
  ok(s1.every(function (l) { return !/(Fa0\/2|Fa0\/3)\s*$/.test(l); }),
    'no row names a member of the bundle any more', JSON.stringify(s1));
  ok(rows(env, env.s1).length === rows(env, env.s2).length && rows(env, env.s1).length === 4,
    'the count of entries is unchanged - the same four addresses, fewer names', JSON.stringify(rows(env, env.s1)));

  // Repeated pings hash to different members; the answer must not move with them.
  const seen = new Set();
  for (let i = 0; i < 8; i++) {
    env.sim.ping('a', '10.0.0.10', { count: 1 });
    const row = rows(env, env.s1).filter(function (l) { return l.indexOf(MAC_B) !== -1; })[0];
    seen.add(cell(row, PORT));
  }
  ok(seen.size === 1 && seen.has('Po1'), 'eight more frames, hashed across both members, still name one port', JSON.stringify([...seen]));
}

console.log('');
console.log('A port in no bundle is still named as itself:');
{
  const env = lab('active');
  const loner = rows(env, env.s1).filter(function (l) { return l.indexOf(MAC_LONER) !== -1; })[0];
  ok(!!loner && cell(loner, PORT) === 'Fa0/1', "the address heard on the plain port says Fa0/1", JSON.stringify(loner));
}

console.log('');
console.log('A member that never negotiated forwards as a single link, and is named as one:');
{
  // passive + passive: neither end starts LACP, so neither port is in the bundle.
  const env = lab('passive');
  const s1 = rows(env, env.s1);
  const bOnS1 = s1.filter(function (l) { return l.indexOf(MAC_B) !== -1; })[0];
  ok(!!bOnS1 && /^Fa0\/[23]$/.test(cell(bOnS1, PORT)),
    'the address is named on the member it arrived on, not on a bundle that never formed',
    JSON.stringify(bOnS1));
  ok(s1.every(function (l) { return cell(l, PORT) !== 'Po1'; }), 'and no row claims Po1', JSON.stringify(s1));
}

console.log('');
console.log('The member is still on the row, so a filter by cable still finds it:');
{
  const env = lab('active');
  const row = env.s1.macRows(env.t).filter(function (r) { return r.mac === MAC_B.replace(/\./g, '') || r.mac === '02:00:00:00:03:00'; })[0];
  ok(!!row && row.port === 'Po1', 'the row the console prints names the port-channel', JSON.stringify(row));
  ok(!!row && /^Fa0\/[23]$/.test(row.learnedOn), 'and carries the member it was learned on', JSON.stringify(row));
  const byMember = rows(env, env.s1, 'show mac address-table interface Fa0/2')
    .concat(rows(env, env.s1, 'show mac address-table interface Fa0/3'));
  ok(byMember.some(function (l) { return l.indexOf(MAC_B) !== -1; }),
    'asking about the cable answers with the entry learned on it', JSON.stringify(byMember));
  ok(rows(env, env.s1, 'show mac address-table interface Fa0/1').every(function (l) {
    return l.indexOf(MAC_B) === -1;
  }), 'and a filter for a port it was not learned on still excludes it');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
