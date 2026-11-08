'use strict';
// Template expansion is how the catalogue actually describes most of its ports.
//
// 186 of 902 specs declare a `portTemplate` and nothing else, and 4476 of the
// catalogue's 11190 ports exist only because a template generated them. The engine
// expands the template when it builds a device (engine/topology.js ->
// expandInterfaces), so a topology always has the ports - but any check that reads
// `spec.interfaces` sees an empty list and reports nothing. That is issue #71: the
// port-type audit and the hardware invariants were silent by construction for a
// fifth of the catalogue, which is how the FortiGate 200G shipped with no copper
// ports modelled (see #60).
//
// This suite holds three things in place:
//   1. devices/registry.effectiveInterfaces expands a template to exactly the ports
//      it declares, and merges template + explicit ports the way the engine does
//      (asserted against the engine over the WHOLE catalogue, so the two copies of
//      the rule cannot drift apart);
//   2. scripts/audit-port-types.js audits the expanded list, including a template
//      that names no connector and no readable rate - built here as a fixture, never
//      written into devices/;
//   3. a sample of real templates expands to the port count their datasheet
//      description documents.
const path = require('path');
const { Topology } = require('../engine');
const { loadCatalog, effectiveInterfaces } = require('../devices/registry');
const audit = require('../scripts/audit-port-types');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const templates = catalog.filter(function (s) { return s.portTemplate; });
function specOf(vendor, model) {
  return catalog.find(function (s) { return s.vendor === vendor && s.model === model; });
}
// "48x 25G SFP28 ... 8x 100G QSFP28" -> 56, but only for the claims we name. Summing
// every "<n>x" in a description counts breakout options too (the 7050SX3 description
// also says "breaks out to 4x 25G/10G or 2x 50G"), so each sample states its claim
// explicitly and the test asserts the wording it was checked against still exists.
function documentedPorts(desc, claims) {
  const text = String(desc || '');
  let total = 0;
  for (const re of claims) {
    const m = text.match(re);
    if (!m) return null;          // the description was rewritten: re-check by hand
    total += Number(m[1]);
  }
  return total;
}

console.log('A portTemplate expands to exactly the ports it declares:');
{
  const fixture = {
    vendor: 'fixture', model: 'tpl-12', category: 'switch',
    portTemplate: { prefix: 'Et', start: 1, count: 12, type: 'ethernet', speed: '25G' }
  };
  const ports = effectiveInterfaces(fixture);
  ok(ports.length === 12, 'count:12 produces 12 ports (got ' + ports.length + ')');
  ok(ports[0].name === 'Et1' && ports[11].name === 'Et12',
    'names run Et1..Et12 (got ' + ports[0].name + '..' + ports[11].name + ')');
  ok(ports.every(function (p) { return p.type === 'ethernet' && p.speed === '25G'; }),
    'every generated port carries the template type and speed');

  // start is an offset, not a floor: a card numbered from 9 still generates `count` ports.
  const offset = effectiveInterfaces({
    vendor: 'fixture', model: 'tpl-offset',
    portTemplate: { prefix: 'Et', start: 9, count: 4, type: 'ethernet', speed: '10G' }
  });
  ok(offset.length === 4 && offset[0].name === 'Et9' && offset[3].name === 'Et12',
    'start:9 count:4 produces Et9..Et12 (got ' + offset.map(function (p) { return p.name; }).join(',') + ')');

  // Hardware hints belong to the whole population, not to one port: the engine copies
  // cage / connector / speedCaps / PoE / hardware onto every port it generates.
  const hinted = effectiveInterfaces({
    vendor: 'fixture', model: 'tpl-hinted',
    portTemplate: {
      prefix: 'Ethernet', count: 2, type: 'ethernet', speed: '25G',
      connector: 'sfp28', speedCaps: [10000, 25000], poeOut: 30
    }
  });
  ok(hinted.length === 2 && hinted.every(function (p) {
    return p.connector === 'sfp28' && p.poeOut === 30 && p.speedCaps.length === 2;
  }), 'connector / speedCaps / poeOut on the template reach every generated port');

  // A spec that declares nothing at all still yields one port, so no caller has to
  // special-case an empty list - the engine does exactly this.
  const bare = effectiveInterfaces({ vendor: 'fixture', model: 'nothing' });
  ok(bare.length === 1 && bare[0].name === 'eth0', 'a spec with no ports at all still yields eth0');
}

