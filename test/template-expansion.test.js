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
const fs = require('fs');
const os = require('os');
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
  // A readable rate alone stopped being enough at 10G (#1069): the rate cannot choose
  // between 10GBASE-T copper and an optical cage, so a 25G template that names no
  // connector now trips the gated rule instead of passing quietly - the cage it presents
  // as is still a guess from the port name.
  const ratedFlagged = resRated.offenders.filter(function (o) {
    return o.rules.indexOf('template-implicit-connector-at-10g') !== -1;
  });
  ok(ratedFlagged.length === 4,
    'a readable 25G rate with no connector is flagged as an implicit cage (got ' + ratedFlagged.length + ')');
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
  // The collision is reported on its own before any cage rule runs, so it is the only
  // finding for that port even though the 25G template also owes a connector.
  const collided = resCollide.offenders.filter(function (o) {
    return o.rules.indexOf('port-name-declared-twice') !== -1;
  });
  ok(collided.length === 1 && collided[0].port === 'Et3',
    'a name declared by both the template and an explicit port is reported');
  ok(new Topology().addDevice(collide).interfaces.size === 4,
    'and the engine really does keep only 4 of the 5 declared ports');
}

console.log('\nA template at 10G or faster must declare its cage (#1069):');
{
  // At 1 Gbit/s RJ45 is what a 1G Ethernet port almost always is, so the inference there is
  // safe and stays allowed. At 10G and above both 10GBASE-T and SFP+ are ordinary, and
  // inferCage() has to read the port NAME to choose - a guess about hardware rather than a
  // transcription of it. The 288 ports #1074 fixed were fibre boxes presenting as racks of
  // RJ45 for exactly this reason, with nothing in the spec to contradict them.
  const tenG = {
    vendor: 'fixture', model: 'implicit-10g', category: 'switch',
    portTemplate: { prefix: 'Gi1/0/', start: 1, count: 4, type: 'ethernet', speed: '10G' }
  };
  const resTen = audit.auditSpec(tenG);
  const implicit = resTen.offenders.filter(function (o) {
    return o.rules.indexOf('template-implicit-connector-at-10g') !== -1;
  });
  ok(implicit.length === 4, 'all 4 ports of an undeclared 10G template are flagged (got ' + implicit.length + ')');
  ok(implicit.length > 0 && implicit[0].severity === 'high', 'the finding is gated, not report-only');
  ok(implicit.length > 0 && implicit[0].origin === 'template', 'and it says the port came from the template');
  ok(implicit.length > 0 && implicit[0].note.indexOf('reaches 10 Gbit/s') !== -1,
    'the note states the rate ladder that makes the guess unsafe');
  ok(implicit.length > 0 && implicit[0].note.indexOf('declare connector') !== -1,
    'and names the fix rather than only the fault');

  // Declaring the cage - either spelling - is the whole fix, and declaring it does not
  // invent a rate ladder the port did not already present.
  const declaredRj45 = Object.assign({}, tenG, {
    portTemplate: Object.assign({}, tenG.portTemplate, { connector: 'rj45' })
  });
  ok(audit.auditSpec(declaredRj45).offenders.length === 0, 'declaring connector rj45 silences the finding');
  const declaredCage = Object.assign({}, tenG, {
    portTemplate: Object.assign({}, tenG.portTemplate, { cage: 'sfp+' })
  });
  ok(audit.auditSpec(declaredCage).offenders.length === 0, 'so does the alias cage sfp+');

  // 1G is not affected: a template that tops out at 1G is left to the inference, because
  // there the inference is right by default.
  const oneG = {
    vendor: 'fixture', model: 'implicit-1g',
    portTemplate: { prefix: 'Gi1/0/', start: 1, count: 4, type: 'ethernet', speed: '1G' }
  };
  ok(audit.auditSpec(oneG).offenders.length === 0, 'a 1G template with no connector is not flagged');

  // And the catalogue is clean: every template whose ladder reaches 10G now says what its
  // cage is, so a new one cannot re-introduce the guess.
  const stillImplicit = [];
  for (const spec of catalog) {
    const r = audit.auditSpec(spec);
    if (r.offenders.some(function (o) { return o.rules.indexOf('template-implicit-connector-at-10g') !== -1; })) {
      stillImplicit.push(spec.vendor + '/' + spec.model);
    }
  }
  ok(stillImplicit.length === 0, 'no spec in the catalogue leaves a 10G+ template connector implicit' +
    (stillImplicit.length ? ' (' + stillImplicit.slice(0, 3).join(', ') + ')' : ''));

  // The declaration is not a new claim: each of these presents the cage its own description
  // names, which is the cage the inference had been producing anyway.
  const declaredCages = [
    ['cisco', 'N9K-C93180YC-FX', 'sfp28'],
    ['juniper', 'MX480', 'sfp+'],
    ['juniper', 'QFX10002-36Q', 'qsfp+'],
    ['cisco', 'C9300-24UX', 'rj45'],
    ['paloalto', 'PA-5220', 'rj45']
  ];
  for (const row of declaredCages) {
    const spec = specOf(row[0], row[1]);
    const dev = spec ? new Topology().addDevice(spec) : null;
    const firstIface = dev ? dev.interfaces.get(dev.spec.interfaces[0].name) : null;
    ok(!!spec && !!spec.portTemplate && spec.portTemplate.connector === row[2] &&
      !!firstIface && firstIface.hardware.cage === row[2],
      row[0] + '/' + row[1] + ' declares and presents ' + row[2] +
      (firstIface ? ' (got ' + firstIface.hardware.cage + ')' : ' (spec missing)'));
  }
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

console.log('\nA template whose `start` is not a number is refused, not obeyed (#1525):');
{
  // `start` is the first NUMBER, not the first name. The expander added whatever it was given, so a template that
  // put the whole first port name in `start` came out as Gi1/0/10 .. Gi1/0/13 - four ports whose names run past the
  // end of the box they describe, and every fact attached to them (address, VLAN, cable) attached to a port that
  // does not exist. Nothing in the catalogue writes one, which is why nothing caught it; an importer generating
  // templates from observed names is exactly how such a spec arrives.
  const slashed = {
    vendor: 'fixture', model: 'tpl-slash',
    portTemplate: { prefix: 'Gi', start: '1/0/1', count: 4, type: 'ethernet', speed: '1G' }
  };
  let invented = null, said = null;
  try { invented = effectiveInterfaces(slashed).map(function (p) { return p.name; }).join(' '); }
  catch (e) { said = e.message; }
  ok(said !== null, 'a slashed start is refused rather than added to' +
    (said ? '' : ' - it produced ' + invented));

  // The sentence has to name the correct form, because "not a number" alone sends the author to retype the same
  // template: the chassis goes in `prefix`, and the numbering in `start`.
  ok(/portTemplate\.start/.test(said || ''), 'the message names the field' + (said ? '' : ' (nothing was thrown)'));
  ok(/"prefix"/.test(said || '') && /"start"/.test(said || ''),
    'and both halves of the split it got wrong' + (said ? ' ("' + said + '")' : ''));
  ok(/\{"prefix":"Gi1\/0\/","start":1\}/.test(said || ''),
    'and shows the form that does work' + (said ? ' ("' + said + '")' : ''));

  // The engine builds devices from raw specs too (an importer, a hand-built lab), so the same refusal has to hold
  // there - and hold BEFORE a device exists, or the board keeps a box with invented ports and an error nobody reads.
  const t = new Topology();
  let engineSaid = null;
  try { t.addDevice(slashed, 'd1'); } catch (e) { engineSaid = e.message; }
  ok(engineSaid !== null, 'addDevice() refuses the same spec' + (engineSaid ? '' : ' - it built a device'));
  ok(t.devices.size === 0, 'and no half-built device is left on the board (got ' + t.devices.size + ')');

  // The other spellings of the same mistake: a fraction, a numeric string, and a numeric prefix. All three used to
  // be arithmetic, and all three are names nobody meant.
  const refused = function (tpl) {
    try { effectiveInterfaces({ vendor: 'fixture', model: 'm', portTemplate: tpl }); return null; }
    catch (e) { return e.message; }
  };
  ok(refused({ prefix: 'Et', start: 1.5, count: 2 }) !== null, 'a fractional start is refused');
  ok(refused({ prefix: 'Et', start: '1', count: 2 }) !== null, 'a numeric string is refused, not coerced');
  const prefixed = refused({ prefix: 5, start: 1, count: 2 });
  ok(prefixed !== null, 'a numeric prefix is refused' + (prefixed ? '' : ' - it named its ports after numbers'));
  ok(/portTemplate\.prefix/.test(prefixed || ''), 'and that message names the prefix' + (prefixed ? ' ("' + prefixed + '")' : ''));

  // The correct form is what the catalogue already writes, and it still expands: 0 is a legitimate first number
  // (a card whose numbering starts at 0), and an absent start still means 1.
  const good = effectiveInterfaces({
    vendor: 'fixture', model: 'tpl-good',
    portTemplate: { prefix: 'Gi1/0/', start: 1, count: 4, type: 'ethernet', speed: '1G' }
  });
  ok(good.map(function (p) { return p.name; }).join(',') === 'Gi1/0/1,Gi1/0/2,Gi1/0/3,Gi1/0/4',
    'the supported form still expands (got ' + good.map(function (p) { return p.name; }).join(',') + ')');
  ok(effectiveInterfaces({ vendor: 'fixture', model: 'z', portTemplate: { prefix: 'Et', start: 0, count: 2 } })
    .map(function (p) { return p.name; }).join(',') === 'Et0,Et1', 'start:0 is still a number, not a default');
  ok(effectiveInterfaces({ vendor: 'fixture', model: 'd', portTemplate: { prefix: 'Et', count: 2 } })
    .map(function (p) { return p.name; }).join(',') === 'Et1,Et2', 'and an absent start still means 1');

  // A file on disk is reported against the file, in the same words, and the catalogue still loads - a bad template
  // must not throw out of the middle of the catalogue walk.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-tpl-start-'));
  try {
    fs.mkdirSync(path.join(dir, 'acme'));
    fs.writeFileSync(path.join(dir, 'acme', 'slash.json'),
      JSON.stringify({ vendor: 'acme', model: 'sl', portTemplate: { prefix: 'Gi', start: '1/0/1', count: 4 } }));
    const entries = loadCatalog(dir);
    const broken = entries[0] || {};
    ok(!!broken.error, 'the loader reports it instead of loading it' + (broken.error ? '' : ' - it loads as a device'));
    ok(String(broken.error).indexOf('slash.json') !== -1, 'naming the file' + (broken.error ? ' (' + broken.error + ')' : ''));
    ok(/"portTemplate\.start" must be a whole number/.test(String(broken.error)),
      'with the same sentence the expander throws' + (broken.error ? ' (' + broken.error + ')' : ''));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
