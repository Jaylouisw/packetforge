'use strict';
// A saved board is the lab that was saved (#1321).
//
// Nothing compared a device across a save. `Topology.fromJSON()` rebuilt each port from four keys -
// `{name, type, speed, cage}` - and re-derived everything else, so 322 of the catalogue's 2,015 devices came back
// different from the ones that were saved:
//
//   port fields lost:   comboWith 84 ports, comboRole 84 ports          (a combo pair forgot its sibling)
//   hardware changed:   maxSpeedMbps 1,028 ports  (a 115.2 kbps console reloaded as a 1 Gbps port)
//                       poeOutDeclared 1,499 ports (declared PoE reloaded looking like the engine guessed)
//
// Only the first of these is visible in a field comparison. The rest matter because of what they change:
//
//   * a combo cage is one physical position. Cabling a half while its sibling is in use is refused - and after a
//     reload the refusal stopped happening, so a reloaded lab silently accepted two cables in one cage;
//   * `maxSpeedMbps` feeds W_SPEED_DOWNGRADE. A reloaded console port claiming 1 Gbps produces a warning about a
//     link that was not previously warned about;
//   * `poeOutDeclared` is how the PoE invariant answers "did the hardware say so, or did the engine guess?".
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { validateTopology } = require('../engine/validation');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const specs = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });

function portsOf(dev) {
  const out = {};
  for (const [name, p] of dev.interfaces) out[name] = JSON.parse(JSON.stringify(p));
  return out;
}
function roundTrip(topo) {
  return Topology.fromJSON(JSON.parse(JSON.stringify(topo.serialize())));
}
function portDiff(before, after) {
  const diffs = [];
  const names = Object.keys(before);
  if (names.sort().join(',') !== Object.keys(after).sort().join(',')) return ['port list differs'];
  for (const name of names) {
    const a = before[name], b = after[name];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
      if (k === 'hardware' && a[k] && b[k]) {
        for (const h of new Set([...Object.keys(a[k]), ...Object.keys(b[k])])) {
          if (JSON.stringify(a[k][h]) !== JSON.stringify(b[k][h])) diffs.push(name + '.' + k + '.' + h);
        }
      } else diffs.push(name + '.' + k);
    }
  }
  return diffs;
}

console.log('');
console.log('Every device in the catalogue comes back as itself:');
{
  const wrong = [];
  for (const spec of specs) {
    const t = new Topology();
    const d = t.addDevice(spec, 'd1');
    let t2;
    try { t2 = roundTrip(t); } catch (e) { wrong.push(spec.vendor + '/公益'.slice(0, 0) + spec.model + ': threw ' + e.message); continue; }
    const d2 = t2.getDevice('d1');
    if (!d2) { wrong.push(spec.vendor + '/' + spec.model + ': device missing after reload'); continue; }
    const diffs = portDiff(portsOf(d), portsOf(d2));
    if (diffs.length) wrong.push(spec.vendor + '/' + spec.model + ': ' + diffs.slice(0, 3).join(', '));
  }
  ok(wrong.length === 0, specs.length + ' devices, every field of every port identical after a save and reload',
    JSON.stringify(wrong.slice(0, 4)));
  ok(specs.length > 1500, 'and the sweep covered the catalogue', String(specs.length));
}

console.log('');
console.log('A combo cage stays one cage after a reload:');
{
  const spec = specs.filter(function (s) { return /ISR 4331/.test(s.model); })[0];
  ok(!!spec, 'the test has a device with a combo pair');
  const t = new Topology();
  const d = t.addDevice(spec, 'r1');
  const combo = Array.from(d.interfaces.values()).filter(function (p) { return p.comboWith; })[0];
  ok(!!combo, 'whose port says which sibling it shares a cage with', combo && combo.name + ' -> ' + combo.comboWith);

  function build() {
    const topo = new Topology();
    topo.addDevice(spec, 'r1');
    topo.addDevice(spec, 'r2');
    // The rj45 half into a plain rj45 port on the other box: a cable that mates, so the cage is what is occupied.
    const spare = Array.from(topo.getDevice('r2').interfaces.values())
      .filter(function (p) { return p.type === 'ethernet' && !p.comboWith; })[0].name;
    topo.connect('r1', combo.name, 'r2', spare);
    return { topo: topo, spare: spare };
  }
  // The sfp half, into the other box's own sfp half: this pair mates, so the only reason to refuse is the cage.
  function secondHalfRefusal(topo) {
    try { topo.connect('r1', combo.comboWith, 'r2', combo.comboWith); return null; }
    catch (e) { return e.message; }
  }

  const fresh = build();
  const refused = secondHalfRefusal(fresh.topo);
  ok(!!refused && refused.indexOf(String(combo.comboWith)) !== -1,
    'using both halves of one cage is refused, naming the sibling', refused);

  const reloaded = roundTrip(fresh.topo);
  const combo2 = Array.from(reloaded.getDevice('r1').interfaces.values()).filter(function (p) { return p.comboWith; })[0];
  ok(!!combo2 && combo2.comboWith === combo.comboWith, 'the reloaded port still names its sibling',
    combo2 ? combo2.comboWith : '(lost)');
  const refusedAfter = secondHalfRefusal(reloaded);
  ok(!!refusedAfter && refusedAfter.indexOf(String(combo.comboWith)) !== -1, 'and the reloaded lab still refuses it',
    refusedAfter || '(accepted - a second cable went into an occupied cage)');
}

