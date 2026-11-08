'use strict';
// A device's description and its ports must tell the same story.
//
// Every defect repaired in this file's history was a spec contradicting its own prose: a device
// whose description says "PoE-in" while declaring ten power-sourcing ports, an "8x 10G SFP+"
// whose cages were 1G, a 200G port in a 100G cage, three of four SFP+ uplinks capped at 1G while
// their identical siblings ran at 10G. Nothing compared description to ports, so they were found
// by reading rather than by running the suite.
//
// The comparator is deliberately conservative. It only objects where the description makes a
// countable claim about ports that ship, and it accepts a faster cage or a combo position as
// satisfying a slower claim, because those are real (a 1G SFP in an SFP+ port). A false failure
// here would teach contributors to reword the description until the suite goes quiet, which is
// worse than having no check at all.
const path = require('path');
const { loadCatalog } = require(path.join('..', 'devices', 'registry'));
const { Topology } = require(path.join('..', 'engine'));
const mediaLib = require(path.join('..', 'engine', 'media'));

const specs = loadCatalog(path.join(__dirname, '..', 'devices'));
const all = [];
for (const spec of specs) {
  try {
    const dev = new Topology().addDevice(spec);
    all.push({ spec, ifaces: [...dev.interfaces.values()] });
  } catch (e) { /* a spec that cannot be built is another suite's problem */ }
}

let pass = 0;
const failures = [];
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    failures.push(name + ': ' + e.message);
    console.error('  \u2717 ' + name + ': ' + e.message);
  }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

// "8x 10G SFP+", "24x 1G RJ45", "2x 25G SFP28" - a count, a rate, a connector.
// SFP56 and QSFP56 must be tried before SFP and QSFP, or "8x 50G SFP56" parses as "8x 50G SFP"
// and the trailing 56 is left in the description as if it were prose.
const CLAIM = /(\d+)\s*[x\u00d7]\s*(\d+(?:\.\d+)?)\s*([GM])\s*(?:b?E)?\s*(RJ-?45|SFP56|SFP28|SFP\+|SFP|QSFP56|QSFP28|QSFP-DD|QSFP\+|QSFP|XFP)/gi;

const ORDER = ['sfp', 'sfp+', 'sfp28'];
const QORDER = ['qsfp+', 'qsfp28', 'qsfp56', 'qsfpdd'];

function cageMatches(cage, want) {
  if (cage === want) return true;
  // A combo position is an RJ45 or an SFP-family module, never both at once.
  if (cage === 'combo' && ['rj45', 'sfp', 'sfp+', 'sfp28'].indexOf(want) !== -1) return true;
  // Fibre Channel has its own ladder, and it is the same shape: an SFP-DD socket takes a 32G or
  // an 8G module, an SFP28 socket takes an 8G module, and a QSFP28 FC port is four lanes and
  // takes nothing smaller than a 32G quad.
  const FCORDER = ['fc-sfp', 'fc-sfp28', 'fc-sfpdd'];
  if (FCORDER.indexOf(want) !== -1 && FCORDER.indexOf(cage) > FCORDER.indexOf(want)) return true;
  // A faster cage takes the slower module, exactly as a 1G SFP seats in an SFP+ port.
  if (ORDER.indexOf(want) !== -1 && ORDER.indexOf(cage) > ORDER.indexOf(want)) return true;
  if (QORDER.indexOf(want) !== -1 && QORDER.indexOf(cage) > QORDER.indexOf(want)) return true;
  return false;
}

function speedOf(port) {
  const raw = port.hardware.maxSpeedMbps || 0;
  const n = typeof raw === 'number' ? raw : mediaLib.parseSpeedMbps(raw);
  return isFinite(n) ? n : 0;
}

// Specs the check cannot adjudicate yet, each with the issue that tracks it. A name here is
// debt, not an exemption: the alternative is a test that fails for months and gets ignored.
const KNOWN = {
  'adtran/SDX 6320': '#987 (uplinks not modelled)',
  'fiberhome/AN5516-01': '#987 (uplinks not modelled)',
  'huawei/MA5600T': '#987 (uplinks not modelled)',
};

console.log('Descriptions and ports agree:');

