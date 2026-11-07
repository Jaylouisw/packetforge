'use strict';
// ===========================================================================
// test/mikrotik-naming.test.js -- issue #27: label the panel, not the console.
//
// RouterOS names a port after its interface type ("ether1", "sfp-sfpplus1"),
// which is not what is printed next to the socket ("eth1", "SFP+1"). A person
// cabling a box reads the silkscreen, so that is what the canvas, the inspector
// and the faceplate must show -- while the console must keep accepting the
// RouterOS spelling, because that is what the operator has in their fingers and
// what every MikroTik tutorial tells them to type.
//
// The rule is therefore two-sided, and both sides are checked here:
//
//   1. NO spec may carry a RouterOS-only spelling as a port name. If one does,
//      the rename was incomplete and a faceplate is advertising a name nobody
//      can find on the hardware.
//   2. Typing EITHER spelling through the CLI must reach the same physical port,
//      while the engine's own interface map holds only the panel spelling. An
//      alias that becomes a name would put "ether1" back on the canvas, and a
//      cable to it would hang off a port the faceplate never drew.
//
// A third check rides along because the rename made it possible to break: port
// names are resolved into a cage (engine/media.js -> inferCage), so a name whose
// text says "SFP+" but whose resolved cage is copper would cable the wrong
// cable. The spec's own wording must agree with the connector that gets drawn.
//
// Run: node test/mikrotik-naming.test.js       exit 1 on any divergence.
// ===========================================================================

const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { resolvePortName, portKey } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const mikrotik = catalog.filter(function (s) { return String(s.vendor).toLowerCase() === 'mikrotik'; });

// What RouterOS would call the port, derived from the panel name the spec uses.
// This is the alias contract expressed once, so the catalogue-wide check below
// cannot drift away from the CLI's rules.
function routerosName(name) {
  let m;
  if ((m = /^eth(\d+)$/.exec(name))) return 'ether' + m[1];
  if ((m = /^SFP\+(\d+)$/.exec(name))) return 'sfp-sfpplus' + m[1];
  if ((m = /^QSFP\+(\d+)$/.exec(name))) return 'qsfpplus' + m[1];
  if ((m = /^SFP(\d+)$/.exec(name))) return 'sfp' + m[1];
  if ((m = /^SFP28-(\d+)$/.exec(name))) return 'sfp28-' + m[1];
  if ((m = /^QSFP28-(\d+)$/.exec(name))) return 'qsfp28-' + m[1];
  if ((m = /^COMBO(\d+)$/.exec(name))) return 'combo' + m[1];
  return null;                       // radios, mgmt etc. share one spelling
}

// Every port a spec really presents: template-generated ports first, then the
// explicit ones, exactly as engine/topology.js builds them.
function expand(spec) {
  const out = [];
  if (spec.portTemplate) {
    const t = spec.portTemplate;
    const start = (t.start === undefined || t.start === null) ? 1 : t.start;
    for (let i = 0; i < Number(t.count || 0); i++) out.push((t.prefix || 'eth') + (start + i));
  }
  for (const i of (spec.interfaces || [])) out.push(i.name);
  return out;
}

function materialise() {
  return mikrotik.map(function (spec) {
    const t = new Topology();
    const d = t.addDevice(spec);
    return { spec: spec, dev: d };
  });
}
const all = materialise();

console.log('The catalogue has MikroTik hardware to check:');
ok(mikrotik.length >= 20, 'MikroTik specs are present (' + mikrotik.length + ' models)');

