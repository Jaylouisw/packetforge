'use strict';
// vlan-summary.test.js - the count view, and the rule that a summary is counted from the table.
//
//   SW1#show vlan summary
//   % Invalid VLAN id "summary" - ids are numbers 1-4094
//
// `summary` is the word an operator types before deciding whether a VLAN is missing, and the console
// read it as a VLAN id. It counts now, and every number is derived from the rows `show vlan` prints -
// so the two cannot disagree about how many VLANs exist. That is not a formality here: `show vlan`
// once described an active VLAN the configuration did not have, and a summary computed from a second
// derivation would have been free to make the same claim twice.
//
// The model keeps three states and the summary names all three, because they need different fixes:
// declared (`vlan <id>`, or created by a carrier that names it), carried by a port, and allowed on a
// trunk only (a filter, not a bridge domain).
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
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const pc = t.addDevice(find('generic-pc')); pc.name = 'PC1';
  const ports = Array.from(sw.interfaces.values());
  const pp = Array.from(pc.interfaces.values())[0];
  t.connect(sw.id, ports[1].name, pc.id, pp.name);
  const sim = new Simulator(t);
  const s = new CliSession(sw, t, sim); s.run('enable');
  return { t: t, s: s, ports: ports };
}
function num(out, label) {
  const line = String(out).split('\n').filter(function (l) { return l.indexOf(label) !== -1; })[0] || '';
  const m = line.match(/:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

console.log('The count view answers:');
{
  const env = lab();
  env.s.run('configure terminal');
  env.s.run('vlan 10');
  env.s.run('vlan 20');
  env.s.run('interface ' + env.ports[1].name);
  env.s.run('switchport access vlan 10');
  env.s.run('end');
  const out = text(env.s.run('show vlan summary'));
  ok(/^VLAN summary on SW1/.test(out), 'show vlan summary answers, naming the device');
  ok(!/^%/m.test(out), 'and is not a refusal');
  ok(num(out, 'Existing VLANs') === 3, 'three VLANs exist (1, 10, 20): ' + num(out, 'Existing VLANs'));
  ok(num(out, 'Declared') === 2, 'two were declared (10, 20): ' + num(out, 'Declared'));
  ok(/\(10, 20\)/.test(out), 'and the declared ids are named');
  // VLAN 1 has the ports nobody moved and VLAN 10 has Fa0/2; VLAN 20 is declared with no port in it,
  // which is a different state and is counted separately.
  ok(num(out, 'Carried by a port') === 2, 'two VLANs have a port in them (1 and 10)');
  ok(num(out, 'SVIs') === 0, 'and no SVI exists here');
  ok(num(out, 'Ports in a VLAN') === 8, 'eight ports are in some VLAN');
}

console.log('\nThe summary is counted from the table it summarises:');
{
  const env = lab();
  env.s.run('configure terminal');
  env.s.run('vlan 30');
  env.s.run('interface ' + env.ports[2].name);
  env.s.run('switchport mode trunk');
  env.s.run('switchport trunk allowed vlan 30,40');
  env.s.run('end');
  const table = text(env.s.run('show vlan brief'));
  const rows = table.split('\n').filter(function (l) { return /^\d+\s+\S+\s+active/.test(l); }).length;
  const summary = text(env.s.run('show vlan summary'));
  ok(rows === num(summary, 'Existing VLANs'),
    'the row count and the summary agree (' + rows + ')');
  ok(num(summary, 'Allowed on a trunk only') === 1,
    'VLAN 40 is allowed on the trunk and is not a VLAN here');
  ok(/not configured, so not a VLAN/.test(summary), 'and the summary says why it is counted separately');
  ok(!/^40\s/m.test(table), 'and the table does not list it as a VLAN');
}

console.log('\nOn a device that does not bridge:');
{
  const t = new Topology();
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  const s = new CliSession(r, t, new Simulator(t)); s.run('enable');
  s.run('configure terminal'); s.run('vlan 10'); s.run('vlan 20'); s.run('end');
  const out = text(s.run('show vlan summary'));
  ok(/VLAN summary on R1/.test(out), 'a router counts the VLANs it declares');
  ok(num(out, 'Declared') === 2, 'two declared');
  ok(/Ports in a VLAN\s*: 0/.test(out), 'and no port is in one, because it does not bridge');
  ok(!/VLAN 1 created|VLAN0001/.test(out), 'no fabricated VLAN 1');
}

console.log('\nThe word that is not IOS is answered by naming the one that is:');
{
  const env = lab();
  const count = text(env.s.run('show vlan count'));
  ok(/VLAN summary on SW1/.test(count), 'show vlan count still answers');
  ok(/IOS word - the spelling is "show vlan summary"/.test(count), 'and names the spelling IOS uses');
  const extra = text(env.s.run('show vlan summary zzzz'));
  ok(/^%/.test(extra), 'a word after summary is refused');
  ok(/takes no more/.test(extra), 'and says the command takes nothing else');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
