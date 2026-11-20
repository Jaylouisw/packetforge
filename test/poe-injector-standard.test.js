'use strict';
// poe-injector-standard.test.js -- the standard a midspan claims, against the watts it sources.
//
// A single-port midspan injects exactly one standard's power, so its spec sheet is a statement
// about a standard and a wattage at once. Three entries in the catalogue disagreed with
// themselves: every device that declared `802.3at` while sourcing more than 30 W per port was a
// midspan whose own vendor page said 802.3bt.
//
//   * microchip PD-9501GCO: a 60 W port, `capabilities: ["poe-injector", "802.3at"]`, while the
//     vendor page reads "1 port, 60W, IEEE 802.3bt outdoor PoE midspan" and "Regulatory
//     compliance: IEEE 802.3bt type 3, IEEE 802.3af/at (PoE)".
//   * phihong POE60U-1BT-2-R: a 60 W port, `802.3at` alone, while the page reads "IEEE802.3bt
//     PoE Injector - Single-Port - 60W" and the data sheet's detection row is "IEEE802.3af/at/bt".
//   * phihong POE90U-1BT-N6-R: a 90 W port and *no* standard declared at all, while the page
//     reads "POE Injector 90W Midspan with SNMP - IEEE802.3bt".
//
// The ceilings are the standards', not this test's: 802.3af is 15.4 W at the PSE, 802.3at 30 W,
// 802.3bt 60 W for Type 3 and 90 W for Type 4 - Cisco Catalyst 9000 PoE Configuration Guide,
// Table 1, https://www.cisco.com/c/en/us/td/docs/switches/lan/c9000/infra/poe/poe-configuration-guide/g-poe/c-poe.html
// (read 2026-11-20). A midspan cannot be an 802.3at PSE at 60 W, and a 90 W injector that names
// no standard has not said what it speaks.
//
// The rule is scoped to `poe-injector`, and deliberately so. A *switch* may pair "PoE+" with a
// wattage above 30 W as a vendor over-power mode: PLANET's IGS-5225-8P4S page states "802.3at/
// end-span PSE on ports 1-8, 36 W a port at the top of the range", and three IGS-5225 entries and
// the GS-4210-48P4S carry 36 W on an 802.3at switch. That is the vendor's own pairing of a
// standard with a proprietary mode, not a midspan's single claim, so those entries are outside
// this gate. research/poe-injector-standard-claims.md records the reading, the sources and the
// cases left unresolved.

const path = require('path');
const { loadCatalog, effectiveInterfaces } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const CATALOGUE = loadCatalog(path.join(ROOT, 'devices'));

// The PSE ceiling each standard names, in the order a spec would climb them.
const CEILINGS = [['802.3af', 15.4], ['802.3at', 30], ['802.3bt', 90]];
const CEILING_OF = Object.fromEntries(CEILINGS);

// The highest standard a spec declares, or null when it declares none. "Declares none" is not a
// claim about a standard, so it is not read as one - except above 15.4 W, where a midspan that
// says nothing has left the question open on a port that cannot be 802.3af.
function declaredStandard(spec) {
  const caps = spec.capabilities || [];
  let highest = null;
  for (const pair of CEILINGS) if (caps.indexOf(pair[0]) !== -1) highest = pair[0];
  return highest;
}

// A fixed-voltage port is not an IEEE PSE at all, so neither a standard nor its ceiling applies to
// it: 24 V at 1 A (POE-24-24W) and 48 V at 0.5 A (POE-48-24W) are 24 W ports with no standard to
// name. A port says so with `poeOutClass: "passive"`, or - on the passive-only midspans - with the
// device's `passive-poe` token and no class word at all. A device that declares a standard is
// measured on its unclassed ports, because there the standard is the claim being checked.
const NEGOTIATED = ['PoE', 'PoE+', 'PoE++', 'PoE+++'];
function isPassivePort(spec, p) {
  // Not an exemption from the rule: this is the rule's own subject. A fixed-voltage port has no
  // negotiated standard, so there is no ceiling to compare it with.
  if (p.poeOutClass === 'passive') return true;
  if (NEGOTIATED.indexOf(String(p.poeOutClass || '')) !== -1) return false;
  if (declaredStandard(spec)) return false;
  return ((spec.capabilities || []).indexOf('passive-poe') !== -1);
}

