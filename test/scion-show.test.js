'use strict';
// scion-show.test.js — `show scion` reports membership, segments and peers;
// `show scion paths [<isd-as>]` composes the beaconed paths and describes the
// selected one. Both were previously "% Invalid show command".
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(vendor, model) {
  return catalog.find(function (x) { return x.vendor === vendor && x.model === model; });
}

const t = new Topology();
const R1 = t.addDevice(spec('generic', 'generic-router'));
const R2 = t.addDevice(spec('generic', 'generic-router'));
const C1 = t.addDevice(spec('generic', 'generic-router'));
const C3 = t.addDevice(spec('generic', 'generic-router'));
const R9 = t.addDevice(spec('generic', 'generic-router'));
const RA = t.addDevice(spec('generic', 'generic-router'));
R1.name = 'R1'; R2.name = 'R2'; C1.name = 'C1'; C3.name = 'C3'; R9.name = 'R9'; RA.name = 'RA';

t.connect(R1.id, 'Gi0/0', C1.id, 'Gi0/0');
t.connect(C1.id, 'Gi0/1', R2.id, 'Gi0/0');
t.connect(R1.id, 'Gi0/1', C3.id, 'Gi0/0');
t.connect(C3.id, 'Gi0/1', R2.id, 'Gi0/1');
t.connect(C1.id, 'Gi0/2', C3.id, 'Gi0/2');
t.connect(R9.id, 'Gi0/0', RA.id, 'Gi0/0');

const sim = new Simulator(t);
function cli(dev, cmds) {
  return runCommands(dev, t, sim, ['enable', 'configure terminal'].concat(cmds)).lines;
}
function show(dev, cmd) {
  return runCommands(dev, t, sim, ['enable', cmd]).lines.join('\n');
}

cli(R1, ['scion 1-ff00:0:110']);
cli(R2, ['scion 1-ff00:0:120']);
cli(C1, ['scion 1-ff00:0:0']);
cli(C3, ['scion 1-ff01:0:0']);
cli(R9, ['scion 1-ff00:0:190']);
cli(RA, ['scion 1-ff00:0:191']);

const m = show(R1, 'show scion');
ok(/SCION membership on R1/.test(m), 'show scion names the device');
ok(/1-ff00:0:110/.test(m), 'show scion reports the ISD-AS');
ok(/non-core/.test(m), 'a non-core AS is labelled non-core');
ok(/Peers/.test(m) && /1-ff00:0:0/.test(m), 'the peers include the core AS it links to');
ok(/1-ff00:0:120\s+\d+ path/.test(m), 'reachability lists R2 with a path count');
ok(/1-ff00:0:190\s+unreachable/.test(m), 'an islanded AS is unreachable');

const p = show(R1, 'show scion paths 1-ff00:0:120');
ok(/SCION paths from 1-ff00:0:110/.test(p), 'show scion paths names the source');
ok(/1-ff00:0:120/.test(p), 'the destination appears');
ok(/SCION path: valid/.test(p), 'the selected path is described');
ok(/segments?/.test(p) && /hops?/.test(p), 'the description carries segment and hop counts');

const all = show(R1, 'show scion paths');
ok(/1-ff00:0:120/.test(all), 'paths without a destination list every other AS');
ok(/1-ff00:0:190\s+no beaconed path/.test(all), 'and mark the island as having no path');

const core = show(C1, 'show scion');
ok(/\(core AS\)/.test(core), 'a core AS is labelled core');

const none = show(t.addDevice(spec('generic', 'generic-router')), 'show scion');
ok(/% This device is not a SCION AS/.test(none), 'a device without membership says so');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
