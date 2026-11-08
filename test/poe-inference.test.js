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

t('off a switch, only ports that name themselves PoE source power', () => {
  const offenders = [];
  for (const { spec, ifaces } of all) {
    if (SWITCHY.indexOf(String(spec.category)) !== -1) continue;
    for (const p of ifaces) {
      if (p.hardware.poeOut && !/poe/i.test(String(p.name))) {
        offenders.push(spec.vendor + '/' + spec.model + ' ' + p.name);
      }
    }
  }
  assert.deepStrictEqual(offenders.slice(0, 8), [],
    offenders.length + ' inferred PSE port(s) that are not named PoE on a non-switch');
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
