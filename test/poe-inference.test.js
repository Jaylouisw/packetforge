'use strict';

// Power over Ethernet, as a property of the port rather than the product name.
//
// Issue #105: PSE inference keyed on the device's model/label text and then applied to
// every port the device had. Three classes of wrong answer came out of that:
//
//   - 89 PSE ports sitting on fibre cages (an EdgeSwitch's SFP slots, an Aruba 6000's 10G
//     cages). A cage cannot source watts; validation has nothing sensible to say about a
//     link whose far end is supposed to be powered down a strand of single-mode glass.
//   - an NVR's LAN uplink marked as a power source, because the label mentions "16 PoE
//     ports" and the label was treated as a whole-device property.
//   - 24 devices advertising PSE with no wattage behind it.
//
// The rule now: the cage decides whether power can flow at all, then the port's own name
// decides, and only a switch is allowed to promote its whole access-port population from a
// label. These tests hold that line over the real catalogue, not over a fixture, because the
// catalogue is what was wrong.

const path = require('path');
const assert = require('assert');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const { derivePortHardware, CAGES } = require('../engine/media');

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass++; } catch (err) { fails.push(name + ': ' + err.message); }
}

const ROOT = path.join(__dirname, '..');
const catalogue = loadCatalog(path.join(ROOT, 'devices'));

// Every device, expanded exactly the way the simulator expands it.
function expandAll() {
  const out = [];
  for (const spec of catalogue) {
    let dev;
    try { dev = new Topology().addDevice(spec); } catch (err) { continue; }
    const ifaces = dev.interfaces instanceof Map ? [...dev.interfaces.values()] : [];
    if (ifaces.length) out.push({ spec, dev, ifaces });
  }
  return out;
}

const all = expandAll();
const SWITCHY = ['switch', 'l3-switch'];
const COPPER = ['rj45', 'combo'];

// ---------------------------------------------------------------------------
// The catalogue-wide rules
// ---------------------------------------------------------------------------

t('no port on a non-copper cage sources power', () => {
  const offenders = [];
  for (const { spec, ifaces } of all) {
    for (const p of ifaces) {
      if (p.hardware.poeOut && COPPER.indexOf(p.hardware.cage) === -1) {
        offenders.push(spec.vendor + '/' + spec.model + ' ' + p.name + ' (' + p.hardware.cage + ')');
      }
    }
  }
  assert.deepStrictEqual(offenders.slice(0, 8), [],
    offenders.length + ' PSE port(s) on a cage that cannot carry power');
});

t('no port on a non-copper cage draws power either', () => {
  const offenders = [];
  for (const { spec, ifaces } of all) {
    for (const p of ifaces) {
      if (p.hardware.poeIn && COPPER.indexOf(p.hardware.cage) === -1) {
        offenders.push(spec.vendor + '/' + spec.model + ' ' + p.name + ' (' + p.hardware.cage + ')');
      }
    }
  }
  assert.deepStrictEqual(offenders.slice(0, 8), [],
    offenders.length + ' PD port(s) on a cage that cannot carry power');
});

t('off a switch, power is only sourced where the datasheet says so', () => {
  // A declared PoE output is a statement about hardware. An inferred one is the engine filling
  // a silence from the device class, and on a device that does not switch that guess puts watts
  // on ports nobody documented - the defect that once put 89 PSE ports on fibre cages (#105).
  // Only the guess is the offence here. A declaration that is simply wrong is a data bug, and
  // the fix for it is the spec file, not this rule.
  const offenders = [];
  for (const { spec, ifaces } of all) {
    if (SWITCHY.indexOf(String(spec.category)) !== -1) continue;
    for (const p of ifaces) {
      if (p.hardware.poeOut && !p.hardware.poeOutDeclared) {
        offenders.push(spec.vendor + '/' + spec.model + ' ' + p.name);
      }
    }
  }
  assert.deepStrictEqual(offenders.slice(0, 8), [],
    offenders.length + ' port(s) source power only because the engine guessed it, on a non-switch');
});

t('a label that denies PoE is not a claim that the box sources it', () => {
  // The EnGenius non-PoE rows carry their own denial in the label: "EnGenius ECS1528
  // (24x 1G, 4x SFP+, no PoE)". A `/poe/i` test over the label read that word as the claim,
  // and the engine inferred 802.3af on every copper port of three switches whose vendor
  // comparison table prints "PoE Capable Ports: -" and "Total PoE Budget: -" for each of
  // them (https://www.engeniustech.com/eu/products/network-switches/ecs2512fp/). The rule
  // strips the negation before it looks for the word, so the three rows source nothing.
  const offenders = [];
  const denying = all.filter(x => /\bno\s+poe\b/i.test(String(x.spec.label || '')));
  for (const { spec, ifaces } of denying) {
    const pse = ifaces.filter(p => p.hardware.poeOut);
    if (pse.length) offenders.push(spec.vendor + '/' + spec.model + ' (' + pse.length + ' PSE)');
  }
  assert.deepStrictEqual(offenders, [],
    offenders.length + ' device(s) source power although their own label says no PoE');
});

