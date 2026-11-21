'use strict';
// VLANs 1002-1005 are the four media defaults a switch is born with (fddi-default, token-ring-default,
// fddinet-default, trnet-default). A *port* cannot be put in one - their media is Token Ring/FDDI and no
// Ethernet frame can carry them - and PacketForge refused them in every vlan-list for that reason.
//
// The allowed list is the one list where that reasoning does not hold. A trunk's allowed list is a set of
// 802.1Q tags over 1-4094, its default is `all` (1-4094), and a switch documents that the four defaults
// cannot be removed from it - so they are members, and a removal's remainder runs straight through them.
// Cisco's own c3550 transcript of `remove 5-10,12` + `add 7` prints `1-4,7,11,13-4094`; this console printed
// `1-4,7,11,13-1001,1006-4094`, a list no box produces, in the backup and in `show interfaces`
// (research/trunk-allowed-reserved-vlans.md).
//
// The other half is that the strictness has to stay where it belongs: `switchport access vlan 1002`,
// `switchport trunk native vlan 1002` and `switchport voice vlan 1002` are still refused, and the shared
// parser's default is still strict so no caller can opt in by accident.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const vlanLib = require('../engine/vlan');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });

function session() {
  const t = new Topology();
  t.addDevice(SWITCH, 's1');
  const sim = new Simulator(t);
  const cli = new CliSession(t.getDevice('s1'), t, sim);
  cli.run('configure terminal');
  cli.run('interface Fa0/1');
  const put = function (cmd) { return cli.run(cmd).output; };
  put('switchport mode trunk');
  return {
    t: t, cli: cli, put: put,
    port: function () { return t.getDevice('s1').interfaces.get('Fa0/1').vlan; },
    allowed: function () {
      const v = t.getDevice('s1').interfaces.get('Fa0/1').vlan;
      return v.allowedVlans === 'all' ? 'all' : v.allowedVlans.slice();
    },
    sentence: function () { return vlanLib.switchportSentence(this.port()); },
    config: function () {
      cli.run('end');
      const line = cli.run('show running-config').output.filter(function (l) {
        return /switchport trunk allowed vlan/.test(l);
      })[0] || '';
      cli.run('configure terminal'); cli.run('interface Fa0/1');
      return line.trim();
    }
  };
}

console.log('');
console.log('The c3550 transcript, which is the reason this file exists:');
{
  const L = session();
  const removed = L.put('switchport trunk allowed vlan remove 5-10,12');
  ok(/allows VLANs 1-4,11,13-4094 \(removed 5-10,12\)/.test(removed[0]),
    'the remainder runs through 1002-1005, as `13-4094`', removed[0]);
  const added = L.put('switchport trunk allowed vlan add 7');
  ok(/allows VLANs 1-4,7,11,13-4094 \(added 7\)/.test(added[0]),
    'and so does the list after the add, `1-4,7,11,13-4094`', added[0]);
  ok(L.config() === 'switchport trunk allowed vlan 1-4,7,11,13-4094',
    'the backup prints the device string', L.config());
  ok(/allowed 1-4,7,11,13-4094$/.test(L.sentence()),
    'and `show interfaces` agrees with it', L.sentence());
  const after = L.allowed();
  ok([1002, 1003, 1004, 1005].every(function (v) { return after.indexOf(v) !== -1; }),
    'the four media defaults are in the stored list, not merely printed', 'ids ' + after.length);
}

console.log('');
console.log('The list form names them, because real configurations do:');
{
  // Cisco's 6500 IPsec example carries `switchport trunk allowed vlan 1,100,1002-1005` in a running config.
  const L = session();
  const out = L.put('switchport trunk allowed vlan 1,100,1002-1005');
  ok(!/^%/.test(out[0]), 'the command is accepted, not refused as reserved', out[0]);
  ok(/allows VLANs 1,100,1002-1005/.test(out[0]), 'the receipt names the list back', out[0]);
  ok(L.config() === 'switchport trunk allowed vlan 1,100,1002-1005',
    'and the backup prints it unchanged', L.config());
  const printed = L.config().replace(/^\s*switchport trunk allowed vlan\s+/, '');
  const before = JSON.stringify(L.allowed());
  L.put(printed);
  ok(JSON.stringify(L.allowed()) === before, 'retyping the printed line is a no-op, so a backup restores it');
}

