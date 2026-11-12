'use strict';
// `switchport trunk allowed vlan add 30` refused a word nobody typed (#1455).
//
// The branch glued the tokens after `switchport trunk allowed vlan` together with no separator, so that `10, 20` and
// `40 - 42` typed with spaces would still parse. It also ate the verbs IOS puts in front of a list to edit the one
// already there:
//
//   s1(config-if)# switchport trunk allowed vlan add 30
//   % cannot parse VLAN token "add30"        <- not a token anybody typed
//
// The refusal quoted a token the operator had never entered, and the only way to add a VLAN was to retype the whole
// list from memory - which is exactly the mistake the add/remove forms exist to prevent. Editing a trunk's allowed
// list is an existing mechanism with an existing command; `add` and `remove` are that command's other two forms.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
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
    portLine: function () {
      cli.run('end');
      const out = cli.run('show interfaces Fa0/1').output.filter(function (l) {
        return /switchport:/.test(l);
      })[0] || '';
      cli.run('configure terminal'); cli.run('interface Fa0/1');
      return out.trim();
    }
  };
}

console.log('');
console.log('The verbs IOS puts in front of the list reach the list:');
{
  const L = session();
  L.put('switchport trunk allowed vlan 10,20');
  ok(JSON.stringify(L.allowed()) === '[10,20]', 'the list starts at 10,20', JSON.stringify(L.allowed()));

  const add = L.put('switchport trunk allowed vlan add 30');
  ok(!/cannot parse/.test(add.join(' ')), '`add 30` is not refused any more', add.join(' | '));
  ok(/added 30/.test(add[0]), 'and says what it added', add[0]);
  ok(JSON.stringify(L.allowed()) === '[10,20,30]', 'the list is the union', JSON.stringify(L.allowed()));

  const rem = L.put('switchport trunk allowed vlan remove 10');
  ok(!/cannot parse/.test(rem.join(' ')), '`remove 10` is not refused either', rem.join(' | '));
  ok(/removed 10/.test(rem[0]), 'and says what it took out', rem[0]);
  ok(JSON.stringify(L.allowed()) === '[20,30]', 'the list is the difference', JSON.stringify(L.allowed()));
}

console.log('');
console.log('The three views of the same list agree after an edit:');
{
  const L = session();
  L.put('switchport trunk allowed vlan 10,20');
  L.put('switchport trunk allowed vlan add 30');
  ok(L.config() === 'switchport trunk allowed vlan 10,20,30', 'the running-config prints the new list', L.config());
  ok(/allowed 10,20,30/.test(L.portLine()), 'the port line prints it too', L.portLine());
  ok(JSON.stringify(L.allowed()) === '[10,20,30]', 'and the engine holds it', JSON.stringify(L.allowed()));
  // `show vlan brief` membership is read from the same rule the data plane forwards by, so it must list them all.
  L.cli.run('end');
  const brief = L.cli.run('show vlan brief').output.join('\n');
  ['10', '20', '30'].forEach(function (id) {
    const row = brief.split('\n').filter(function (l) { return new RegExp('^' + id + '\\s').test(l); })[0] || '';
    ok(/Fa0\/1/.test(row), 'VLAN ' + id + ' lists Fa0/1 as a member', row);
  });
}

console.log('');
console.log('The list is printed back in a form the console can read again:');
{
  const L = session();
  L.put('switchport trunk allowed vlan 10,20');
  L.put('switchport trunk allowed vlan add 40-42');
  const printed = L.config();
  const line = printed.replace(/^\s*switchport trunk allowed vlan\s+/, '');
  const before = JSON.stringify(L.allowed());
  L.put('switchport trunk allowed vlan ' + line);
  ok(JSON.stringify(L.allowed()) === before, 'retyping the printed line is a no-op',
    line + ' -> ' + JSON.stringify(L.allowed()));
}

console.log('');
console.log('Edits that change nothing say so instead of pretending:');
{
  const L = session();
  L.put('switchport trunk allowed vlan 10,20');
  const dup = L.put('switchport trunk allowed vlan add 10');
  ok(/already allows VLANs 10/.test(dup[0]), 'adding a VLAN already allowed is named', dup[0]);
  ok(/unchanged/.test(dup[0]), 'and says the list did not move', dup[0]);
  ok(JSON.stringify(L.allowed()) === '[10,20]', 'the list is still 10,20', JSON.stringify(L.allowed()));

  const missing = L.put('switchport trunk allowed vlan remove 99');
  ok(/^%/.test(missing[0]), 'removing a VLAN that was never allowed is refused', missing[0]);
  ok(/not allowed on Fa0\/1/.test(missing[0]) && /unchanged/.test(missing[0]),
    'with a sentence that says why and what the list still is', missing[0]);
  ok(JSON.stringify(L.allowed()) === '[10,20]', 'and the list is untouched', JSON.stringify(L.allowed()));
}