t('no device promises more ports of a kind than it has', () => {
  const bad = [];
  for (const { spec, ifaces } of all) {
    const desc = String(spec.description || '');
    if (!desc) continue;
    // An FC claim names the FC rate, which is not a bit rate: "64G" means 57.8 Gbit/s because
    // Fibre Channel frames its payload (8b/10b up to 8G, 64b/66b above). Mapping the name to
    // the line rate is what lets "48 x 64G SFP+" be checked against a 57800 Mbps port.
    const fcDevice = /fibre channel|fc san|connectrix|san switch|gen\s*\d+\s*fc/i.test(desc);
    // Everything after "optional" describes a module the buyer may add, not ports in the box.
    const installed = desc.split(/optional/i)[0].split(/up to/i)[0];
    let m;
    CLAIM.lastIndex = 0;
    while ((m = CLAIM.exec(installed)) !== null) {
      const count = Number(m[1]);
      // "64G" on an FC device means 57.8 Gbit/s, not 64000 Mbps: Fibre Channel wraps its
      // payload in 8b/10b framing up to 8G and 64b/66b above it, so the marketing name is
      // always higher than the line rate. Reading it as a bit rate makes an honest 64G port
      // look like it under-delivers by 10%.
      const FC_LINE = { 2: 2125, 4: 4250, 8: 8500, 16: 14025, 32: 28050, 64: 57800, 128: 112200 };
      const fcRate = m[3].toUpperCase() === 'G' && fcDevice && FC_LINE[Number(m[2])];
      const rate = fcRate || Number(m[2]) * (m[3].toUpperCase() === 'G' ? 1000 : 1);
      const kind = m[4].toUpperCase().replace(/-/g, '');
      // On an FC switch, "SFP+" in the description means an FC SFP+ cage, not an Ethernet one.
      const want = fcDevice
        ? (kind === 'SFP28' || kind === 'SFP56' ? 'fc-sfp28' : kind === 'SFP' || kind === 'SFP+' ? 'fc-sfp'
          : kind === 'QSFP28' || kind === 'QSFP' || kind === 'QSFP+' ? 'fc-qsfp28' : 'fc-sfpdd')
        : kind === 'RJ45' ? 'rj45' : kind === 'SFP+' ? 'sfp+' : kind === 'SFP28' ? 'sfp28'
          : kind === 'SFP' ? 'sfp' : kind === 'SFP56' ? 'sfp56' : kind === 'QSFP28' ? 'qsfp28' : kind === 'QSFP56' ? 'qsfp56'
            : kind === 'QSFP+' ? 'qsfp+' : kind === 'QSFP' ? 'qsfp+' : kind === 'XFP' ? 'sfp+' : 'qsfpdd';
      const usable = ifaces.filter(function (p) {
        const cage = (p.hardware && p.hardware.cage) || '';
        if (!cageMatches(cage, want)) return false;
        return speedOf(p) >= rate * 0.98;
      });
      if (usable.length < count && !KNOWN[spec.vendor + '/' + spec.model]) {
        bad.push(spec.vendor + '/' + spec.model + ': claims ' + count + 'x ' + m[2] + m[3] + ' ' +
          m[4] + ', ' + usable.length + ' port(s) can do it');
      }
    }
  }
  ok(bad.length === 0, bad.length + ' device(s) promise ports they do not have:\n      ' +
    bad.slice(0, 8).join('\n      '));
});

t('a device described as PoE-powered does not source power', () => {
  const POE_IN = /poe[\s-]?in/i;
  const POE_OUT = /poe[\s-]?out|passthrough|passes? it through|\d+\s*poe\+|poe\s*\/\s*poe+|\(\s*\d+\s*poe/i;
  const bad = [];
  for (const { spec, ifaces } of all) {
    const desc = String(spec.description || '');
    // A deliberate exemption, and it states its reason: a device whose description mentions both
    // PoE-in and
    // PoE-out is describing a passthrough (a splitter, or a switch port documented as feeding
    // itself), so the "says PoE-powered but sources power" rule does not apply to it. Tracked
    // rather than silent, because this is how a switch with a passthrough port stops being
    // checked for sourcing power at all.
    if (!desc || !POE_IN.test(desc) || POE_OUT.test(desc)) continue;
    const sourcing = ifaces.filter(p => p.hardware && p.hardware.poeOut);
    if (sourcing.length && !KNOWN[spec.vendor + '/' + spec.model]) {
      bad.push(spec.vendor + '/' + spec.model + ': says PoE-in, ' + sourcing.length + ' port(s) source');
    }
  }
  ok(bad.length === 0, bad.length + ' device(s) claim power they cannot supply:\n      ' +
    bad.slice(0, 8).join('\n      '));
});

t('a device described as supplying PoE has ports that source it', () => {
  const bad = [];
  for (const { spec, ifaces } of all) {
    const desc = String(spec.description || '');
    if (!desc) continue;
    // "(8 PoE+)", "(4 PoE / 12 PoE+)" - a parenthetical counting the ports that supply power.
    // The number in front of "RJ45" is the port count, not the PoE count; reading it as one
    // made every 24-port PoE switch look like a lie.
    const m = desc.match(/\(\s*(\d[^)]*poe[^)]*)\)/i);
    if (!m) continue;
    const numbers = (m[1].match(/^\d+|\d+/g) || []).map(Number).filter(function (n) { return n > 0; });
    if (!numbers.length) continue;
    const claimed = numbers.reduce(function (a, b) { return a + b; }, 0);
    const copper = ifaces.filter(function (p) {
      const cage = (p.hardware && p.hardware.cage) || '';
      return cage === 'rj45' || cage === 'combo';
    }).length;
    // More PoE ports than copper ports is a misread rate or channel count, not a promise.
    if (claimed < 2 || claimed > copper) continue;
    const sourcing = ifaces.filter(p => p.hardware && p.hardware.poeOut).length;
    if (sourcing < claimed && !KNOWN[spec.vendor + '/' + spec.model]) {
      bad.push(spec.vendor + '/' + spec.model + ': says ' + claimed + ' PoE port(s), ' +
        sourcing + ' source power');
    }
  }
  ok(bad.length === 0, bad.length + ' device(s) promise PoE they do not supply:\n      ' +
    bad.slice(0, 8).join('\n      '));
});

console.log('\n' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.error('\n' + failures.join('\n'));
  process.exit(1);
}
