'use strict';
// A console port is a line, not an interface (#2137).
//
// The 2811 - the router every Cisco lab starts with - declares six sockets in the catalogue: Fa0/0, Fa0/1,
// Se0/0/0, Se0/0/1, Console and Aux0. The faceplate needs all six (it draws the blue console socket and the black
// aux socket), and the physical layer already knows they are out-of-band: `media.canMate()` refuses to call a
// console a data port and negotiates a *baud rate* between two of them. The interface tables did not know, and they
// printed a console as though it were a routable port:
//
//   Catalyst 2811# show ip interface brief
//   Console                unassigned      YES unset  down                  down
//   Aux0                   unassigned      YES unset  down                  down
//
//   Catalyst 2811# show interfaces
//   Console (console, 1G), MAC 0200.0000.0004
//     speed: 1Gb/s (auto), duplex: full
//
//   Catalyst 2811# show running-config
//   interface Console
//   !
//
// None of the three is something a box can print. On a Cisco router the console is a *line*: `show running-config`
// writes `line con 0` / `stopbits 1` (Cisco 4000 Series ISRs Software Configuration Guide, IOS XE 16.10, "Basic
// Router Configuration"), the settings are reached with `line console 0`, the socket runs at 9600 baud (2800 Series
// Hardware Installation Guide: "The default parameters for the console port are 9600 baud, 8 data bits, 1 stop bit,
// and no parity"), and Cisco's own `show ip interface brief` examples for a 2811 list FastEthernet0/0,
// FastEthernet0/1, Serial0/0/0 and Serial0/0/1 with no Console and no Aux0 row. research/
// console-is-a-line-not-an-interface.md holds the captures.
//
// Asserted here: the three interface views omit the socket, a name that points at it is answered in words rather
// than with a fabricated block, `interface Console` is refused and leaves the session where it was, a data port is
// untouched by all of it, and the socket itself still exists for the faceplate and the cable.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const { isConsoleLine } = require('../engine/device');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return s.model === '2811'; })[0];

function build(spec) {
  const t = new Topology();
  const d = t.addDevice(spec, 'r1');
  d.name = 'r1';
  return { topo: t, dev: d, sim: new Simulator(t) };
}
function cli(ctx, cmds) {
  const s = new CliSession(ctx.dev, ctx.topo, ctx.sim);
  s.run('enable');
  const out = [];
  for (const c of cmds) out.push.apply(out, s.run(c).output || []);
  return { session: s, lines: out, text: out.join('\n') };
}

