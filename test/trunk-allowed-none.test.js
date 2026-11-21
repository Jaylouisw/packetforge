'use strict';
// `switchport trunk allowed vlan none` - the command's second single-word list, and the one this console
// refused as an unknown word (#fidelity).
//
//   s1(config-if)# switchport trunk allowed vlan none
//   % Unrecognized "none": this console takes a list (10,20), a range (10-20), "all", "add <list>", "except
//     <list>" or "remove <list>"
//
// The box takes it. The vlan-list form is `all | none | [add | remove | except] vlan-atom` and "none
// specifies an empty list" (Catalyst 9300 17.13 command reference, `switchport trunk`, Usage Guidelines), the
// keyword stands in the syntax line of every IOS 15.x/16.x/17.x trunk guide, and a box's own `?` help prints
// `none  no VLANs`. The 12.2 SE book for the 2960 predates the word - `{add | all | except | remove}` - so it
// belongs to the later images this console's switchport grammar follows (research/trunk-allowed-vlan-none.md).
//
// The state it produces is the one every view here already had a word for: an empty allowed list is printed
// `allowed none`, drops every VLAN in `classifyEgress()`, and is what the removal refusals in this console
// called a "dead trunk". It is a state an operator asks for - it stops normal VLAN traffic on a link without
// shutting the port - so the command is accepted and the running-config prints the word back.
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

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });

function session(port) {
  const t = new Topology();
  t.addDevice(SWITCH, 's1');
  const sim = new Simulator(t);
  const cli = new CliSession(t.getDevice('s1'), t, sim);
  const name = port || 'Fa0/1';
  cli.run('configure terminal');
  cli.run('interface ' + name);
  const put = function (cmd) { return cli.run(cmd).output; };
  put('switchport mode trunk');
  return {
    t: t, sim: sim, cli: cli, put: put, name: name,
    iface: function () { return t.getDevice('s1').interfaces.get(name); },
    allowed: function () {
      const v = this.iface().vlan.allowedVlans;
      return v === 'all' ? 'all' : v.slice();
    },
    configLines: function () {
      cli.run('end');
      const out = cli.run('show running-config').output.filter(function (l) {
        return /switchport .*(trunk|mode)/.test(l);
      }).map(function (l) { return l.trim(); });
      cli.run('configure terminal'); cli.run('interface ' + name);
      return out;
    },
    sentence: function () {
      cli.run('end');
      const out = cli.run('show interfaces ' + name).output.filter(function (l) {
        return /switchport:/.test(l);
      })[0] || '';
      cli.run('configure terminal'); cli.run('interface ' + name);
      return out.trim();
    }
  };
}

console.log('');
console.log('The word is accepted and stores the empty list the box means by it:');
{
  const L = session();
  const out = L.put('switchport trunk allowed vlan none');
  ok(!/^%/.test(out[0]), 'the command is accepted, not refused', out[0]);
  ok(/allows no VLANs/.test(out[0]), 'the answer says what the port now carries', out[0]);
  const after = L.allowed();
  ok(Array.isArray(after) && after.length === 0, 'and the stored list is empty, not "all"',
    JSON.stringify(after));
}

console.log('');
console.log('Every view of the port agrees about it:');
{
  const L = session();
  L.put('switchport trunk allowed vlan none');
  ok(/allowed none/.test(L.sentence()), '`show interfaces` prints `allowed none`', L.sentence());
  const lines = L.configLines();
  ok(lines.indexOf('switchport trunk allowed vlan none') !== -1,
    '`show running-config` prints the line an operator typed', lines.join(' | '));
  ok(lines.indexOf('switchport allowed vlan none') === -1, 'in the trunk spelling, not as an access word',
    lines.join(' | '));
  // A box prints the VLAN parameters before the mode they select (the order two Cisco-published samples
  // settle, research/running-config-switchport-order.md), and `none` is one of those parameters.
  const iAllowed = lines.indexOf('switchport trunk allowed vlan none');
  const iMode = lines.indexOf('switchport mode trunk');
  ok(iAllowed !== -1 && iMode !== -1 && iAllowed < iMode, 'the allowed line comes before the mode line',
    lines.join(' | '));
  // What the console writes has to be what it reads: the backup is replayed into a fresh session.
  const R = session();
  const replay = R.put('switchport trunk allowed vlan none');
  ok(!/^%/.test(replay[0]), 'and the printed line parses back on a second box', replay[0]);
  ok(R.allowed().length === 0, 'restoring the state the backup described', JSON.stringify(R.allowed()));
}

console.log('');
console.log('It is a list like any other, so the editing verbs still work from it:');
{
  const L = session();
  L.put('switchport trunk allowed vlan none');
  const added = L.put('switchport trunk allowed vlan add 10');
  ok(!/^%/.test(added[0]), '`add 10` is accepted on a trunk carrying nothing', added[0]);
  ok(JSON.stringify(L.allowed()) === '[10]', 'and leaves exactly that VLAN', JSON.stringify(L.allowed()));
  const replaced = L.put('switchport trunk allowed vlan 20,30');
  ok(JSON.stringify(L.allowed()) === '[20,30]', 'a list replaces it', JSON.stringify(L.allowed()));
  L.put('switchport trunk allowed vlan none');
  ok(JSON.stringify(L.allowed()) === '[]', 'and `none` replaces a list', JSON.stringify(L.allowed()));
  const restored = L.put('no switchport trunk allowed vlan');
  ok(!/^%/.test(restored[0]), '`no` is accepted', restored[0]);
  ok(L.allowed() === 'all', 'and restores the default `all`', JSON.stringify(L.allowed()));
  ok(L.configLines().indexOf('switchport trunk allowed vlan none') === -1,
    'so the line leaves the running-config again', L.configLines().join(' | '));
}

console.log('');
console.log('A trunk allowed nothing carries nothing, and the engine already said so:');
{
  const cfg = { mode: 'trunk', nativeVlan: 1, allowedVlans: [] };
  ok(vlanLib.classifyEgress(cfg, 10).action === 'drop', 'a tagged frame in VLAN 10 is dropped');
  ok(vlanLib.classifyEgress(cfg, 1).action === 'drop',
    'and so is an untagged frame in the native VLAN', JSON.stringify(vlanLib.classifyEgress(cfg, 1)));
  ok(vlanLib.switchportSentence(cfg).indexOf('allowed none') !== -1,
    'the sentence every switchport view reads prints `none`', vlanLib.switchportSentence(cfg));
}

console.log('');
console.log('The word is one the refusal names, and the empty array is not read as "unset":');
{
  const L = session();
  const bad = L.put('switchport trunk allowed vlan flurbish');
  ok(/^%/.test(bad[0]) && /"none"/.test(bad[0]), 'a bad word is refused with `none` in the list of words taken',
    bad[0]);
  // An access port normalises an unset allowed list to the empty array, and `switchport reset` leaves one
  // behind: neither is a configuration, so neither may print a `switchport trunk allowed vlan none` line.
  const A = session('Fa0/2');
  A.put('switchport mode access');
  A.put('switchport reset');
  ok(A.configLines().indexOf('switchport trunk allowed vlan none') === -1,
    'an access port reset to its defaults prints no allowed-vlan line', A.configLines().join(' | '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