t('the EnGenius non-PoE trio sources nothing, and the console says so', () => {
  const { Simulator, runCommands } = require('../engine');
  for (const model of ['ECS1528', 'ECS2512', 'ECS5512']) {
    const spec = catalogue.find(s => String(s.model) === model);
    assert.ok(spec, model + ' must exist in the catalogue');
    const topo = new Topology();
    const dev = topo.addDevice(spec);
    const sim = new Simulator(topo);
    sim.computePoe();
    const pse = ports(dev).filter(p => p.hardware.poeOut).map(p => p.name);
    assert.deepStrictEqual(pse, [], model + ' must not source power (vendor table prints "-" for PoE)');
    const lines = runCommands(dev, topo, sim, ['show power inline']).lines;
    assert.ok(lines.some(l => /^% No PoE on /.test(l)),
      model + ' must answer with the no-PoE refusal, got: ' + lines.slice(-2).join(' / '));
  }
});

t('a device that only accepts PoE never sources it', () => {
  // Each of these says "PoE-in" in its own description. Their specs declared every port a PSE
  // anyway, which is a claim the hardware does not support: an EdgeRouter 10X with 10 self-
  // powered ports is not an EdgeRouter 10X.
  //
  // ER-10X left this list on 2026-11-19, and the reason is that it is not a PoE-in-only box: its
  // own tech-spec table prints both sockets - "PoE In: (1) 24V passive PoE port, 2-pair (4, 5+;
  // 7, 8-)" and "PoE Out: (1) 24V passive PoE port, 2-pair (4, 5+; 7, 8-)" - with "Passive PoE
  // output = DC/PoE passthrough" (https://techspecs.ui.com/uisp/wired/er-10x, 200, 576,148 B).
  // The original complaint is kept as its own assertion below, where it belongs: one outlet,
  // not ten.
  //
  // EP-R6 left this list on 2026-11-19 for the same reason ER-10X did: it is not a PoE-in-only
  // box. It was put here because its description said "Passive PoE-in" - prose written before
  // anyone read the box's own table, which prints both directions: "Passive PoE Input (1) 24V /
  // 1.4A, 4-Pair ... eth0" and "Passive PoE Output (5) 24V / 0.7A, 2-Pair ... eth0 to eth4"
  // (https://dl.ui.com/datasheets/edgemax/EdgePoint_DS.pdf, page 6; the same rows at
  // https://techspecs.ui.com/uisp/wired/ep-r6, 200, 577,753 B). A list built from descriptions
  // inherits whatever the descriptions got wrong. The five outlets are pinned in the assertion
  // below and in test/edgepoint-poe.test.js.
  const PD_ONLY = ['ACB-AC'];
  for (const model of PD_ONLY) {
    const spec = all.find(x => String(x.spec.model) === model);
    assert.ok(spec, model + ' must exist in the catalogue');
    const sourcing = spec.ifaces.filter(p => p.hardware.poeOut);
    assert.deepStrictEqual(sourcing.map(p => p.name), [],
      model + ' accepts PoE and must not source it (' + /poe-in/i.test(spec.spec.description || '') + ')');
    const sinking = spec.ifaces.filter(p => p.hardware.poeIn);
    assert.ok(sinking.length > 0, model + ' must still accept power on at least one port');
  }
});

t('the EdgePoint R6 sources on all five copper ports and sinks on eth0 only', () => {
  // The row that came out of PD_ONLY above, pinned where the rest of the family is pinned: the
  // vendor prints one PoE OUT row covering every copper port ("(5) 24V / 0.7A, 2-Pair ... eth0 to
  // eth4") and one PoE IN row for eth0 alone. 24V x 0.7A = 16.8 W out; the 7 W figure is the box's
  // own max draw, not a port capacity.
  const spec = all.find(x => String(x.spec.model) === 'EP-R6');
  assert.ok(spec, 'EP-R6 must exist in the catalogue');
  const sourcing = spec.ifaces.filter(p => p.hardware.poeOut).map(p => p.name);
  assert.deepStrictEqual(sourcing, ['eth0', 'eth1', 'eth2', 'eth3', 'eth4'],
    'EP-R6 sources 24V passive PoE on all five copper ports');
  const sinking = spec.ifaces.filter(p => p.hardware.poeIn).map(p => p.name + '=' + p.hardware.poeIn);
  assert.deepStrictEqual(sinking, ['eth0=7'],
    'and sinks only on eth0, at the 7 W the vendor prints as its max draw');
});

