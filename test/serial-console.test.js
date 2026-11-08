#!/usr/bin/env node
/**
 * A console port is not a data port.
 *
 * It has no line rate, it has a baud rate, and the baud rate is the thing that actually goes
 * wrong in a lab: plug a 9600 console into a 115200 one and the cable is fine, the connectors are
 * fine, and every character arrives as noise. Two defects lived here for a long time:
 *
 *   1. 163 console ports claimed 1000 Mbps (then 100) on a 115.2 kbps cage, because
 *      derivePortHardware fell back to a flat 1000 when a spec named nothing but its type, and
 *      because hardware-invariants skipped console ports entirely.
 *   2. A console cable between mismatched baud rates was reported as "no shared medium", which
 *      tells an operator nothing they can act on.
 */
'use strict';

const path = require('path');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const media = require('../engine/media');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function t(name, fn) {
  console.log('\n' + name);
  if (typeof fn !== 'function') return;
  try { fn(); } catch (e) { failed++; console.log('  ✗ threw: ' + e.message); }
}

const root = path.join(__dirname, '..');
const specs = loadCatalog(path.join(root, 'devices'));

// ---------------------------------------------------------------------------
t('The baud ladder is the whole point of a console port');

const BAUDS = { 'console-rs232': 115200, 'console-rs232-57600': 57600, 'console-rs232-38400': 38400,
  'console-rs232-19200': 19200, 'console-rs232-9600': 9600 };

ok(Object.keys(BAUDS).every(id => media.mediaById(id) && media.mediaById(id).baud === BAUDS[id]),
  'all five standard baud rates exist as media');
ok(Object.keys(BAUDS).every(id => {
  const m = media.mediaById(id);
  return Math.abs(m.speedMbps - m.baud / 1000000) < 0.000001;
}), 'each medium states its baud rate as a bit rate the engine can compare (115200 baud = 0.1152 Mbps)');
ok(media.CAGE_MEDIA.console().length === 5, 'the console cage offers the whole ladder');
ok(media.CAGE_SPEEDS.console().length === 5, 'and declares all five rates it can carry');
ok(media.mediaById('console-rs232').maxRangeM === 15, 'a console cable is short, as RS-232 is');

// ---------------------------------------------------------------------------
t('No console port claims a rate its cage cannot carry');

const consolePorts = [];
for (const s of specs) {
  let d;
  try { d = new Topology().addDevice(s); } catch (e) { continue; }
  for (const p of d.interfaces.values()) {
    if (p.hardware.cage === 'console') consolePorts.push({ model: s.model, p });
  }
}
ok(consolePorts.length > 100, 'the catalogue has console ports to check (' + consolePorts.length + ')');
const liars = consolePorts.filter(x => x.p.hardware.maxSpeedMbps > 12.1);
ok(liars.length === 0, 'every console port runs at console rates' +
  (liars.length ? ' (' + liars.slice(0, 3).map(x => x.model + '/' + x.p.name + '=' + x.p.hardware.maxSpeedMbps).join(', ') + ')' : ''));
const tty = consolePorts.filter(x => x.p.hardware.media.some(id => media.mediaById(id).family !== 'console'));
ok(tty.length === 0, 'no console port advertises a data medium' +
  (tty.length ? ' (' + tty.slice(0, 3).map(x => x.model + '/' + x.p.name).join(', ') + ')' : ''));

// ---------------------------------------------------------------------------
t('A spec that names only its type still gets the baud ladder');

const derived = media.derivePortHardware({ name: 'console', type: 'console' });
ok(derived.cage === 'console', 'the cage resolves from the port type');
ok(Math.abs(derived.maxSpeedMbps - 0.1152) < 0.0001,
  'and the rate is 115200 baud, not the old flat 1000 Mbps fallback (got ' + derived.maxSpeedMbps + ')');

const named = media.derivePortHardware({ name: 'c', type: 'console', connector: 'console' });
ok(named.maxSpeedMbps === derived.maxSpeedMbps, 'naming the connector agrees with naming the type');

// ---------------------------------------------------------------------------
t('Two consoles link at their shared baud');

function consoleHw(bauds) {
  // Written the way a spec author writes it: in baud, not in Mbps.
  return media.derivePortHardware({ name: 'con', type: 'console', connector: 'console', baud: bauds });
}

{
  const a = consoleHw([115200]);
  const b = consoleHw([115200]);
  const v = media.canMate(a, b);
  ok(v.ok === true, 'two 115200 consoles mate');
  ok(Math.abs(v.speedMbps - 0.1152) < 0.0001, 'and the link runs at 115200 baud');
}

{
  const a = consoleHw([9600, 19200, 38400, 57600, 115200]);
  const b = consoleHw([9600]);
  const v = media.canMate(a, b);
  ok(v.ok === true, 'a 9600-only console links to a multi-baud one');
  ok(Math.abs(v.speedMbps - 0.0096) < 0.0001,
    'and it negotiates DOWN to 9600 rather than assuming 115200 (got ' + v.speedMbps + ')');
}

// ---------------------------------------------------------------------------
t('A baud mismatch is reported as a baud mismatch');

{
  const a = consoleHw([9600]);
  const b = consoleHw([115200]);
  const v = media.canMate(a, b);
  ok(v.ok === false, 'a 9600 console refuses a 115200 console');
  ok(v.code === 'E_BAUD_MISMATCH', 'with a code that names the problem (got ' + v.code + ')');
  ok(/9600/.test(v.message) && /115200/.test(v.message), 'the message states both baud rates');
  ok(/noise|same speed/i.test(v.message), 'and says what the operator will actually see');
}

// ---------------------------------------------------------------------------
t('A console port is not a data port, and says so');

{
  const con = consoleHw([115200]);
  const eth = media.derivePortHardware({ name: 'g0', type: 'ethernet' });
  const v = media.canMate(con, eth);
  ok(v.ok === false, 'a console port refuses an Ethernet port');
  ok(v.code === 'E_PROTOCOL_MISMATCH', 'on protocol grounds (got ' + v.code + ')');
  ok(/out-of-band|console/i.test(v.message), 'and the message explains that a console is out-of-band');
}

{
  const con = consoleHw([115200]);
  const sfp = media.derivePortHardware({ name: 'sfp1', type: 'ethernet', connector: 'sfp+', speed: '10G' });
  const v = media.canMate(con, sfp);
  ok(v.ok === false && v.code === 'E_PROTOCOL_MISMATCH', 'and so does an SFP+ data port');
}

// ---------------------------------------------------------------------------
t('Console ports source no power');

{
  const powered = [];
  for (const { model, p } of consolePorts) {
    if (p.hardware.poeOut) powered.push(model + '/' + p.name);
  }
  ok(powered.length === 0, 'no console port claims to source PoE' +
    (powered.length ? ' (' + powered.slice(0, 3).join(', ') + ')' : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
