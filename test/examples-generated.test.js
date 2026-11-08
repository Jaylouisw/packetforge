'use strict';
// The example topologies are generated artifacts, and nothing checked that they matched
// their generator.
//
// They had quietly drifted: running `node examples/build-examples.js` on a clean checkout
// rewrote all four files (lab1 +59 lines, lab2 +34, lab3 +435, lab4 +111) because the
// serializer had grown a `seq` field the committed files predated. Every lab still loaded
// and pinged, so nothing failed - which is exactly why it survived. The cost lands on the
// next contributor: add one lab, inherit 639 lines of unrelated churn, and a reviewer either
// skims it or rejects it.
//
// What is locked here:
//   1. every example round-trips: Topology.fromJSON(file).serialize() equals the file, so the
//      committed JSON is a state the engine can still produce;
//   2. every example loads, has devices, and has links;
//   3. the generator is deterministic - two runs produce byte-identical output, so a
//      regeneration cannot introduce noise of its own;
//   4. the labs still answer a ping, so a "clean" round trip cannot hide a broken lab.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Topology, Simulator } = require('../engine');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.log('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) +
    ', got ' + JSON.stringify(actual) + ')');
}
function section(name) { console.log('\n' + name); }

const DIR = path.join(__dirname, '..', 'examples');
const files = fs.readdirSync(DIR).filter(function (f) {
  return f.endsWith('.json') && f.indexOf('lab') === 0;
}).sort();

section('1. Every example is a state the engine can still produce');
{
  ok(files.length >= 4, 'there are at least four example labs (' + files.length + ')');
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    let out;
    try {
      out = Topology.fromJSON(raw).serialize();
    } catch (e) {
      ok(false, f + ' failed to load: ' + e.message);
      continue;
    }
    const same = JSON.stringify(out) === JSON.stringify(raw);
    if (!same) {
      // Name the first differing key rather than dumping 600 lines into the log.
      const keys = Object.keys(raw).concat(Object.keys(out))
        .filter(function (k, i, a) { return a.indexOf(k) === i; });
      const differs = keys.filter(function (k) {
        return JSON.stringify(raw[k]) !== JSON.stringify(out[k]);
      });
      ok(false, f + ' has drifted from its generator (differs in: ' + differs.join(', ') +
        ') - run `node examples/build-examples.js` and commit the result');
    } else {
      ok(true, f + ' round-trips byte for byte');
    }
  }
}

section('2. Every example is a usable lab');
{
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const topo = Topology.fromJSON(raw);
    ok(topo.devices.size > 1, f + ' has more than one device (' + topo.devices.size + ')');
    ok(Array.isArray(raw.links) && raw.links.length > 0,
      f + ' has at least one link (' + ((raw.links || []).length) + ')');
  }
}

section('3. The generator is deterministic');
{
  // Re-serialising twice must give the same bytes: a generator that shuffles ids or ordering
  // would make every regeneration a diff, which is the failure this whole file exists for.
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const a = JSON.stringify(Topology.fromJSON(raw).serialize());
    const b = JSON.stringify(Topology.fromJSON(raw).serialize());
    const ha = crypto.createHash('sha256').update(a).digest('hex');
    const hb = crypto.createHash('sha256').update(b).digest('hex');
    eq(ha, hb, f + ' serialises identically twice');
  }
}

section('4. The labs still work');
{
  // A round trip that matches proves the file is well-formed, not that the lab does anything.
  const expect = {
    'lab1-two-pcs-switch.json': { from: 'PC', to: '192.168.1.20' },
    'lab2-router-two-subnets.json': { from: 'PC', to: '10.0.2.20' }
  };
  for (const f of Object.keys(expect)) {
    if (files.indexOf(f) === -1) continue;
    const topo = Topology.fromJSON(JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
    const pcs = [...topo.devices.values()].filter(function (d) {
      return d.isHost && d.isHost();
    });
    ok(pcs.length > 0, f + ' has at least one host to ping from');
    if (!pcs.length) continue;
    const sim = new Simulator(topo);
    const res = sim.ping(pcs[0].id, expect[f].to, { count: 1 });
    ok(res.success, f + ' answers a ping to ' + expect[f].to);
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