console.log('\nTemplate and explicit ports merge the way the engine merges them:');
{
  const fixture = {
    vendor: 'fixture', model: 'tpl-plus-explicit', category: 'switch',
    portTemplate: { prefix: '1/1/', start: 1, count: 4, type: 'ethernet', speed: '1G' },
    interfaces: [
      { name: '1/1/5', type: 'ethernet', speed: '10G', connector: 'sfp+' },
      { name: '1/1/6', type: 'ethernet', speed: '10G', connector: 'sfp+' }
    ]
  };
  const ports = effectiveInterfaces(fixture);
  ok(ports.length === 6, '4 generated + 2 explicit = 6 ports (got ' + ports.length + ')');
  ok(ports.slice(0, 4).every(function (p) { return p.speed === '1G'; }) &&
    ports.slice(4).every(function (p) { return p.speed === '10G' && p.connector === 'sfp+'; }),
    'generated ports come first, explicit ports after, each with its own hardware');
  ok(ports[4].speedCaps === undefined, 'the template\'s hints do not leak onto explicit ports');

  // Copy, not alias: an audit that decorates a port must not rewrite the catalogue.
  ports[0].name = 'mutated';
  ok(fixture.portTemplate.count === 4 && fixture.interfaces[0].name === '1/1/5' &&
    effectiveInterfaces(fixture)[0].name === '1/1/1',
    'the expanded list is a copy; mutating it leaves the spec untouched');

  // The registry rule and the engine rule must agree for EVERY spec, not just fixtures.
  // engine/topology.js keeps its own copy of expandInterfaces (out of scope for #71),
  // so this is what stops the two from drifting apart.
  const drift = [];
  for (const spec of catalog) {
    const mine = JSON.stringify(effectiveInterfaces(spec));
    const engine = JSON.stringify(new Topology().addDevice(spec).spec.interfaces);
    if (mine !== engine) drift.push(spec.vendor + '/' + spec.model);
  }
  ok(drift.length === 0, 'registry expansion matches engine/topology.js for all ' +
    catalog.length + ' specs' + (drift.length ? ' (' + drift.slice(0, 3).join(', ') + ')' : ''));

  // A name declared twice collapses in the interface Map, so the device silently ends
  // up with fewer ports than the spec declares. Counted over the whole catalogue.
  const lost = [];
  for (const spec of catalog) {
    const declared = effectiveInterfaces(spec).length;
    const built = new Topology().addDevice(spec).interfaces.size;
    if (built !== declared) lost.push(spec.vendor + '/' + spec.model + ' ' + built + '/' + declared);
  }
  ok(lost.length === 0, 'every spec materialises as many ports as it declares' +
    (lost.length ? ' (' + lost.slice(0, 3).join('; ') + ')' : ''));
}

console.log('\nA silent template is reported by the port-type audit:');
{
  // The four-way silence: no connector, no cage, no speedCaps and a rate the engine
  // cannot read. The cage is then a guess from the port name and the rate falls back to
  // 1 Gbit/s, so the port has no physical identity to check. This is the fixture the
  // issue asks for; it is deliberately NOT added to devices/.
  const silent = {
    vendor: 'fixture', model: 'silent-ports', category: 'switch',
    description: 'Fixture: a 25G leaf switch whose template forgets to say so.',
    portTemplate: { prefix: 'Et', start: 1, count: 8, type: 'ethernet', speed: '25GbE' }
  };
  const res = audit.auditSpec(silent);
  const flagged = res.offenders.filter(function (o) {
    return o.rules.indexOf('template-undeclared-hardware') !== -1;
  });
  ok(flagged.length === 8, 'all 8 generated ports are flagged (got ' + flagged.length + ')');
  ok(flagged.length && flagged[0].severity === 'high', 'the finding is high severity');
  ok(flagged.length && flagged[0].origin === 'template', 'the finding says the port came from the template');
  ok(flagged.length && /1 Gbit\/s/.test(flagged[0].note),
    'the note explains that the rate fell back to 1 Gbit/s');
  // The audit saw the ports at all - before #71 this spec produced an empty port list.
  ok(res.ports === 8, 'the audit counted the 8 template ports (got ' + res.ports + ')');

  // A template that declares its connector is not flagged, and one that declares only a
  // readable rate is not flagged either - a 25G port is not silence.
  const declared = {
    vendor: 'fixture', model: 'declared-ports',
    portTemplate: { prefix: 'Et', count: 4, type: 'ethernet', speed: '25G', connector: 'sfp28' }
  };
  const resDeclared = audit.auditSpec(declared);
  ok(resDeclared.offenders.length === 0, 'a template with connector sfp28 produces no offender');
  ok(resDeclared.undeclaredPorts.length === 0, 'and is not counted as undeclared hardware');

  const rated = {
    vendor: 'fixture', model: 'rated-only',
    portTemplate: { prefix: 'Et', count: 4, type: 'ethernet', speed: '25G' }
  };
  const resRated = audit.auditSpec(rated);
  ok(resRated.offenders.length === 0, 'a readable rate alone produces no offender');
  ok(resRated.undeclaredPorts.length === 4,
    'but its 4 ports are counted as having no declared connector (got ' + resRated.undeclaredPorts.length + ')');

  // A template port whose name an explicit port also uses is dropped by the interface
  // map: the spec declares 5 ports, the device has 4, and neither declaration looks
  // wrong on its own.
  const collide = {
    vendor: 'fixture', model: 'collide',
    portTemplate: { prefix: 'Et', start: 1, count: 4, type: 'ethernet', speed: '25G' },
    interfaces: [{ name: 'Et3', type: 'ethernet', speed: '25G' }]
  };
  const resCollide = audit.auditSpec(collide);
  ok(resCollide.offenders.length === 1 &&
    resCollide.offenders[0].rules.indexOf('port-name-declared-twice') !== -1,
    'a name declared by both the template and an explicit port is reported');
  ok(new Topology().addDevice(collide).interfaces.size === 4,
    'and the engine really does keep only 4 of the 5 declared ports');
}

