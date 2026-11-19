'use strict';
// `show ip interface brief` Method for a port with no address is `unset`, not `manual`.
//
// The table prints `manual` beside an address the operator configured. On a factory port there is no address
// and no method, and Cisco's own field list has a value for that: `unset - Unset`. Its sample output pairs
// `unassigned  YES unset` on the same line. Printing `manual` there claimed a configuration nobody typed.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }

function session(model) {
  const t = new Topology();
  const d = t.addDevice(spec(model), 'd1');
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  return {
    d: d,
    s: s,
    say: function (c) { return ((s.run(c).output) || []).map(String); },
    row: function (port) {
      return this.say('show ip interface brief').filter(function (l) {
        return l.split(/\s+/)[0] === port;
      })[0] || '';
    }
  };
}

console.log('');
console.log('A port with no address has no method:');
{
  const env = session('generic-router');
  const row = env.row('GigabitEthernet0/0');
  ok(/^GigabitEthernet0\/0\s+unassigned\s+YES\s+unset(\s|$)/.test(row),
    'a factory port reads `unassigned  YES unset`', row);
  ok(!/\bmanual\b/.test(row), 'and never claims a method nobody configured', row);
}

console.log('');
console.log('The method changes with the configuration, and back:');
{
  const env = session('generic-router');
  env.s.run('configure terminal');
  env.s.run('interface Gi0/0');
  env.s.run('ip address 10.0.0.1 255.255.255.0');
  env.s.run('end');
  // The address cell is the bare address: IOS never prints the mask in this table (see
  // test/interface-brief-address-cell.test.js).
  ok(/^GigabitEthernet0\/0\s+10\.0\.0\.1\s+YES\s+manual(\s|$)/.test(env.row('GigabitEthernet0/0')),
    'a static address is `manual`', env.row('GigabitEthernet0/0'));

  env.s.run('configure terminal');
  env.s.run('interface Gi0/0');
  env.s.run('ip address dhcp');
  env.s.run('end');
  ok(/^GigabitEthernet0\/0\s+unassigned\s+YES\s+DHCP(\s|$)/.test(env.row('GigabitEthernet0/0')),
    'a DHCP client is `DHCP`, even before it has a lease', env.row('GigabitEthernet0/0'));

  env.s.run('configure terminal');
  env.s.run('interface Gi0/0');
  env.s.run('no ip address');
  env.s.run('end');
  ok(/^GigabitEthernet0\/0\s+unassigned\s+YES\s+unset(\s|$)/.test(env.row('GigabitEthernet0/0')),
    'and removing the address removes the method with it', env.row('GigabitEthernet0/0'));
}

console.log('');
console.log('Every factory port of a switch, not just the one that was typed into:');
{
  const env = session('generic-switch');
  const rows = env.say('show ip interface brief').filter(function (l) { return /^Fa/.test(l); });
  const wrong = rows.filter(function (l) { return /\bmanual\b/.test(l); });
  ok(rows.length > 0, 'the switch lists its ports', String(rows.length));
  ok(wrong.length === 0, 'none of them claims `manual` without an address', JSON.stringify(wrong.slice(0, 2)));
  ok(rows.every(function (l) { return /\bunset\b/.test(l); }), 'all of them say `unset`', JSON.stringify(rows.slice(0, 2)));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