console.log('The console and aux sockets are not interfaces on a 2811');
{
  const ctx = build(ROUTER);
  ok(Array.from(ctx.dev.interfaces.keys()).indexOf('Console') !== -1,
    'the socket is still in the port list (the faceplate draws it)');
  ok(isConsoleLine(ctx.dev.interfaces.get('Console')) && isConsoleLine(ctx.dev.interfaces.get('Aux0')),
    'and the model classifies Console and Aux0 as console lines');

  const brief = cli(ctx, ['show ip interface brief']).text;
  const rows = brief.split('\n').filter(function (l) { return /^\S/.test(l) && !/^Interface/.test(l); });
  ok(rows.length === 4, 'show ip interface brief prints four rows, one per data port', String(rows.length));
  ok(!/^Console\b/m.test(brief), 'with no Console row');
  ok(!/^Aux0\b/m.test(brief), 'and no Aux0 row');
  ok(/^FastEthernet0\/0\s+unassigned\s+YES unset\s+down\s+down$/m.test(brief),
    'while the data ports are printed exactly as before');

  const detail = cli(ctx, ['show interfaces']).text;
  const blocks = detail.split('\n').filter(function (l) { return /^\S+ \(.+, .+\), MAC /.test(l); });
  ok(blocks.length === 4, 'show interfaces prints one block per data port', String(blocks.length));
  ok(!/^Console \(/m.test(detail) && !/^Aux0 \(/m.test(detail),
    'and prints no block for the console or the aux socket');
  ok(!/Console.*MAC/.test(detail), 'so no MAC address is invented for a line that has none');

  const config = cli(ctx, ['show running-config']).text;
  ok(!/^interface Console$/m.test(config), 'show running-config writes no "interface Console" stanza');
  ok(!/^interface Aux0$/m.test(config), 'and none for Aux0');
  ok((config.match(/^interface /gm) || []).length === 4, 'the four data ports keep their stanzas');
}

console.log('\nA name that points at the line is answered in words, not with a fabricated block');
{
  const ctx = build(ROUTER);
  for (const name of ['Console', 'Aux0']) {
    const r = cli(ctx, ['show interfaces ' + name]);
    ok(r.lines.length === 1, 'show interfaces ' + name + ' answers in one line', String(r.lines.length));
    ok(new RegExp('^% ' + name + ' is the (console|auxiliary) line, not an interface:').test(r.lines[0]),
      'and says what the socket is', r.lines[0]);
    ok(!/\bMAC\b/.test(r.text) && !/status:/.test(r.text), 'with no block, no MAC and no status line');
  }
}

console.log('\n`interface Console` is refused, and the session does not move into it');
{
  const ctx = build(ROUTER);
  const s = new CliSession(ctx.dev, ctx.topo, ctx.sim);
  s.run('enable'); s.run('configure terminal');
  const refused = s.run('interface Console').output || [];
  ok(refused.length === 1 && /^% Console is the console line, not an interface/.test(refused[0]),
    'the door refuses in one sentence', refused[0]);
  ok(s.mode === 'config' && /\(config\)#$/.test(s.prompt()), 'and the cursor stays in config mode', s.prompt());
  ok(!ctx.dev.interfaces.get('Console').ip, 'no address was written to the socket');

  // A shut console port would claim the socket is a port that can be down: it is neither.
  const data = s.run('interface Fa0/0').output || [];
  ok(s.mode === 'iface' && s.iface === 'Fa0/0', 'while a data port still opens', String(s.iface));
  ok(!data.some(function (l) { return /^%/.test(l); }), 'with no refusal');
  s.run('ip address 10.0.0.1 255.255.255.0');
  const brief = (s.run('end').output || []).concat(s.run('show ip interface brief').output || []).join('\n');
  ok(/^FastEthernet0\/0\s+10\.0\.0\.1\s+YES manual/m.test(brief),
    'and an address configured on it is still the row a box prints');
}

console.log('\nAnd `show interfaces` on a switch does not manufacture one either');
{
  // The other shape: a Catalyst 2960 has no console port in the catalogue, so the rule must not touch it.
  const sw = catalog.filter(function (s) { return s.model === 'Catalyst2960'; })[0];
  const ctx = build(sw);
  const brief = cli(ctx, ['show ip interface brief']).text;
  ok(brief.split('\n').filter(function (l) { return /^FastEthernet/.test(l); }).length === 24,
    'a 2960 still prints its 24 ports');
  ok(!/Console/.test(brief) && !/Console/.test(cli(ctx, ['show interfaces']).text),
    'and no Console line appears on a box that does not declare one');
}

console.log('\nThe whole catalogue: no model prints an interface view for a console socket');
{
  const bad = [];
  let checked = 0, sockets = 0;
  for (const spec of catalog) {
    const consoles = (spec.interfaces || []).filter(function (i) {
      return String(i.type || '').toLowerCase() === 'console';
    });
    if (!consoles.length) continue;
    if ((spec.capabilities || []).indexOf('cli') === -1) continue;
    let ctx;
    try { ctx = build(spec); } catch (e) { bad.push(spec.model + ' setup threw: ' + e.message); continue; }
    const brief = cli(ctx, ['show ip interface brief']).text;
    const detail = cli(ctx, ['show interfaces']).text;
    const config = cli(ctx, ['show running-config']).text;
    for (const c of consoles) {
      sockets++;
      if (new RegExp('^' + c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+\\S+\\s+YES', 'm').test(brief)) {
        bad.push(spec.model + ': ' + c.name + ' has a row in show ip interface brief');
      }
      if (new RegExp('^interface ' + c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm').test(config)) {
        bad.push(spec.model + ': ' + c.name + ' has a stanza in show running-config');
      }
      if (detail.indexOf(c.name + ' (console, ') !== -1) {
        bad.push(spec.model + ': ' + c.name + ' has a block in show interfaces');
      }
    }
    checked++;
  }
  ok(checked > 150, 'the sweep reached the models that declare a console socket', String(checked));
  ok(sockets > 400, 'and every socket it declares', String(sockets));
  ok(bad.length === 0, 'no console socket is printed as an interface anywhere in the catalogue',
    bad.slice(0, 5).join(' ;; '));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