console.log('\nEvery MikroTik port is labelled the way the box is labelled:');
{
  // RouterOS-only spellings. 'ethN' and 'SFP+N' are the silkscreen forms; these
  // are the console forms and none of them may survive into a spec. The match is
  // case-SENSITIVE on purpose: "SFP28-1" is the panel label, "sfp28-1" is the
  // RouterOS one, and only the second is a defect.
  const CONSOLE_ONLY = /^(ether|sfpplus|sfp-sfpplus|qsfpplus|qsfp-qsfpplus|sfp28-|qsfp28-|combo)\d+$/;
  const consoleNamed = [];
  for (const x of all) {
    for (const n of expand(x.spec)) {
      if (CONSOLE_ONLY.test(n)) consoleNamed.push(x.spec.model + '/' + n);
    }
  }
  ok(consoleNamed.length === 0, 'no port is named with a RouterOS console spelling' +
    (consoleNamed.length ? ' (' + consoleNamed.slice(0, 4).join(', ') + ')' : ''));

  // Copper keeps the lowercase 'ethN' form; a fibre position is written the way
  // a datasheet writes it, i.e. capitalised ("SFP+1", not "sfp+1").
  const badCase = [];
  for (const x of all) {
    for (const n of expand(x.spec)) {
      if (/^eth/i.test(n) && !/^eth\d+$/.test(n)) badCase.push(x.spec.model + '/' + n);
      if (/^sfp|^qsfp|^combo/i.test(n) && !/^[A-Z]/.test(n)) badCase.push(x.spec.model + '/' + n);
    }
  }
  ok(badCase.length === 0, 'ethN is lowercase and fibre positions are capitalised' +
    (badCase.length ? ' (' + badCase.slice(0, 4).join(', ') + ')' : ''));

  // The rename is only cosmetic if the numbers survived it: every port the
  // template generates must still be on the device, not swallowed by a literal.
  const swallowed = [];
  for (const x of all) {
    if (!x.spec.portTemplate) continue;
    const t = x.spec.portTemplate;
    const start = (t.start === undefined || t.start === null) ? 1 : t.start;
    for (let i = 0; i < Number(t.count || 0); i++) {
      const n = (t.prefix || 'eth') + (start + i);
      if (!x.dev.interfaces.has(n)) swallowed.push(x.spec.model + '/' + n);
    }
  }
  ok(swallowed.length === 0, 'every port a template generates is present after the rename' +
    (swallowed.length ? ' (' + swallowed.slice(0, 4).join(', ') + ')' : ''));
}

console.log('\nNo port is declared twice, generated ports included:');
{
  // test/hardware-invariants.test.js only sees the declared array, so a device
  // that generates eth1..N AND lists eth1..N looks fine there while the map
  // silently collapses. That is the shape CCR2116 was in.
  const collapsed = [];
  for (const x of all) {
    const names = expand(x.spec);
    if (x.dev.interfaces.size !== names.length) {
      collapsed.push(x.spec.model + ' (' + x.dev.interfaces.size + '/' + names.length + ')');
    }
  }
  ok(collapsed.length === 0, 'materialised port count matches the declared hardware' +
    (collapsed.length ? ' (' + collapsed.slice(0, 3).join(', ') + ')' : ''));
}

console.log('\nThe name and the connector that gets drawn agree:');
{
  const FIBRE = ['sfp', 'sfp+', 'sfp28', 'qsfp+', 'qsfp28', 'qsfpdd'];
  const WRONG = {
    'SFP+': 'sfp+', 'SFP28-': 'sfp28', 'QSFP+': 'qsfp+', 'QSFP28-': 'qsfp28'
  };
  const contradictions = [];
  for (const x of all) {
    for (const i of x.dev.interfaces.values()) {
      const cage = i.hardware && i.hardware.cage;
      if (!cage) { contradictions.push(x.spec.model + '/' + i.name + ' (no cage)'); continue; }
      if (/^eth\d+$/.test(i.name) && cage !== 'rj45') {
        contradictions.push(x.spec.model + '/' + i.name + ' -> ' + cage);
      }
      for (const prefix of Object.keys(WRONG)) {
        if (i.name.indexOf(prefix) === 0 && cage !== WRONG[prefix]) {
          contradictions.push(x.spec.model + '/' + i.name + ' -> ' + cage + ' (not ' + WRONG[prefix] + ')');
        }
      }
      if (/^sfp\d+$/i.test(i.name) && FIBRE.indexOf(cage) === -1) {
        contradictions.push(x.spec.model + '/' + i.name + ' -> ' + cage);
      }
    }
  }
  ok(contradictions.length === 0, 'no port advertises a cage it cannot deliver' +
    (contradictions.length ? ' (' + contradictions.slice(0, 3).join(', ') + ')' : ''));
}

