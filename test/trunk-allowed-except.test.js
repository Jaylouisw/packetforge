'use strict';
// `switchport trunk allowed vlan except <list>` - the command's third verb, and the only one this console
// refused outright (#1746 follow-up).
//
//   s1(config-if)# switchport trunk allowed vlan except 5
//   % Unrecognized "except": this console takes a list (10,20), a range (10-20), "all", "add <list>" or "remove <list>"
//
// Two independent vendor surfaces give the command and the arithmetic:
//
//   * Catalyst 9300 17.12 command reference, `switchport trunk`, the vlan-list choices: "The vlan-list format
//     is all | none | [add | remove | except] vlan-atom [,vlan-atom...]" and, for the verb, "except lists the
//     VLANs that should be calculated by inverting the defined list of VLANs. (VLANs are added except the ones
//     specified.)" (research/trunk-allowed-except.md).
//   * The CCNPv7.1 SWITCH lab 3-1, whose transcript is the answer that inversion produces, measured on a
//     switch: `switchport trunk allowed vlan except 1,999` then `show interface trunk` prints
//     `Fa0/7   2-998,1000-4094` - one run, straight through the four media defaults.
//
// So `except` is not an edit like `add`/`remove`: it replaces the list with the inversion of what was named,
// over the id space a trunk's default list covers (1-4094), and the ids it took out are named in the answer the
// way a removal's are. The four media defaults are the one thing it cannot take out, for the same reason a
// removal cannot: a switch documents that 1002-1005 cannot be removed from a trunk
// (research/trunk-allowed-reserved-vlans.md).
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

// Every id a trunk's allowed list can hold: 1-4094, the four media defaults included.
const ASSIGNABLE = vlanLib.allVlansExcept([]);

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
    t: t, sim: sim, cli: cli, put: put,
    allowed: function () {
      const v = t.getDevice('s1').interfaces.get('Fa0/1').vlan;
      return v.allowedVlans === 'all' ? 'all' : v.allowedVlans.slice();
    },
    config: function () {
      cli.run('end');
      const out = cli.run('show running-config').output.filter(function (l) {
        return /switchport trunk allowed vlan/.test(l);
      })[0] || '';
      cli.run('configure terminal'); cli.run('interface Fa0/1');
      return out.trim();
    },
    sentence: function () {
      cli.run('end');
      const out = cli.run('show interfaces Fa0/1').output.filter(function (l) {
        return /switchport:/.test(l);
      })[0] || '';
      cli.run('configure terminal'); cli.run('interface Fa0/1');
      return out.trim();
    }
  };
}

// A stored allowed list is an array, or the word `all`; both compare as the ids they stand for.
function same(a, b) {
  const norm = function (x) { return JSON.stringify(x === 'all' ? ASSIGNABLE : x); };
  return norm(a) === norm(b);
}

console.log('');
console.log('The verb is accepted, and answers with the inversion the device prints:');
{
  const L = session();
  const out = L.put('switchport trunk allowed vlan except 1,999');
  ok(!/Unrecognized/.test(out[0]), '`except` is a form of the command, not a word it does not know', out[0]);
  ok(/^Trunk on Fa0\/1 allows VLANs 2-998,1000-4094/.test(out[0]),
    'the answer is the CCNP lab\'s list, printed the way a switch prints one', out[0]);
  ok(same(L.allowed(), vlanLib.allVlansExcept([1, 999])),
    'and the port carries exactly those ids', String(L.allowed().length));
  ok([1002, 1003, 1004, 1005].every(function (v) { return L.allowed().indexOf(v) !== -1; }),
    'the run passes through the four media defaults', '1002-1005');
  ok(/allowed 2-998,1000-4094$/.test(L.sentence()),
    '`show interfaces` agrees with the answer', L.sentence());
}