t('the EdgeRouter 10X sources power on one passthrough port, and nowhere else', () => {
  // The defect the PD_ONLY entry above was written for was ten self-powered ports, and the fix was
  // to leave the row sourcing nothing at all - which broke the other half of the same vendor row:
  // the unit has a 24V passive PoE **outlet** ("Passive PoE output = DC/PoE passthrough",
  // "Passive PoE Max. wattage per port = 15W (24V, 0.63A)"), so `show power inline` answered
  // "no port on this device can supply power" on a router that passes power to an AP. The count
  // is what this pins: one outlet at 15 W, one inlet at the unit's own 8 W draw.
  const spec = all.find(x => String(x.spec.model) === 'ER-10X');
  assert.ok(spec, 'ER-10X must exist in the catalogue');
  const sourcing = spec.ifaces.filter(p => p.hardware.poeOut).map(p => p.name);
  assert.deepStrictEqual(sourcing, ['eth9'],
    'ER-10X sources on its one 24V passive passthrough outlet only, not on ten ports');
  const sinking = spec.ifaces.filter(p => p.hardware.poeIn).map(p => p.name + '=' + p.hardware.poeIn);
  assert.deepStrictEqual(sinking, ['eth0=8'],
    'and sinks only on its one 24V passive inlet, at the 8 W the vendor prints as its max draw');
});

t('a switch that claims a PoE budget actually sources power', () => {
  // The first cut of the #105 fix required category === 'switch' and silently left the
  // Aruba 2930F family - an l3-switch - with 370 W of budget and nothing to spend it on.
  // hardware-invariants caught it; this pins the reason.
  const idle = [];
  for (const { spec, ifaces } of all) {
    if ((spec.poe && (spec.poe.budget || spec.poe.budgetW)) === undefined && !spec.poeBudget) continue;
    const budget = (spec.poe && (spec.poe.budget || spec.poe.budgetW)) || spec.poeBudget || 0;
    const pse = ifaces.filter(p => p.hardware.poeOut).length;
    if (budget > 0 && pse === 0) idle.push(spec.vendor + '/' + spec.model + ' (' + budget + ' W, 0 PSE)');
  }
  assert.deepStrictEqual(idle, [], idle.length + ' device(s) claim a budget with no port to source it');
});

// ---------------------------------------------------------------------------
// The specific devices that were wrong
// ---------------------------------------------------------------------------

function device(match) {
  const spec = catalogue.find(s => match.test(s.model));
  assert.ok(spec, 'catalogue is missing ' + match);
  return new Topology().addDevice(spec);
}
function ports(dev) { return dev.interfaces instanceof Map ? [...dev.interfaces.values()] : []; }
function byName(dev, re) { return ports(dev).find(p => re.test(String(p.name))); }

t('an NVR powers its camera ports and not its uplink', () => {
  const nvr = device(/DS-7616NXI-K2\/16P/);
  const lan = byName(nvr, /^LAN$/i);
  const cam = byName(nvr, /^PoE 1$/);
  assert.ok(lan, 'the NVR should have a LAN port');
  assert.strictEqual(lan.hardware.poeOut, null, 'the uplink must not source power');
  assert.ok(cam && cam.hardware.poeOut > 0, 'the camera ports must source power');
  assert.strictEqual(ports(nvr).filter(p => p.hardware.poeOut).length, 16,
    'exactly the 16 camera ports, not all 17 ports');
});

t('a PoE switch powers copper and not fibre', () => {
  const sw = device(/^ES-24-250W$/);
  const sfp = byName(sw, /SFP 1/);
  assert.ok(sfp, 'the EdgeSwitch has SFP slots');
  assert.strictEqual(sfp.hardware.poeOut, null, 'an SFP cage cannot source power');
  const copper = ports(sw).filter(p => p.hardware.poeOut);
  assert.strictEqual(copper.length, 24, 'all 24 copper ports source power');
  assert.ok(copper.every(p => COPPER.indexOf(p.hardware.cage) !== -1));
});

t('an l3-switch with a PoE budget still sources power', () => {
  const sw = device(/2930F 48G PoE\+/);
  assert.ok(ports(sw).filter(p => p.hardware.poeOut).length > 0,
    'a 370 W access switch must have ports to spend it on');
});

t('an IP camera is a powered device, not a power source', () => {
  for (const re of [/M2036-LE/, /IPC-HDW2431T/, /DS-2CD2347G2/, /QNV-8080R/]) {
    const cam = device(re);
    const eth = ports(cam)[0];
    assert.ok(eth.hardware.poeIn > 0, String(re) + ' should draw power');
    assert.strictEqual(eth.hardware.poeOut, null, String(re) + ' must not source power');
  }
});