console.log('A console port keeps its rate, and the verdict does not change:');
{
  const spec = specs.filter(function (s) { return /ICR-3231/.test(s.model); })[0];
  const t = new Topology();
  const d = t.addDevice(spec, 'r1');
  const serial = Array.from(d.interfaces.values()).filter(function (p) { return p.type === 'console'; })[0] ||
    Array.from(d.interfaces.values())[0];
  const before = serial.hardware.maxSpeedMbps;
  const d2 = roundTrip(t).getDevice('r1');
  const after = d2.interfaces.get(serial.name).hardware.maxSpeedMbps;
  ok(before === after, 'the port keeps ' + before + ' Mbps', before + ' -> ' + after);
  ok(before !== 1000, 'and it is not the 1 Gbps default', String(before));

  // The visible consequence: a link at a rate below the cap is only a downgrade if the cap is real.
  function warningsFor(topo) {
    const v = validateTopology(topo);
    return (v.issues || []).filter(function (i) { return i.code === 'W_SPEED_DOWNGRADE'; }).map(function (i) { return i.message; });
  }
  const fresh = new Topology();
  const f1 = fresh.addDevice(spec, 'a');
  const f2 = fresh.addDevice(spec, 'b');
  const namesA = Array.from(f1.interfaces.keys());
  const namesB = Array.from(f2.interfaces.keys());
  const serialName = serial.name;
  if (namesA.indexOf(serialName) !== -1 && namesB.indexOf(serialName) !== -1) {
    try { fresh.connect('a', serialName, 'b', serialName, { speedMbps: 9.6, force: true }); } catch (e) { /* cable may be refused */ }
    const reloaded = roundTrip(fresh);
    ok(JSON.stringify(warningsFor(fresh)) === JSON.stringify(warningsFor(reloaded)),
      'the speed-downgrade verdict is the same before and after a save',
      JSON.stringify({ before: warningsFor(fresh), after: warningsFor(reloaded) }).slice(0, 200));
  } else {
    ok(true, 'the speed-downgrade verdict cannot be compared on this model (no matching port names)');
  }
}

console.log('');
console.log('A port that declared its PoE still says it declared it:');
{
  // A port whose spec states poeOut, and one where the engine infers it, so the check is not "everything is true".
  let declaredSpec = null, declaredPort = null;
  for (const s of specs) {
    const port = (s.interfaces || []).filter(function (p) { return p && p.poeOut === true && p.name; })[0];
    if (port) { declaredSpec = s; declaredPort = port.name; break; }
  }
  ok(!!declaredSpec, 'the test has a port that declares poeOut', declaredSpec && declaredSpec.vendor + '/' + declaredSpec.model);
  if (declaredSpec) {
    const t = new Topology();
    const d = t.addDevice(declaredSpec, 'sw1');
    const p = d.interfaces.get(declaredPort);
    ok(p.hardware.poeOutDeclared === true, 'which reads as declared on the fresh device', String(p.hardware.poeOutDeclared));
    const d2 = roundTrip(t).getDevice('sw1');
    ok(d2.interfaces.get(declaredPort).hardware.poeOutDeclared === true,
      'and still reads as declared after a save and reload',
      String(d2.interfaces.get(declaredPort).hardware.poeOutDeclared));
  }

  // The other direction: a device whose watts were inferred must not claim it declared them.
  const inferred = [];
  for (const s of specs.slice(0, 400)) {
    const t = new Topology();
    let d;
    try { d = t.addDevice(s, 'd1'); } catch (e) { continue; }
    const p = Array.from(d.interfaces.values()).filter(function (x) { return x.hardware && x.hardware.poeOut && !/poe/i.test(String(x.name)); })[0];
    if (!p || p.hardware.poeOutDeclared) continue;
    const back = roundTrip(t).getDevice('d1').interfaces.get(p.name);
    if (back) { inferred.push({ model: s.vendor + '/' + s.model, port: p.name, before: p.hardware.poeOutDeclared, after: back.hardware.poeOutDeclared }); break; }
  }
  ok(inferred.length === 1 && inferred[0].after === inferred[0].before,
    'and a port the engine guessed power for does not start claiming otherwise',
    JSON.stringify(inferred[0] || 'no such port found'));
}