console.log('');
console.log('It is a replacement, not a subtraction: the universe is 1-4094, not the list the port has now:');
{
  const L = session();
  L.put('switchport trunk allowed vlan 10');
  const out = L.put('switchport trunk allowed vlan except 5');
  ok(/1-4,6-4094/.test(out[0]), '`except 5` on a port allowing only 10 leaves everything but 5', out[0]);
  ok(L.allowed().indexOf(10) !== -1, 'VLAN 10 is back in the list: the named set is what is inverted', '10');
  ok(L.allowed().indexOf(5) === -1, 'and 5 is the one that is gone');
  ok(L.allowed().length === ASSIGNABLE.length - 1, 'the list holds every id but one',
    L.allowed().length + ' of ' + (ASSIGNABLE.length - 1));
}

console.log('');
console.log('The three views of the port agree, and the printed line types back in unchanged:');
{
  const L = session();
  L.put('switchport trunk allowed vlan except 5-10,12');
  const line = L.config();
  ok(/^switchport trunk allowed vlan 1-4,11,13-4094$/.test(line),
    'the backup writes the list the port carries, folded into ranges', line);
  const before = L.allowed().slice();
  const again = L.put(line);
  ok(!/^%/.test(again[0]), 'the line the backup printed is accepted when typed back', again[0]);
  ok(same(L.allowed(), before), 'and leaves the list exactly as it was', String(L.allowed().length));
}

console.log('');
console.log('A list that names the media defaults is answered, not performed:');
{
  const L = session();
  const before = L.allowed();
  const out = L.put('switchport trunk allowed vlan except 1002');
  ok(/^%/.test(out[0]), 'the command is refused', out[0]);
  ok(/1002/.test(out[0]) && /cannot be removed/.test(out[0]),
    'and the sentence is the rule a named removal gets', out[0]);
  ok(same(L.allowed(), before), 'the list is untouched', JSON.stringify(L.allowed()));

  // `except 1-4094` names the whole space, so the inversion leaves the four media defaults - the same list
  // `remove 1-4094` leaves, and a state `switchport trunk allowed vlan none` can store. The line is committed.
  const full = L.put('switchport trunk allowed vlan except 1-4094');
  ok(!/^%/.test(full[0]), 'the whole id space is accepted', full[0]);
  ok(/1002-1005/.test(full[0]), 'and the answer names the four media defaults that remain', full[0]);
  ok(JSON.stringify(L.allowed()) === JSON.stringify([1002, 1003, 1004, 1005]),
    'which is what the stored list is', JSON.stringify(L.allowed()));
}

console.log('');
console.log('The word after the verb is still read as a word:');
{
  const L = session();
  const bare = L.put('switchport trunk allowed vlan except');
  ok(/Incomplete command: switchport trunk allowed vlan except <list>/.test(bare[0]),
    'a verb with no list says what is missing', bare[0]);
  const word = L.put('switchport trunk allowed vlan except banana');
  ok(/cannot parse VLAN token "banana"/.test(word[0]),
    'a word where the list belongs gets the parser\'s message about that word', word[0]);
  ok(!/Unrecognized "except"/.test(word[0]), 'not a refusal of the verb', word[0]);
  const spaced = L.put('switchport trunk allowed vlan except 5 - 10, 12');
  ok(/all but 5-10,12/.test(spaced[0]), 'spaces around a range still parse', spaced[0]);
  const all = L.put('switchport trunk allowed vlan all');
  ok(/allows all VLANs/.test(all[0]), 'and `all` still restores the default', all[0]);
  ok(L.allowed() === 'all', 'as the stored value, not a 4,094-id array', JSON.stringify(L.allowed()));
}

console.log('');
console.log('A port that is not a trunk yet still stores the list, and says so:');
{
  const L = session();
  L.put('switchport mode access');
  const out = L.put('switchport trunk allowed vlan except 5');
  ok(/all but 5/.test(out[0]), 'the inversion is performed', out[0]);
  ok(/stored; the port is in access mode/.test(out[0]), 'with the mode note the other forms carry', out[0]);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