// The ports that source power and speak a negotiated standard.
function pseWatts(spec) {
  const out = [];
  for (const p of effectiveInterfaces(spec)) {
    // Not an exemption either: pseWatts() is the set of ports the rule is about, and this is the
    // definition of that set (see isPassivePort), not a port leaving a check.
    if (isPassivePort(spec, p)) continue;
    if (typeof p.poeOut !== 'number' || !p.poeOut) continue;
    out.push({ name: p.name, watts: p.poeOut });
  }
  return out;
}

// Everything the rule says about one spec: a list of sentences, empty when it is consistent.
function violations(spec) {
  const ports = pseWatts(spec);
  if (!ports.length) return [];
  const standard = declaredStandard(spec);
  const over = [];
  if (!standard) {
    const high = ports.filter(function (p) { return p.watts > CEILING_OF['802.3af']; });
    if (high.length) {
      over.push(high[0].name + ' sources ' + high[0].watts + ' W on a midspan that names no 802.3 standard');
    }
    return over;
  }
  const ceiling = CEILING_OF[standard];
  for (const p of ports) {
    if (p.watts > ceiling) {
      over.push(p.name + ' sources ' + p.watts + ' W and the spec names only ' + standard +
        ' (' + ceiling + ' W at the PSE)');
    }
  }
  return over;
}

function specOf(vendor, model) {
  return CATALOGUE.filter(function (s) { return s.vendor === vendor && s.model === model; })[0] || null;
}
function caps(spec) { return (spec && spec.capabilities) || []; }
function portWatts(spec, name) {
  const p = effectiveInterfaces(spec).filter(function (i) { return i.name === name; })[0];
  return p ? p.poeOut : null;
}

console.log('');
console.log('Every midspan in the catalogue sources no more than the standard it names:');
{
  const injectors = CATALOGUE.filter(function (s) { return !s.error && caps(s).indexOf('poe-injector') !== -1; });
  ok(injectors.length >= 10, 'the catalogue has midspans to check (' + injectors.length + ')');
  const bad = [];
  for (const s of injectors) {
    const v = violations(s);
    if (v.length) bad.push(s.vendor + ' ' + s.model + ': ' + v[0]);
  }
  ok(bad.length === 0, 'none of them out-sources its declared standard', JSON.stringify(bad));
}

console.log('');
console.log('The three the gate was written for:');
{
  const mic = specOf('microchip', 'PD-9501GCO');
  ok(!!mic, 'microchip PD-9501GCO is in the catalogue');
  if (mic) {
    ok(portWatts(mic, 'poe') === 60, 'its one PSE port sources 60 W');
    ok(caps(mic).indexOf('802.3bt') !== -1, 'and the entry declares 802.3bt, as the vendor page does');
    ok(caps(mic).indexOf('802.3af') !== -1 && caps(mic).indexOf('802.3at') !== -1,
      'with the af/at compatibility the same page names');
    ok(violations(mic).length === 0, 'so the entry is consistent (' + violations(mic).join('; ') + ')');
  }

  const p60 = specOf('phihong', 'POE60U-1BT-2-R');
  ok(!!p60, 'phihong POE60U-1BT-2-R is in the catalogue');
  if (p60) {
    ok(portWatts(p60, 'poe') === 60, 'its PSE port sources 60 W');
    ok(caps(p60).indexOf('802.3bt') !== -1, 'and it declares 802.3bt, as its page and data sheet do');
    ok(violations(p60).length === 0, 'so the entry is consistent');
  }

  const p90 = specOf('phihong', 'POE90U-1BT-N6-R');
  ok(!!p90, 'phihong POE90U-1BT-N6-R is in the catalogue');
  if (p90) {
    ok(portWatts(p90, 'poe') === 90, 'its PSE port sources 90 W');
    ok(caps(p90).indexOf('802.3bt') !== -1, 'and it declares 802.3bt - Type 4, 90 W at the PSE');
    ok(violations(p90).length === 0, 'so the entry is consistent');
  }
}

