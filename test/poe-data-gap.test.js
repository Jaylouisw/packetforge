'use strict';
// poe-data-gap.test.js - a catalogue entry and its port records disagreed, and the console blamed
// the device.
//
// Found by pointing the round-trip harness at a real device:
//   mikrotik/RB960PGS capabilities: l3-forward, nat, ..., poe-pse, 802.3at, 802.3af, passive-poe
//   POE1#show power inline
//   % POE1 neither sources nor draws PoE
//   POE1(config-if)#power inline never
//   % POE1 does not source PoE, so eth1 has no power to give
//
// Both sentences describe the device. The fact is that the capability list says PSE and no port
// record carries power-out, which is a gap in the *specification*, and the operator cannot close it
// from a console. The first fix I wrote was to derive a per-port limit from the declared standard
// and hand the device a budget; three catalogue-wide guards refused it, and they were right - the
// per-port wattage of a real box is a datasheet fact, not something to infer from a capability tag.
// So the console now says what it actually knows.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) + ')'));
}
function match(re, haystack, msg) {
  if (haystack && Array.isArray(haystack.output)) haystack = haystack.output;
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 700)) + ')'));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const PSE_CLAIM = catalog.filter(function (x) { return x.model === 'RB960PGS'; })[0];
const SWITCH = catalog.filter(function (x) { return x.model === 'generic-switch'; })[0];
const PC = catalog.filter(function (x) { return x.model === 'generic-pc'; })[0];

function lab(model) {
  const t = new Topology();
  const d = t.addDevice(model); d.name = 'POE1';
  const ports = Array.from(d.interfaces.keys()).filter(function (n) {
    const i = d.interfaces.get(n);
    return !i.svi && !i.parent;
  });
  const sim = new Simulator(t);
  const s = new CliSession(d, t, sim); s.run('enable');
  return { t: t, sim: sim, d: d, s: s, ports: ports, p1: ports[0] };
}

console.log('\nA capability list that claims PoE, with no port to carry it, is reported as a data gap:');
{
  const env = lab(PSE_CLAIM);
  ok((PSE_CLAIM.capabilities || []).indexOf('poe-pse') !== -1, 'the entry claims poe-pse');
  ok(!Array.from(env.d.interfaces.values()).some(function (i) { return i.poeOut; }),
    'and no port carries power-out');
  const out = env.s.run('show power inline');
  match(/declares poe-pse, 802\.3at, 802\.3af, passive-poe in its catalogue entry/,
    out, 'the show names the claim it found');
  match(/no port record on it carries power-out/, out, 'and the half that is missing');
  match(/gap in the device specification, not a state of the device/, out,
    'and says whose problem it is: not the device\'s');
  ok(!/neither sources nor draws PoE/.test(out.output.join('\n')),
    'it no longer claims the device neither sources nor draws power');
}

console.log('\nThe verb that changes power gives the same reason:');
{
  const env = lab(PSE_CLAIM);
  env.s.run('configure terminal');
  env.s.run('interface ' + env.p1);
  const out = env.s.run('power inline never');
  match(/declares poe-pse.*in its catalogue entry/, out, 'the refusal names the claim');
  match(/nothing to switch/, out, 'and the port it was asked about');
  match(/gap in the device specification/, out, 'and does not send the operator looking for a fault');
}

console.log('\nA device that genuinely has no PoE still gets the plain answer:');
{
  const sw = lab(SWITCH);
  const out = sw.s.run('show power inline');
  match(/neither sources nor draws PoE|does not source PoE/, out,
    'the ordinary sentence is still used where it is true');
  ok(!/gap in the device specification/.test(out.output.join('\n')),
    'and the data-gap note is not printed for a device that makes no claim');
}

console.log('\nWithheld ports are visible even when nothing is plugged into them:');
{
  // A PSE built from port hardware, so the table has real rows to withhold.
  const spec = Object.assign({}, SWITCH, {
    poeBudget: 60,
    portTemplate: Object.assign({}, SWITCH.portTemplate, { count: 4, poeOut: 15.4 })
  });
  const t = new Topology();
  const d = t.addDevice(spec); d.name = 'SW9';
  const ports = Array.from(d.interfaces.keys()).filter(function (n) {
    const i = d.interfaces.get(n);
    return !i.svi && !i.parent;
  });
  const s = new CliSession(d, t, new Simulator(t)); s.run('enable');
  const sourcing = Array.from(d.interfaces.values()).filter(function (i) { return i.poeOut; });
  ok(sourcing.length > 0, 'the PSE sources power on ' + sourcing.length + ' port(s)');
  s.run('configure terminal');
  s.run('interface ' + ports[0]);
  s.run('power inline never');
  s.run('exit');
  const show = s.run('show power inline').output.join('\n');
  // Nothing is plugged in, so the table used to collapse to "(no powered device is attached)" and
  // the decision just made was the one thing it could not show.
  match(/Port\s+Admin\s+Powered device/, show, 'the per-port table is printed');
  match(/never/, show, 'with the admin state that was just configured');
  match(/off \(administratively\)/, show, 'and the port it applies to');
  match(/no powered device is attached to the remaining ports/, show,
    'while still saying why the rest of the table is empty');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
