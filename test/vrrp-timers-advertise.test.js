'use strict';
// The advertisement interval is set under the keyword the box uses, `timers`, and this console had it
// under a word no box has.
//
// Cisco's syntax is `vrrp group timers advertise [msec] interval` - "To configure the interval between
// successive advertisements by the virtual router master in a VRRP group, use the vrrp timers advertise
// command in interface configuration mode" (Cisco IOS First Hop Redundancy Protocols Command Reference,
// https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp_fhrp/command/fhp-cr-book/fhp-v1.html), whose
// own example is `Router(config-if)# vrrp 1 timers advertise 4`. Every configuration-guide example spells
// it the same way: `vrrp 1 timers advertise 3` and `vrrp 5 timers advertise 30` in the IOS XE 16.12 FHRP
// guide, `vrrp 10 timers advertise 110` in the 12.2SY guide.
//
// This console took the word `advertise` alone, so the spelling every box accepts was answered
// `% Unrecognized vrrp command` while a spelling no box has was the documented form - and the printer
// wrote it into `show running-config`, so a config saved from the device carried a line the device
// would not take back. The line is now the box's, the old spelling is refused by name with the right
// one in the sentence, and the interval itself is unchanged: it is the same `advertSec` the election and
// `converge` already read.
//
// research/vrrp-timers-advertise.md holds the sources and the one word of the syntax this console still
// refuses: `msec`, which is a sub-second interval and a different fact.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const vrrp = require('../engine/vrrp');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return s.model === 'generic-router'; })[0];
const PORT = 'Gi0/0';

function session() {
  const t = new Topology();
  const dev = t.addDevice(ROUTER, 'r1');
  const cli = new CliSession(dev, t, new Simulator(t));
  const run = function (cmds) {
    const lines = [];
    for (const c of cmds) {
      const r = cli.run(c);
      for (const l of ((r && r.output) || [])) lines.push(String(l));
    }
    return lines;
  };
  run(['enable', 'configure terminal', 'interface ' + PORT, 'ip address 10.0.0.1 255.255.255.0',
    'vrrp 42 ip 10.0.0.254']);
  return { dev: dev, cli: cli, run: run };
}

function groups(dev) { return Array.isArray(dev.config.vrrp) ? dev.config.vrrp : []; }
function group(dev) {
  return groups(dev).filter(function (g) { return g.vrid === 42; })[0] || null;
}
function interval(dev) {
  const g = group(dev);
  return g ? g.advertSec : null;
}

console.log('The box spelling is the one this console takes:');
{
  const s = session();
  const out = s.run(['vrrp 42 timers advertise 3']);
  ok(out[0] === 'VRRP group 42 advertises every 3 s', 'vrrp 42 timers advertise 3 is accepted', out[0]);
  ok(interval(s.dev) === 3, 'and the group holds three seconds', String(interval(s.dev)));
  ok(groups(s.dev).length === 1, 'one group, and no second one was made', JSON.stringify(groups(s.dev)));

  // The receipt and the engine agree: the interval is the field the election reads, so the
  // master-down interval moves with it (3 x advertise + (256 - priority)/256).
  const md = vrrp.masterDownInterval(group(s.dev), vrrp.skewTime(group(s.dev)));
  ok(Math.abs(md - 9.609375) < 1e-6, 'the master-down interval is 3 x 3 s + skew', String(md));

  const again = s.run(['vrrp 42 timers advertise 1']);
  ok(again[0] === 'VRRP group 42 advertises every 1 s', 'and a whole second is a value like any other', again[0]);
}

console.log('\nThe line the printer writes is the line the box writes, and it reads back:');
{
  const s = session();
  s.run(['vrrp 42 timers advertise 30', 'end']);
  const text = s.run(['show running-config']).join('\n');
  ok(/(^|\n) vrrp 42 timers advertise 30(\n|$)/.test(text), 'show running-config prints ` vrrp 42 timers advertise 30`',
    text.split('\n').filter(function (l) { return /vrrp/.test(l); }).join(' | '));
  ok(!/(^|\n) vrrp 42 advertise/.test(text), 'and not the old bare spelling',
    text.split('\n').filter(function (l) { return /advertise/.test(l); }).join(' | '));

  // The paste-back, on a fresh device of the same model: the printed config is a config.
  const topo = new Topology();
  const fresh = topo.addDevice(ROUTER, 'r2');
  const cli = new CliSession(fresh, topo, new Simulator(topo));
  const replayed = [];
  for (const line of ['enable', 'configure terminal'].concat(text.split('\n'))) {
    const r = cli.run(line);
    for (const l of ((r && r.output) || [])) replayed.push(String(l));
  }
  const rejected = replayed.filter(function (l) { return /^%/.test(l); });
  ok(rejected.length === 0, 'every line of the printed config is accepted back', JSON.stringify(rejected.slice(0, 3)));
  ok(interval(fresh) === 30, 'and the pasted group runs at 30 s', String(interval(fresh)));
}