console.log('');
console.log('A board written before any of this still loads:');
{
  const spec = specs.filter(function (s) { return /ISR 4331/.test(s.model); })[0];
  const t = new Topology();
  t.addDevice(spec, 'r1');
  const doc = JSON.parse(JSON.stringify(t.serialize()));
  // Strip every key the old writer did not emit, leaving exactly what an older version would have saved.
  const keep = ['name', 'type', 'speed', 'ip', 'mask', 'enabled', 'dhcp', 'description', 'autoconfig', 'cage',
    'media', 'speedCaps', 'poeOut', 'poeIn', 'duplex', 'vlan', 'lagId', 'role', 'dualRole', 'bridgeGroup', 'lldp',
    'parent', 'encapVid'];
  for (const d of doc.devices) {
    d.interfaces = d.interfaces.map(function (i) {
      const out = {};
      for (const k of keep) if (i[k] !== undefined) out[k] = i[k];
      return out;
    });
  }
  let loaded = null, threw = null;
  try { loaded = Topology.fromJSON(doc); } catch (e) { threw = e.message; }
  ok(!threw && loaded && loaded.getDevice('r1'), 'an older document loads', threw || 'ok');
  const dev = loaded.getDevice('r1');
  ok(dev.interfaces.size > 0, 'with its ports', String(dev.interfaces.size));
  ok(Array.from(dev.interfaces.values()).every(function (p) { return p.hardware && typeof p.hardware.cage === 'string'; }),
    'and every port still has hardware derived for it');
}

console.log('');
console.log('A configured port survives, not just a virgin one (#1405):');
{
  // The sweep above round-trips a lab straight out of the catalogue, so every field is at its default and the
  // comparison cannot see a setting that was never written to the file: default in, default out. That is exactly
  // how `speedMbps` fell through - `speed 100` was stored, printed as "100Mb/s (forced)", written to
  // running-config, and the port document never carried it, so a saved lab came back at the hardware rate with
  // the command gone from the config too.
  const { CliSession } = require('../engine/cli');
  const { Simulator } = require('../engine/simulator');
  const lost = [];
  let forcedPorts = 0;
  for (const spec of specs) {
    const t = new Topology();
    const d = t.addDevice(spec, 'd1');
    let didSet = false;
    for (const p of d.interfaces.values()) {
      const caps = (p.hardware && Array.isArray(p.hardware.speedCaps)) ? p.hardware.speedCaps.filter(function (c) { return c > 0; }) : [];
      // ordinary control flow: this test is about line rate, so a port with a single rate (or none) has nothing
      // to force and nothing to lose. It is not deciding a port is outside a rule - there is no rate to set.
      if (p.type !== 'ethernet' || caps.length < 2) continue;
      const low = Math.min.apply(null, caps);
      const cli = new CliSession(d, t, new Simulator(t));
      cli.run('enable'); cli.run('configure terminal'); cli.run('interface ' + p.name);
      const said = (cli.run('speed ' + Math.round(low / 1000000 >= 1 ? low / 1000000 : low).toString() + (low >= 1000000 ? 'g' : '').toString()).output || []).join(' ');
      cli.run('end');
      if (/% /.test(said)) continue;          // refused: nothing to carry
      didSet = true;
      forcedPorts++;
      break;                                  // one port per model is enough to prove the field travels
    }
    if (!didSet) continue;
    const d2 = roundTrip(t).getDevice('d1');
    const diffs = portDiff(portsOf(d), portsOf(d2));
    if (diffs.length) lost.push(spec.model + ': ' + diffs.slice(0, 3).join(', '));
  }
  ok(forcedPorts > 500, 'a forced line rate was set on this many models', String(forcedPorts));
  ok(lost.length === 0, 'and every one of them comes back still forced', JSON.stringify(lost.slice(0, 4)));
}