// ---------------------------------------------------------------------------
// The rule itself, on synthetic specs
// ---------------------------------------------------------------------------

const switchSpec = { vendor: 't', model: 'poe switch', category: 'switch', label: 'PoE switch' };
const nvrSpec = { vendor: 't', model: 'nvr 16P', category: 'nvr', label: 'NVR with 16 PoE ports' };
const routerSpec = { vendor: 't', model: 'router poe', category: 'router', label: 'PoE passthrough router' };

t('a PoE switch promotes its unnamed access ports', () => {
  const hw = derivePortHardware({ name: 'port7', type: 'ethernet', speed: '1G' }, switchSpec);
  assert.strictEqual(hw.cage, 'rj45');
  assert.strictEqual(hw.poeOut, 15.4);
});

t('a PoE switch does not promote a fibre cage', () => {
  const hw = derivePortHardware({ name: 'sfp1', type: 'ethernet', speed: '10G', cage: 'sfp+' }, switchSpec);
  assert.strictEqual(hw.cage, 'sfp+');
  assert.strictEqual(hw.poeOut, null, 'sfp+ cannot carry power');
});

t('an NVR promotes only its named PoE ports', () => {
  const lan = derivePortHardware({ name: 'LAN', type: 'ethernet', speed: '1G' }, nvrSpec);
  const poe = derivePortHardware({ name: 'PoE 3', type: 'ethernet', speed: '100M' }, nvrSpec);
  assert.strictEqual(lan.poeOut, null);
  assert.strictEqual(poe.poeOut, 15.4);
});

t('a router with a PoE port powers that port and not its WAN', () => {
  const wan = derivePortHardware({ name: 'wan', type: 'ethernet', speed: '1G' }, routerSpec);
  const p = derivePortHardware({ name: 'PoE out', type: 'ethernet', speed: '1G' }, routerSpec);
  assert.strictEqual(wan.poeOut, null, 'a WAN port does not source power');
  assert.strictEqual(p.poeOut, 15.4);
});

t('an explicit wattage always beats the inferred 15.4 W', () => {
  const hw = derivePortHardware({ name: 'port1', type: 'ethernet', speed: '1G', hardware: { poeOut: 60 } }, switchSpec);
  assert.strictEqual(hw.poeOut, 60, '802.3bt ports are not 802.3af ports');

  const explicitOff = derivePortHardware(
    { name: 'port2', type: 'ethernet', speed: '1G', hardware: { poeOut: null, poeIn: null } }, switchSpec);
  assert.strictEqual(explicitOff.poeOut, 15.4,
    'null means "not stated", so inference still applies - only a number is a decision');

  const zero = derivePortHardware({ name: 'port3', type: 'ethernet', speed: '1G', hardware: { poeOut: 0 } }, switchSpec);
  assert.strictEqual(zero.poeOut, 0, '0 is a stated value: this port sources nothing');
});

t('a spec that marks one port PD leaves the others alone', () => {
  const spec = { vendor: 't', model: 'pnl', category: 'iot', label: 'IoT thing' };
  const a = derivePortHardware({ name: 'eth0', type: 'ethernet', speed: '1G', poeIn: 12.95 }, spec);
  const b = derivePortHardware({ name: 'eth1', type: 'ethernet', speed: '1G' }, spec);
  assert.strictEqual(a.poeIn, 12.95);
  assert.strictEqual(b.poeIn, null, 'inference must not leak onto a port the spec left silent');
});

t('combo ports can source power, because the copper half is a real socket', () => {
  const hw = derivePortHardware({ name: 'ge1', type: 'ethernet', speed: '1G', cage: 'combo' }, switchSpec);
  assert.strictEqual(hw.poeOut, 15.4);
});

t('every cage is classified as carrying power or not, with no third answer', () => {
  const copper = Object.keys(CAGES).filter(k => COPPER.indexOf(k) !== -1);
  assert.deepStrictEqual(copper.sort(), ['combo', 'rj45']);
  for (const name of Object.keys(CAGES)) {
    const carries = COPPER.indexOf(name) !== -1;
    const hw = derivePortHardware({ name: 'p', type: 'ethernet', speed: '1G', cage: name }, switchSpec);
    assert.strictEqual(!!hw.poeOut, carries, name + ' should ' + (carries ? '' : 'not ') + 'carry power');
  }
});

// ---------------------------------------------------------------------------

console.log('');
if (fails.length) {
  console.log(fails.length + ' failed, ' + pass + ' passed');
  fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(pass + ' passed, 0 failed');
