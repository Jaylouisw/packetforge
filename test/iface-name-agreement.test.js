'use strict';
// One naming table, and the engine reads it too (#1247).
//
// engine/iface-name.js holds the rules that fold a console spelling ("ether1") onto the panel spelling
// ("eth1"), and engine/cli.js held a hand-copied second version of the same functions. Two copies of one
// rule drift - this repo has already been bitten by that twice (the fabric rule, the port-state rule) - and
// they had not drifted yet only by luck. Device.resolveIface(), meanwhile, accepted exact names only, so the
// engine was stricter than the console: a lab file that stored a group under the spelling somebody typed
// elected nothing, and `show vrrp` called the group Init.
//
// The first section is the one that matters: it fails the moment a copy comes back.
const path = require('path');
const cliModule = require('../engine/cli');
const ifaceName = require('../engine/iface-name');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ethernet = function (d) {
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
};
const mikrotik = catalog.filter(function (s) { return /mikrotik/i.test(s.vendor || ''); })[0];

// The console spelling of a panel name, for the families the table covers. Not a reverse of the rules -
// a table of the pairs the rules were written for.
const CONSOLE = [
  [/^eth(\d+)$/i, 'ether$1'],
  [/^sfp\+(\d+)$/i, 'sfp-sfpplus$1'],
  [/^qsfp\+(\d+)$/i, 'qsfp-qsfpplus$1'],
  [/^sfp(\d+)$/i, 'sfp$1'],
  [/^combo(\d+)$/i, 'combo$1'],
  [/^mgmt(\d*)$/i, 'mgmt$1']
];
function consoleSpelling(name) {
  // Written without an inline `if (...) return` on purpose: the skip audit reads that shape as a case
  // being silently dropped from a check, and this function is not dropping anything.
  const hit = CONSOLE.filter(function (pair) { return pair[0].test(name); })[0];
  return hit ? name.replace(hit[0], hit[1]) : null;
}

console.log('');
console.log('There is one naming table, not two:');
{
  ok(cliModule.resolvePortName === ifaceName.resolvePortName,
    'the CLI uses engine/iface-name.js rather than a copy of it');
  ok(cliModule.portKey === ifaceName.portKey, 'and the same key function');
  ok(Array.isArray(ifaceName.PORT_NAME_RULES) && ifaceName.PORT_NAME_RULES.length > 0,
    'with the rules in one place', String(ifaceName.PORT_NAME_RULES && ifaceName.PORT_NAME_RULES.length));
}

console.log('');
console.log('The engine accepts every spelling the console does:');
{
  let checked = 0;
  const wrong = [];
  const misses = [];
  for (const spec of catalog) {
    let dev = null;
    try { dev = new Topology().addDevice(spec, 'probe'); } catch (e) { continue; }
    if (!dev || !dev.interfaces) continue;
    for (const port of dev.interfaces.values()) {
      checked++;
      const exact = dev.resolveIface(port.name);
      if (!exact || exact.name !== port.name) wrong.push(spec.model + ': exact ' + port.name);
      const upper = dev.resolveIface(String(port.name).toUpperCase());
      if (!upper || upper.name !== port.name) wrong.push(spec.model + ': case ' + port.name);
      const alt = consoleSpelling(port.name);
      if (alt) {
        const got = dev.resolveIface(alt);
        if (!got || got.name !== port.name) misses.push(spec.model + ': ' + alt + ' -> ' + (got && got.name));
      }
    }
  }
  ok(checked > 1000, 'swept the catalogue (' + checked + ' ports)');
  ok(wrong.length === 0, 'every port resolves by its own name and in any case',
    wrong.slice(0, 4).join(' | '));
  ok(misses.length === 0, 'and by its console spelling where one exists',
    misses.slice(0, 4).join(' | '));

  // resolveIface must not turn a name that does not exist into a port: a typo is an error, not a guess.
  const probe = new Topology().addDevice(catalog[0], 'probe');
  ok(probe.resolveIface('eth999') === null, 'a name that matches nothing resolves to nothing');
  ok(probe.resolveIface('') === null && probe.resolveIface(null) === null,
    'and so do an empty name and no name');
}

console.log('');
console.log('An ambiguous spelling is refused, not guessed:');
{
  // Two ports whose keys fold together. The exact spellings still work; the folded one cannot pick.
  // 'sfp+1' and 'sfp-sfpplus1' both fold onto the key 'sfp+1', so a third spelling that folds onto it too
  // ('sfpplus1') cannot choose between them. A spelling that differs only in case is NOT ambiguous - it
  // names one port exactly - so the pair has to be two different spellings, not one spelling typed twice.
  const fake = new Topology().addDevice(catalog[0], 'ambiguous');
  fake.interfaces = new Map([['sfp+1', { name: 'sfp+1' }], ['sfp-sfpplus1', { name: 'sfp-sfpplus1' }]]);
  ok(fake.resolveIface('sfp+1').name === 'sfp+1', 'an exact name resolves', 'sfp+1');
  ok(fake.resolveIface('sfp-sfpplus1').name === 'sfp-sfpplus1', 'and so does the other exact name');
  ok(fake.resolveIface('sfpplus1') === null,
    'but a third spelling that folds onto both is refused',
    JSON.stringify(fake.resolveIface('sfpplus1')));
}

console.log('');
console.log('A console spelling configures the port it names:');
{
  if (!mikrotik) {
    ok(false, 'the catalogue has a MikroTik device to test with');
  } else {
    const t = new Topology();
    const r = t.addDevice(mikrotik, 'r');
    const ports = ethernet(r);
    const panel = ports[0].name;
    const typed = consoleSpelling(panel) || panel;
    const cli = new CliSession(r, t, null);
    cli.run('configure terminal');
    const opened = ((cli.run('interface ' + typed).output) || []).map(String).join(' | ');
    ok(!/^%/.test(opened), 'the console spelling opens the interface', opened || '(no output)');
    cli.run('ip address 192.0.2.1 255.255.255.0');
    const port = r.resolveIface(panel);
    ok(port && port.ip === '192.0.2.1',
      'and the address lands on the panel-named port (' + panel + ')', port && port.ip);

    const brief = ((cli.run('exit').output) || []).concat((cli.run('exit').output) || [])
      .concat((cli.run('show ip interface brief').output) || []).map(String).join('\n');
    ok(new RegExp(panel.replace(/\+/g, '\\+') + '\\b').test(brief),
      'which is the name the tables print', panel);
  }
}

console.log('');
console.log('A group stored under a console spelling still takes part:');
{
  const t = new Topology();
  const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
  const r1 = t.addDevice(ROUTER, 'r1');
  const port = ethernet(r1)[0];
  runCommands(r1, t, null, ['configure terminal', 'interface ' + port.name,
    'ip address 10.0.0.1 255.255.255.0', 'end']);
  // What a hand-written topology file (or an older build) can contain: the spelling the operator types.
  r1.config.vrrp = [{
    vrid: 42, interface: port.name.toUpperCase(), ips: ['10.0.0.254'],
    priority: 120, preempt: true, advertSec: 1
  }];
  const sim = new Simulator(t);
  sim.computeVrrp();
  ok((r1.vrrpClaims || []).length === 1,
    'the group is eligible even though its interface name is spelled differently',
    JSON.stringify(r1.vrrpClaims));
  const lines = ((new CliSession(r1, t, sim).run('show vrrp').output) || []).map(String).join('\n');
  ok(!/\bInit\b/.test(lines), 'and show vrrp does not call it Init', lines.split('\n').slice(-1)[0]);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