console.log('');
console.log('And they cannot be removed, which is what the device documents:');
{
  const L = session();
  L.put('switchport trunk allowed vlan 1,100,1002-1005');
  const before = JSON.stringify(L.allowed());
  const out = L.put('switchport trunk allowed vlan remove 1002');
  ok(/^%/.test(out[0]), 'removing one is answered, not performed', out[0]);
  ok(/1002-1005/.test(out[0]) && /cannot be removed/.test(out[0]),
    'the sentence says why and names the block', out[0]);
  ok(JSON.stringify(L.allowed()) === before, 'the list is untouched', L.config());

  // A mixed list: the removable id comes off, the pinned one stays, and the receipt says both.
  L.put('switchport trunk allowed vlan 1,100,1002-1005,200');
  const mixed = L.put('switchport trunk allowed vlan remove 1,1002');
  ok(!/^%/.test(mixed[0]), 'a list naming one removable id and one pinned id is accepted', mixed[0]);
  ok(mixed[0].indexOf('(removed 1)') !== -1, 'the removable id comes off', mixed[0]);
  ok(/1002 stay/.test(mixed[0]), 'and the pinned one stays, in the same sentence', mixed[0]);
  ok(L.allowed().indexOf(1002) !== -1 && L.allowed().indexOf(100) !== -1 && L.allowed().indexOf(1) === -1,
    'which is what the stored list says', L.config());
}

console.log('');
console.log('A whole-id-space removal leaves only the media defaults, and is committed:');
{
  const L = session();
  const out = L.put('switchport trunk allowed vlan remove 1-4094');
  ok(!/^%/.test(out[0]), 'it is accepted rather than refused', out[0]);
  ok(/1002-1005/.test(out[0]) && /stay/.test(out[0]),
    'the sentence names the media defaults that cannot come off', out[0]);
  ok(JSON.stringify(L.allowed()) === JSON.stringify([1002, 1003, 1004, 1005]),
    'which is what the stored list says', JSON.stringify(L.allowed()));
  ok(L.config() === 'switchport trunk allowed vlan 1002-1005', 'and the backup prints it', L.config());

  const E = session();
  const excl = E.put('switchport trunk allowed vlan remove 1-1001,1006-4094');
  ok(!/^%/.test(excl[0]) && /1002-1005/.test(excl[0]),
    'removing every assignable id reaches the same list', excl[0]);
  ok(JSON.stringify(E.allowed()) === JSON.stringify([1002, 1003, 1004, 1005]),
    'and stores it', JSON.stringify(E.allowed()));
}

console.log('');
console.log('Every other door stays strict - the media defaults are not assignable:');
{
  const S = session();
  ok(/reserved/.test(S.put('switchport access vlan 1002')[0]), 'access VLAN 1002 is refused');
  ok(/reserved/.test(S.put('switchport trunk native vlan 1003')[0]), 'native VLAN 1003 is refused');
  ok(/reserved/.test(S.put('switchport voice vlan 1004')[0]), 'voice VLAN 1004 is refused');
  ok(vlanLib.parseVlanList(1002).error === 'E_VLAN_RESERVED',
    'and the parser is strict by default, so a new caller cannot inherit the allowed-list rule');
  ok(vlanLib.parseVlanList(1002, { keepReserved: true }).ok === true,
    'while the allowed-list caller asks for it explicitly');
  ok(vlanLib.validatePortConfig({ mode: 'access', accessVlan: 1002 }).ok === false,
    'a whole port config with an access VLAN of 1002 is still invalid');
  ok(vlanLib.validatePortConfig({ mode: 'trunk', allowedVlans: [1, 1002] }).ok === true,
    'while the same id in an allowed list is valid');
}

console.log('');
console.log('The data path is unchanged: no frame can be in one of those VLANs anyway:');
{
  const L = session();
  L.put('switchport trunk allowed vlan 1,100,1002-1005');
  const egress = vlanLib.classifyEgress(L.port(), 1002);
  ok(egress.action === 'drop',
    'a VLAN 1002 frame is still never forwarded (no Ethernet port can be in that VLAN)', JSON.stringify(egress));
  ok(vlanLib.classifyEgress(L.port(), 100).action === 'tagged', 'and VLAN 100 is still carried as a tag');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