console.log('\nThe spelling no box has is refused by name, and changes nothing:');
{
  const s = session();
  s.run(['vrrp 42 timers advertise 3']);
  const refused = s.run(['vrrp 42 advertise 5']);
  ok(/^% `vrrp 42 advertise 5` is not a command/.test(refused[0]),
    'vrrp 42 advertise 5 is refused as not a command', refused[0]);
  ok(/vrrp 42 timers advertise <seconds>/.test(refused[0]),
    'and the sentence carries the box form', refused[0]);
  ok(interval(s.dev) === 3, 'the interval the operator had is untouched', String(interval(s.dev)));
  ok(groups(s.dev).length === 1, 'and no group was created or removed', JSON.stringify(groups(s.dev)));

  // On a device with no group at all, the refusal must not leave an empty group behind either.
  const t = new Topology();
  const bare = t.addDevice(ROUTER, 'r9');
  const cli = new CliSession(bare, t, new Simulator(t));
  ['enable', 'configure terminal', 'interface ' + PORT, 'ip address 10.9.0.1 255.255.255.0'].forEach(function (c) {
    cli.run(c);
  });
  cli.run('vrrp 7 advertise 5');
  ok(groups(bare).length === 0, 'a refused line on a bare port creates no group', JSON.stringify(groups(bare)));
}

console.log('\nThe other words of the syntax are answered, not swallowed:');
{
  const s = session();
  const short = s.run(['vrrp 42 timers']);
  ok(short[0] === '% Incomplete command: vrrp <vrid> timers advertise <seconds>',
    'vrrp 42 timers is a short line, and says so', short[0]);

  const shortValue = s.run(['vrrp 42 timers advertise']);
  ok(shortValue[0] === '% Incomplete command: vrrp <vrid> timers advertise <seconds>',
    'and so is a line with no interval after it', shortValue[0]);

  const unknown = s.run(['vrrp 42 timers wibble']);
  ok(/^% Unrecognized vrrp command: vrrp 42 timers wibble/.test(unknown[0]),
    'vrrp 42 timers wibble is refused', unknown[0]);
  ok(/timers advertise <seconds>/.test(unknown[0]), 'with the form this console has', unknown[0]);

  const learn = s.run(['vrrp 42 timers learn']);
  ok(/timers learn` is not modelled/.test(learn[0]),
    'vrrp 42 timers learn is a real keyword this model cannot honour, and it says which', learn[0]);

  const msec = s.run(['vrrp 42 timers advertise msec 500']);
  ok(/timers advertise msec <interval>` is not modelled/.test(msec[0]),
    'the msec form is refused as a different fact, not read as 500 seconds', msec[0]);
  ok(interval(s.dev) === null || interval(s.dev) === 1,
    'and no interval was written from a refused line', String(interval(s.dev)));

  for (const bad of ['0', '-2', 'abc']) {
    const r = s.run(['vrrp 42 timers advertise ' + bad]);
    ok(/^% Invalid advertisement interval: /.test(r[0]), 'vrrp 42 timers advertise ' + bad + ' is refused', r[0]);
  }
}

console.log('\n`no` takes the same keyword, and the default is the vendor 1 second:');
{
  const s = session();
  s.run(['vrrp 42 timers advertise 4']);
  const back = s.run(['no vrrp 42 timers advertise']);
  ok(back[0] === 'VRRP group 42 advertises every 1 s', 'no vrrp 42 timers advertise restores 1 s', back[0]);
  ok(interval(s.dev) === 1, 'and the group holds the default', String(interval(s.dev)));
  ok(groups(s.dev).length === 1, 'with the group still standing', JSON.stringify(groups(s.dev)));

  s.run(['end']);
  const text = s.run(['show running-config']).join('\n');
  ok(!/timers advertise/.test(text), 'the default is not printed, as no default is',
    text.split('\n').filter(function (l) { return /vrrp/.test(l); }).join(' | '));

  s.run(['configure terminal', 'interface ' + PORT, 'vrrp 42 timers advertise 2']);
  const bareNo = s.run(['no vrrp 42 advertise']);
  ok(/^% `no vrrp 42 advertise` is not a command/.test(bareNo[0]),
    'no vrrp 42 advertise is refused rather than read as the box line', bareNo[0]);
  ok(interval(s.dev) === 2, 'so it resets nothing', String(interval(s.dev)));
  ok(groups(s.dev).length === 1, 'and it does not delete the group', JSON.stringify(groups(s.dev)));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