console.log('');
console.log('The shapes the gate refuses - the three claims this run repaired, re-stated:');
{
  const before9501 = { vendor: 'microchip', model: 'PD-9501GCO', category: 'powerline',
    capabilities: ['poe-injector', '802.3at'],
    interfaces: [{ name: 'lan', type: 'ethernet', speed: '1G' },
      { name: 'poe', type: 'ethernet', speed: '1G', poeOut: 60 }] };
  const m = violations(before9501);
  ok(m.length === 1, 'a 60 W port claiming only 802.3at is a violation', JSON.stringify(m));
  ok(m.length && /60 W/.test(m[0]) && /802\.3at \(30 W/.test(m[0]),
    'and the sentence names the wattage and the standard that cannot carry it');

  const before90 = { vendor: 'phihong', model: 'POE90U-1BT-N6-R', category: 'powerline',
    capabilities: ['poe-injector'],
    interfaces: [{ name: 'lan', type: 'ethernet', speed: '1G' },
      { name: 'poe', type: 'ethernet', speed: '1G', poeOut: 90 }] };
  const n = violations(before90);
  ok(n.length === 1, 'a 90 W port naming no standard is a violation too', JSON.stringify(n));
  ok(n.length && /names no 802\.3 standard/.test(n[0]), 'and says which fact is missing');

  const bt90 = Object.assign({}, before90, { capabilities: ['poe-injector', '802.3bt'] });
  ok(violations(bt90).length === 0, 'the same 90 W port declaring 802.3bt passes (Type 4 is 90 W)');

  const at30 = Object.assign({}, before9501, { interfaces: [{ name: 'poe', type: 'ethernet', speed: '1G', poeOut: 30 }] });
  ok(violations(at30).length === 0, 'a 30 W 802.3at midspan passes - that is its ceiling');

  const bt60 = Object.assign({}, before9501, { capabilities: ['poe-injector', '802.3bt'] });
  ok(violations(bt60).length === 0, 'and a 60 W 802.3bt Type 3 midspan passes');
}

console.log('');
console.log('The entry\'s own `role` says which 802.3bt type it is, and that number is a ceiling too:');
{
  // These three files carried the type in `role` while `capabilities` said something else - the
  // contradiction was inside one file, before any vendor page was read:
  //   microchip PD-9501GCO  role ["midspan", "802.3bt-type-3"]   capabilities ["poe-injector", "802.3at"]
  //   phihong POE60U-1BT-2-R  role ["802.3bt-type-3"]            capabilities ["poe-injector", "802.3at"]
  //   phihong POE90U-1BT-N6-R role ["midspan", "802.3bt-type-4", "managed"]  capabilities ["poe-injector"]
  // A `role` is free-form, so only the string token is read; anything else there is not a claim.
  const TYPE_CEILING = { 3: 60, 4: 90 };
  function btType(role) {
    const tokens = (Array.isArray(role) ? role : []).filter(function (r) { return typeof r === 'string'; });
    const hit = tokens.map(function (r) { return /^802\.3bt-type-([34])$/.exec(r.toLowerCase()); })
      .filter(Boolean)[0];
    return hit ? Number(hit[1]) : null;
  }
  const typed = CATALOGUE.filter(function (s) { return !s.error && btType(s.role) !== null; });
  ok(typed.length >= 3, 'the catalogue has entries that name a bt type in `role` (' + typed.length + ')');
  const bad = [];
  for (const s of typed) {
    const type = btType(s.role);
    if (caps(s).indexOf('802.3bt') === -1) bad.push(s.model + ': role says type ' + type + ', capabilities do not say bt');
    for (const p of pseWatts(s)) {
      if (p.watts > TYPE_CEILING[type]) bad.push(s.model + ': ' + p.name + ' ' + p.watts + ' W against type ' + type);
    }
  }
  ok(bad.length === 0, 'and each one declares 802.3bt and stays inside its type\'s ceiling', JSON.stringify(bad));

  const mic = specOf('microchip', 'PD-9501GCO');
  const p60 = specOf('phihong', 'POE60U-1BT-2-R');
  const p90 = specOf('phihong', 'POE90U-1BT-N6-R');
  ok(mic && btType(mic.role) === 3, 'the Microchip midspan names bt type 3 in `role`');
  ok(p60 && btType(p60.role) === 3, 'the 60 W Phihong names bt type 3 in `role`');
  ok(p90 && btType(p90.role) === 4, 'and the 90 W Phihong names bt type 4');
  // A type-3 entry at 90 W would be the same defect one level down, so the ceiling has teeth.
  const typeThreeOver = { vendor: 'acme', model: 'T3-90', category: 'powerline', role: ['802.3bt-type-3'],
    capabilities: ['poe-injector', '802.3bt'],
    interfaces: [{ name: 'poe', type: 'ethernet', speed: '1G', poeOut: 90 }] };
  ok(violations(typeThreeOver).length === 0, 'the wattage rule alone lets a type-3 entry claim 90 W - which is why the role is read');
  ok(pseWatts(typeThreeOver).length === 1 && pseWatts(typeThreeOver)[0].watts > TYPE_CEILING[btType(typeThreeOver.role)],
    'and the role ceiling is what catches it');
}

console.log('');
console.log('A passive port is not a standard, and is not measured against one:');
{
  const passive24 = { vendor: 'ubiquiti', model: 'POE-24-24W', category: 'powerline',
    capabilities: ['poe-injector', 'passive-poe'],
    interfaces: [{ name: 'poe', type: 'ethernet', speed: '100M', poeOut: 24, poeOutClass: 'passive' }] };
  ok(violations(passive24).length === 0, 'a 24 V passive 24 W injector names no standard and passes');

  const passiveHigh = { vendor: 'acme', model: 'P-54-75', category: 'powerline',
    capabilities: ['poe-injector', 'passive-poe'],
    interfaces: [{ name: 'poe', type: 'ethernet', speed: '1G', poeOut: 75.6, poeOutClass: 'passive' }] };
  ok(violations(passiveHigh).length === 0, 'and so does a 54 V passive port at 75.6 W');

  const af = { vendor: 'tp-link', model: 'TL-PoE150S', category: 'powerline',
    capabilities: ['poe-injector', '802.3af'],
    interfaces: [{ name: 'poe', type: 'ethernet', speed: '1G', poeOut: 15.4 }] };
  ok(violations(af).length === 0, 'an 802.3af injector at 15.4 W passes');
  const afOver = Object.assign({}, af, { interfaces: [{ name: 'poe', type: 'ethernet', speed: '1G', poeOut: 30 }] });
  ok(violations(afOver).length === 1, 'and the same entry at 30 W does not');
}

console.log('');
console.log('A switch is not a midspan: the vendor over-power pairings stay outside the gate:');
{
  const planet = specOf('planet', 'IGS-5225-8P4S');
  ok(!!planet, 'PLANET IGS-5225-8P4S is in the catalogue');
  if (planet) {
    ok(portWatts(planet, 'port1') === 36, 'its PoE ports source 36 W');
    ok(caps(planet).indexOf('802.3at') !== -1 && caps(planet).indexOf('poe-injector') === -1,
      'it declares 802.3at and is not a midspan, so the midspan rule does not apply');
    const wouldBe = violations(Object.assign({}, planet, { capabilities: planet.capabilities.concat(['poe-injector']) }));
    ok(wouldBe.length > 0, 'the rule would flag every one of its ports if it were an injector - the scope decision, measured');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