console.log('\nReal templates expand to the documented port count:');
{
  // Sampled by hand against each spec's own description. Three of the four agree.
  const samples = [
    // "48x 25G SFP28 (1/10/25G) server ports plus 8x 100G QSFP28 uplinks"
    {
      vendor: 'arista', model: '7050SX3-48YC8', documented: 56,
      claims: [/(\d+)x 25G SFP28/, /(\d+)x 100G QSFP28/]
    },
    // "24x 1G RJ45 access ports plus 4x 1G SFP uplinks"
    {
      vendor: 'aruba', model: 'CX 6000 24G 4SFP', documented: 28,
      claims: [/(\d+)x 1G RJ45/, /(\d+)x 1G SFP/]
    },
    // "24x 1G RJ45, 2x 10G SFP+"
    {
      vendor: 'mikrotik', model: 'CRS326-24G', documented: 26,
      claims: [/(\d+)x 1G RJ45/, /(\d+)x 10G SFP\+/]
    }
  ];
  for (const s of samples) {
    const spec = specOf(s.vendor, s.model);
    if (!spec) { ok(false, s.vendor + '/' + s.model + ' is still in the catalogue'); continue; }
    const ports = effectiveInterfaces(spec);
    const doc = documentedPorts(spec.description, s.claims);
    ok(doc === s.documented,
      s.vendor + '/' + s.model + ' documents ' + s.documented + ' ports (parsed ' + doc + ')');
    ok(ports.length === s.documented,
      s.vendor + '/' + s.model + ' expands to its documented ' + s.documented + ' ports (got ' + ports.length + ')');
    ok(ports.length === (spec.portTemplate ? spec.portTemplate.count : 0) + (spec.interfaces || []).length,
      s.vendor + '/' + s.model + ' expansion equals template count + explicit interfaces');
  }

  // arista/7050SX3 is the one sampled spec that does NOT add up, and it is the shape
  // #71 is about: it declares 12 ports, its own label and description say 48, and the
  // 36 missing ports cannot be seen by any check. Pinned deliberately - if someone
  // fills the spec in (or deletes it as a duplicate of 7050SX3-48YC8), this line has
  // to be updated rather than silently passing.
  const thin = specOf('arista', '7050SX3');
  ok(!!thin, 'arista/7050SX3 is still in the catalogue');
  if (thin) {
    const ports = effectiveInterfaces(thin);
    const doc = documentedPorts(thin.description, [/(\d+)x 25G/]);
    ok(ports.length === 12 && thin.portTemplate.count === 12,
      'arista/7050SX3 expands to the 12 ports its template declares (got ' + ports.length + ')');
    ok(doc === 48,
      'KNOWN GAP #71: arista/7050SX3 models 12 of the ' + doc + ' ports its description documents ' +
      '(36 missing; its label is the same box as 7050SX3-48YC8)');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
