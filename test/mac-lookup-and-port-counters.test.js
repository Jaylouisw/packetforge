'use strict';
// mac-lookup-and-port-counters.test.js - the two questions an operator asks about a live switch, and
// the rule that decides whether a trailing number is a value or an instant.
//
//   SW1#show mac address-table address 001122334455
//   % show mac address-table takes one port, not "address 001122334455"
//
// "Which port is this hardware address behind" is the one question a MAC table exists for, and the
// family that takes keywords was told it takes only ports. Two spellings of the same view were missing
// with it: `show interfaces <port> counters` (IOS's form for the per-port half of a table this model
// already had) and an honest answer for `show interfaces accounting`, which read `accounting` as a port
// name and answered "No interface named accounting".
//
// Behind the MAC lookup was the sharper defect: an all-digit token after `address` was taken as a time
// instant, so the address was dropped from the line and the table was rebuilt "at t=1122334455 ms".
// A trailing number is a value when the word before it takes one; only then is it an instant.
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

// R1 - SW1 - PC1, one simulator for every session so the counters see the traffic.
function lab() {
  const t = new Topology();
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const pc = t.addDevice(find('generic-pc')); pc.name = 'PC1';
  const rp = Array.from(r.interfaces.values())[0];
  const swp = Array.from(sw.interfaces.values());
  const pp = Array.from(pc.interfaces.values())[0];
  t.connect(r.id, rp.name, sw.id, swp[0].name);
  t.connect(sw.id, swp[1].name, pc.id, pp.name);
  const sim = new Simulator(t);
  const rs = new CliSession(r, t, sim); rs.run('enable');
  rs.run('configure terminal'); rs.run('interface ' + rp.name);
  rs.run('ip address 10.0.0.1 255.255.255.0'); rs.run('end');
  const ps = new CliSession(pc, t, sim); ps.run('enable');
  ps.run('configure terminal'); ps.run('interface ' + pp.name);
  ps.run('ip address 10.0.0.2 255.255.255.0'); ps.run('end');
  const ss = new CliSession(sw, t, sim); ss.run('enable');
  return { t: t, sim: sim, rs: rs, ps: ps, ss: ss, sw: sw, rport: rp.name, swport: swp[0].name };
}
function learnedMac(session) {
  // The address the table actually learned - a switch entry is the *peer's* MAC, not the port's own.
  const out = text(session.run('show mac address-table'));
  const m = out.match(/([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i);
  return m ? m[1] : null;
}

console.log('Which port is this address behind:');
{
  const env = lab();
  const ping = text(env.rs.run('ping 10.0.0.2'));
  ok(/Success rate is 100 percent/.test(ping), 'the path works, so the switch has learned something');
  const learned = learnedMac(env.ss);
  ok(!!learned, 'the table learned a hardware address for the router (' + learned + ')');
  const mac = String(learned).replace(/:/g, '');
  const dotted = mac.slice(0, 4) + '.' + mac.slice(4, 8) + '.' + mac.slice(8);
  const table = text(env.ss.run('show mac address-table'));
  ok(new RegExp(dotted.replace(/\./g, '\\.'), 'i').test(table) ||
    new RegExp(mac.slice(0, 2) + ':' + mac.slice(2, 4), 'i').test(table),
    'the table lists it (' + mac + ')');

  for (const spelling of [dotted, mac, mac.replace(/(..)(?!$)/g, '$1:')]) {
    const out = text(env.ss.run('show mac address-table address ' + spelling));
    ok(/is behind/.test(out) && /Fa0\//.test(out), 'address ' + spelling + ' answers with the port');
    ok(!/rebuilt|at t=/.test(out), 'and is not read as an instant');
  }
  const notThere = text(env.ss.run('show mac address-table address deadbeef0000'));
  ok(/is not in the table/.test(notThere), 'an address that is not learned says so');
  ok(/appears only once traffic/.test(notThere), 'and says when an entry appears at all');
  const bad = text(env.ss.run('show mac address-table address zzzz'));
  ok(/needs a MAC address/.test(bad), 'a word that is not an address is refused as an address');
  ok(/0011\.2233\.4455/.test(bad) && /00:11:22:33:44:55/.test(bad) && /001122334455/.test(bad),
    'and the three spellings that work are named');
  const extra = text(env.ss.run('show mac address-table address ' + dotted + ' zzzz'));
  ok(/^%/.test(extra), 'a word after the address is refused');
}

console.log('\nA port\'s own counters:');
{
  const env = lab();
  env.rs.run('ping 10.0.0.2');
  const one = text(env.ss.run('show interfaces ' + env.swport + ' counters'));
  ok(/Interface counters on SW1 for Fa0\//.test(one), 'show interfaces <port> counters answers for one port');
  ok(/Rx packets/.test(one) && /Drops/.test(one), 'with the columns the family form prints');
  ok(/1 port counted/.test(one), 'and one total, not a device-wide sum');
  const family = text(env.ss.run('show interfaces counters'));
  ok(/port(s)? counted/.test(family), 'the family form still answers');
  // The two must agree about the port they both report.
  // The table row, not the heading above it - the heading names the port too.
  const row = one.split('\n').filter(function (l) { return /^\s*Fa0\//.test(l); })[0] || '';
  const nums = row.match(/\d+/g) || [];
  const famRow = family.split('\n').filter(function (l) { return /^\s*Fa0\//.test(l); })[0] || '';
  const famNums = famRow.match(/\d+/g) || [];
  ok(nums.join(',') === famNums.join(','), 'and the one-port row is the family row, unchanged');
  const errors = text(env.ss.run('show interfaces ' + env.swport + ' counters errors'));
  ok(/^%/.test(errors), 'counters errors is still refused, rather than read as a port');
}

console.log('\nViews this model does not keep say so, instead of naming a port:');
{
  const env = lab();
  for (const cmd of ['show interfaces accounting', 'show interfaces usage']) {
    const out = text(env.ss.run(cmd));
    ok(/^%/.test(out), cmd + ' is refused');
    ok(!/No interface named/.test(out), 'and is not answered as a port that does not exist');
  }
  const perPort = text(env.ss.run('show interfaces ' + env.swport + ' accounting'));
  ok(/No traffic accounting is kept per port/.test(perPort), 'the per-port spelling answers the same way');
}

console.log('\nA trailing number is the value of the word before it, or an instant:');
{
  const env = lab();
  env.rs.run('ping 10.0.0.2');
  // An instant still works where the view takes one.
  const at = text(env.ss.run('show mac address-table at 50'));
  ok(/at t=50 ms/.test(at), 'show mac address-table at 50 is still an instant');
  // And a value is not an instant, whatever it looks like.
  const values = [
    ['show mac address-table address ' + String(learnedMac(env.ss) || '').replace(/:/g, ''),
      /is (behind|not in the table)/],
    ['show mac address-table vlan 1', /Mac address table for VLAN 1/],
    ['show interfaces ' + env.swport + ' counters', /Interface counters/]
  ];
  for (const v of values) {
    const out = text(env.ss.run(v[0]));
    ok(v[1].test(out), v[0] + ' reads the number as its own argument');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