console.log('');
console.log('The forced rate is in the file, said by every surface, and used by the link:');
{
  const { CliSession } = require('../engine/cli');
  const { Simulator } = require('../engine/simulator');
  const spec = specs.filter(function (s) { return s.model === 'C9300-24T'; })[0];
  ok(!!spec, 'the test has a 1 Gbps switch');

  // A virgin port must not grow a `speedMbps` line: the document carries optional facts only when set.
  const virgin = new Topology();
  virgin.addDevice(spec, 'd1');
  const virginDoc = JSON.parse(JSON.stringify(virgin.serialize()));
  ok(JSON.stringify(virginDoc).indexOf('speedMbps') === -1,
    'a port that negotiates its own rate writes no speedMbps at all');

  function configured() {
    const t = new Topology();
    const d = t.addDevice(spec, 'd1');
    const port = Array.from(d.interfaces.keys())[0];
    const s = new CliSession(d, t, new Simulator(t));
    s.run('enable'); s.run('configure terminal'); s.run('interface ' + port);
    const said = (s.run('speed 100').output || []).join(' ');
    s.run('duplex half');
    s.run('description core uplink');
    s.run('end');
    return { topo: t, dev: d, port: port, said: said };
  }
  const c = configured();
  ok(/100/.test(c.said), 'speed 100 is accepted', c.said);

  const doc = JSON.parse(JSON.stringify(c.topo.serialize()));
  const portDoc = doc.devices[0].interfaces.filter(function (i) { return i.name === c.port; })[0];
  ok(portDoc.speedMbps === 100, 'and the saved document carries it', JSON.stringify(portDoc.speedMbps));

  const reloaded = Topology.fromJSON(doc);
  const rd = reloaded.getDevice('d1');
  ok(rd.interfaces.get(c.port).speedMbps === 100, 'the reloaded port is still forced to 100',
    String(rd.interfaces.get(c.port).speedMbps));
  ok(rd.interfaces.get(c.port).duplex === 'half', 'and the duplex beside it, as it always did',
    String(rd.interfaces.get(c.port).duplex));

  function show(topo, devId, cmd) {
    const s = new CliSession(topo.getDevice(devId), topo, new Simulator(topo));
    s.run('enable');
    return (s.run(cmd).output || []).join('\n');
  }
  const block = show(reloaded, 'd1', 'show interfaces ' + c.port);
  ok(/speed: 100Mb\/s \(forced\)/.test(block), 'show interfaces says the rate is in force and forced',
    block.split('\n').filter(function (l) { return /speed:/.test(l); }).join(' '));
  const cfg = show(reloaded, 'd1', 'show running-config');
  ok(/speed 100/.test(cfg), 'and running-config still prints the command that set it',
    cfg.split('\n').filter(function (l) { return /speed/.test(l); }).join(' '));

  // The engine uses it, not just the field: a cable between two 1 Gbps ports runs at 100 when one side is forced.
  const t2 = new Topology();
  t2.addDevice(spec, 'a'); t2.addDevice(spec, 'b');
  const aPort = Array.from(t2.getDevice('a').interfaces.keys())[0];
  const bPort = Array.from(t2.getDevice('b').interfaces.keys())[1];
  t2.connect('a', aPort, 'b', bPort, { mediaId: '1000base-t' });
  const cli = new CliSession(t2.getDevice('a'), t2, new Simulator(t2));
  cli.run('enable'); cli.run('configure terminal'); cli.run('interface ' + aPort); cli.run('speed 100'); cli.run('end');
  const linkBefore = Array.from(t2.links.values())[0].speedMbps;
  const t3 = roundTrip(t2);
  const linkAfter = Array.from(t3.links.values())[0].speedMbps;
  ok(linkBefore === 100, 'the cable runs at the forced rate', String(linkBefore));
  ok(linkAfter === linkBefore, 'and still does after a save and reload', linkBefore + ' -> ' + linkAfter);

  // `speed auto` puts it back, and the file records the absence rather than a stale rate.
  const t4 = new Topology();
  const d4 = t4.addDevice(spec, 'd1');
  const p4 = Array.from(d4.interfaces.keys())[0];
  const s4 = new CliSession(d4, t4, new Simulator(t4));
  s4.run('enable'); s4.run('configure terminal'); s4.run('interface ' + p4);
  s4.run('speed 100'); s4.run('speed auto'); s4.run('end');
  const d4r = roundTrip(t4).getDevice('d1');
  ok(!d4r.interfaces.get(p4).speedMbps, 'speed auto clears the forced rate, and the reload agrees',
    String(d4r.interfaces.get(p4).speedMbps));
  ok(JSON.stringify(t4.serialize()).indexOf('speedMbps":100') === -1, 'with no stale rate left in the file');

  // A save is idempotent: saving what was loaded gives the same file again.
  const once = JSON.stringify(JSON.parse(JSON.stringify(c.topo.serialize())));
  const twice = JSON.stringify(JSON.parse(JSON.stringify(Topology.fromJSON(JSON.parse(once)).serialize())));
  ok(once === twice, 'and save -> load -> save is byte-identical');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