console.log('');
console.log('The two footguns are refused, not committed:');
{
  const L = session();
  L.put('switchport trunk allowed vlan 10,20');
  const empty = L.put('switchport trunk allowed vlan remove 10,20');
  ok(/^%/.test(empty[0]), 'removing every VLAN is refused', empty[0]);
  ok(/no VLANs/.test(empty[0]) && /no switchport trunk allowed vlan/.test(empty[0]),
    'naming both ways out of the situation', empty[0]);
  ok(JSON.stringify(L.allowed()) === '[10,20]', 'and the trunk is left as it was', JSON.stringify(L.allowed()));

  const all = session();       // a trunk with no list: it allows all
  ok(all.allowed() === 'all', 'a fresh trunk allows all VLANs', JSON.stringify(all.allowed()));
  const addToAll = all.put('switchport trunk allowed vlan add 30');
  ok(/already allows all VLANs/.test(addToAll[0]), 'adding to "all" changes nothing and says so', addToAll[0]);
  ok(all.allowed() === 'all', 'and does not explode into 4,094 ids', JSON.stringify(all.allowed()));
  const remFromAll = all.put('switchport trunk allowed vlan remove 10');
  ok(/^%/.test(remFromAll[0]) && /name the list/.test(remFromAll[0]),
    'removing from "all" points at the form that says what is wanted', remFromAll[0]);
  ok(all.allowed() === 'all', 'and leaves the port alone', JSON.stringify(all.allowed()));
}

console.log('');
console.log('A word that is not a verb or a list is named as a word:');
{
  const L = session();
  const out = L.put('switchport trunk allowed vlan except 20');
  ok(/Unrecognized "except"/.test(out[0]), 'the refusal quotes the word that was typed', out[0]);
  ok(out[0].indexOf('except20') === -1, 'and never the glued token', out[0]);
  ['add', 'remove', 'all'].forEach(function (form) {
    ok(out[0].indexOf('"' + form), 'it lists the accepted form `' + form + '`', out[0]);
  });
  const bare = L.put('switchport trunk allowed vlan add');
  ok(/Incomplete command/.test(bare[0]) && /add <list>/.test(bare[0]),
    'a verb with no list says what is missing', bare[0]);
  const junk = L.put('switchport trunk allowed vlan 10,abc');
  ok(/^%/.test(junk[0]) || /Invalid|invalid/.test(junk[0]),
    'a malformed numeric list is still a plain refusal', junk[0]);
}

console.log('');
console.log('What already worked still works, word for word:');
{
  const L = session();
  ok(JSON.stringify(L.put('switchport trunk allowed vlan 10, 20')) === JSON.stringify(['Trunk on Fa0/1 allows VLANs 10,20']),
    'a list with spaces after the commas parses', JSON.stringify(L.put('switchport trunk allowed vlan 10, 20')));
  ok(JSON.stringify(L.allowed()) === '[10,20]', 'to 10,20', JSON.stringify(L.allowed()));
  const range = L.put('switchport trunk allowed vlan 40 - 42');
  ok(/40,41,42/.test(range[0]), 'a spaced range still expands', range[0]);
  const all = L.put('switchport trunk allowed vlan all');
  ok(/allows all VLANs/.test(all[0]), '`all` is still accepted', all[0]);
  ok(L.allowed() === 'all', 'and means all', JSON.stringify(L.allowed()));
  // In config-if, where the command lives (the console is at exec level after the helper's last `end`). A list has to
  // be set for the removal to have anything to restore.
  L.cli.run('configure terminal'); L.cli.run('interface Fa0/1');
  L.put('switchport trunk allowed vlan 10,20');
  const restored = L.cli.run('no switchport trunk allowed vlan').output;
  ok(/all VLANs again/.test(restored.join(' ')), 'and `no switchport trunk allowed vlan` restores it',
    restored.join(' | '));
  const empty = L.put('switchport trunk allowed vlan');
  ok(/Incomplete command/.test(empty[0]), 'the bare command is still incomplete', empty[0]);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