console.log('\nRouterOS spellings resolve onto the panel port everywhere:');
{
  const unresolved = [];
  for (const x of all) {
    for (const name of [...x.dev.interfaces.keys()]) {
      const ros = routerosName(name);
      if (!ros) continue;
      if (resolvePortName(x.dev, ros) !== name) {
        unresolved.push(x.spec.model + ': ' + ros + ' -> ' + resolvePortName(x.dev, ros));
      }
    }
  }
  ok(unresolved.length === 0, 'every panel name has a RouterOS alias that reaches it' +
    (unresolved.length ? ' (' + unresolved.slice(0, 3).join(', ') + ')' : ''));
}

console.log('\nThe alias rules fold spellings without merging different sockets:');
{
  ok(portKey('ether1') === portKey('eth1'), 'ether1 and eth1 are one key');
  ok(portKey('sfp-sfpplus1') === portKey('SFP+1'), 'sfp-sfpplus1 and SFP+1 are one key');
  ok(portKey('qsfpplus1') === portKey('QSFP+1'), 'qsfpplus1 and QSFP+1 are one key');
  ok(portKey('combo1') === portKey('COMBO1'), 'combo1 and COMBO1 are one key');
  ok(portKey('sfp28-2') === portKey('SFP28-2'), 'sfp28-2 and SFP28-2 are one key');
  // The line that matters: a 1G SFP cage and a 10G SFP+ cage are different
  // physical positions, so folding "+" away would cable the wrong socket.
  ok(portKey('SFP1') !== portKey('SFP+1'), 'SFP1 (1G cage) is not SFP+1 (10G cage)');
  ok(portKey('eth1') !== portKey('eth10'), 'eth1 is not eth10');
}

console.log('\nAn operator typing RouterOS names still configures the right port:');
{
  const spec = catalog.find(function (s) { return s.model === 'CCR2004-16G-2S+'; });
  ok(!!spec, 'the CCR2004-16G-2S+ spec is in the catalogue');
  const t = new Topology();
  const d = t.addDevice(spec);
  d.name = 'R1';
  const cli = new CliSession(d, t, new Simulator(t));

  cli.run('configure terminal');

  cli.run('interface ether1');
  cli.run('ip address 10.0.0.1 255.255.255.0');
  ok(d.interfaces.get('eth1').ip === '10.0.0.1', '"interface ether1" configures eth1');
  cli.run('exit');

  cli.run('interface sfp-sfpplus2');
  cli.run('ip address 10.9.9.9 255.255.255.0');
  ok(d.interfaces.get('SFP+2').ip === '10.9.9.9', '"interface sfp-sfpplus2" configures SFP+2');
  cli.run('exit');

  ok(!d.interfaces.has('ether1') && !d.interfaces.has('sfp-sfpplus2'),
    'the alias never becomes a port name in the interface map');
  ok([...d.interfaces.keys()].indexOf('ether1') === -1,
    'no RouterOS spelling leaks into what the canvas would draw');

  // The panel spelling has to keep working too - it is the name in the UI.
  cli.run('interface eth3');
  cli.run('ip address 10.0.3.1 255.255.255.0');
  ok(d.interfaces.get('eth3').ip === '10.0.3.1', 'the panel spelling "eth3" still works');
  cli.run('exit');

  // Case is not a port identity either.
  cli.run('interface ETHER4');
  cli.run('ip address 10.0.4.1 255.255.255.0');
  ok(d.interfaces.get('eth4').ip === '10.0.4.1', 'a shouted ETHER4 resolves to eth4');
  cli.run('exit');

  // Subinterfaces inherit the alias: the parent resolves, the child follows.
  cli.run('interface ether1.10');
  ok(d.interfaces.has('eth1.10'), '"interface ether1.10" creates eth1.10, not ether1.10');
  cli.run('exit');
  cli.run('no interface ether1.10');
  ok(!d.interfaces.has('eth1.10'), '"no interface ether1.10" removes the same port');

  // A port the box does not have must still be refused, alias or not.
  const bad = cli.run('interface ether99').output.join('\n');
  ok(/Interface not found/.test(bad), 'ether99 is still refused');

  const brief = cli.run('show ip interface brief').output.join('\n');
  ok(/^\s*eth1\s/m.test(brief), 'show ip interface brief lists eth1');
  ok(brief.indexOf('ether1') === -1, 'and never prints a RouterOS spelling');
  ok(brief.indexOf('SFP+2') !== -1, 'the fibre port is listed as SFP+2');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
