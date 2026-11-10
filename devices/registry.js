'use strict';
// registry.js — load all device definitions (JSON) from the devices/ tree.
// Any manufacturer / hardware model = drop a JSON file here. No code changes.
const fs = require('fs');
const path = require('path');

const CATEGORY_ORDER = ['router', 'switch', 'l3-switch', 'firewall', 'ont', 'host', 'server', 'wireless', 'ptp', 'cloud'];

// docs/DEVICE_SCHEMA.md has always said `count` is 1..512. The gate below used to accept any positive whole
// number, and the expander obeys whatever it is given: `count: 1000000` asked the loader for a million ports, and
// `count: Infinity` - which passes `Math.floor(count) === count && count > 0` - asked for infinitely many, so
// building the catalogue never returned (#1319). One number in one file, at boot.
const MAX_TEMPLATE_PORTS = 512;

// The rule for a template's port count, in one place, so the loader, the expander and any future caller agree.
function portCountProblem(count) {
  if (count === undefined || count === null) return '';  // absent means 1
  // JSON.stringify(Infinity) is "null", which would report the wrong value back to the person who wrote it.
  const shown = (typeof count === 'number' && !Number.isFinite(count)) ? String(count) : JSON.stringify(count);
  const rule = 'must be a whole number from 1 to ' + MAX_TEMPLATE_PORTS + ', got ' + shown;
  if (typeof count !== 'number' || !Number.isFinite(count) || Math.floor(count) !== count) return rule;
  if (count < 1 || count > MAX_TEMPLATE_PORTS) return rule;
  return '';
}

// How a spec that cannot describe a device is reported.
//
// The loader used to swallow these: a file whose `interfaces` was a string got four invented ports
// from the default template, a file with no `model` vanished without trace, and a `portTemplate`
// with a negative count became a device with no ports at all. All three landed in the catalogue
// looking normal, and the first person to notice was somebody dragging a portless box onto a canvas
// and wondering why nothing could be cabled to it.
//
// So a spec that cannot describe a device becomes an entry carrying `error`, next to the JSON
// syntax errors that were already reported this way. It still appears in the catalogue (silently
// dropping it hides the mistake) but it cannot be mistaken for a working device, and the message
// names the file.
function brokenSpec(file, reason) {
  return {
    vendor: 'error',
    model: path.basename(file),
    label: 'Broken spec',
    error: file + ': ' + reason
  };
}

function loadCatalog(dir) {
  dir = dir || __dirname;
  const specs = [];
  // Which file already took a model key. Two specs describing the same box make the catalogue ambiguous: the
  // palette lists it twice, `POST /devices {model}` silently picks whichever sorted first, and the one you cab
  // may not be the one you read about (#1317).
  const seenModel = new Map();
  function walk(d) {
    for (const entry of fs.readdirSync(d)) {
      const full = path.join(d, entry);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith('.json')) {
        let spec;
        try {
          // Read rather than require: require caches by path, so a spec fixed on disk during a
          // long-running process would keep reporting the old failure until restart.
          spec = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch (e) {
          specs.push(brokenSpec(full, e.message));
          continue;
        }
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
          specs.push(brokenSpec(full, 'is not a JSON object'));
          continue;
        }
        if (!spec.model) {
          specs.push(brokenSpec(full, 'has no "model" field, so it cannot be identified'));
          continue;
        }
        if (spec.interfaces != null && !Array.isArray(spec.interfaces)) {
          specs.push(brokenSpec(full, '"interfaces" must be an array of ports, not ' + typeof spec.interfaces));
          continue;
        }
        if (Array.isArray(spec.interfaces) && spec.interfaces.length === 0 && !spec.portTemplate) {
          specs.push(brokenSpec(full, 'has an empty "interfaces" array and no "portTemplate"'));
          continue;
        }
        if (Array.isArray(spec.interfaces)) {
          // A port without a name cannot be cabled: the device keeps its ports in a map keyed by
          // name, so a nameless one is invisible to the canvas and to every rule that looks it up.
          // Found by fuzzing - a mutation that leaves `"interfaces": [null]` used to load happily.
          const nameless = spec.interfaces.findIndex(function (i) {
            return !i || typeof i !== 'object' || typeof i.name !== 'string' || !i.name.trim();
          });
          if (nameless !== -1) {
            specs.push(brokenSpec(full, 'port #' + (nameless + 1) + ' has no "name" string - a port with no name cannot be cabled'));
            continue;
          }
        }
        if (spec.portTemplate) {
          // "count": 0, -5 or "8" used to produce exactly one invented port, because the expander
          // treats any falsy or non-numeric count as 1. A typo should be loud, not a silent eth0.
          const countProblem = portCountProblem(spec.portTemplate.count);
          if (countProblem) {
            specs.push(brokenSpec(full, '"portTemplate.count" ' + countProblem));
            continue;
          }
        }
        if (!Array.isArray(spec.interfaces) && !spec.portTemplate) {
          specs.push(brokenSpec(full, 'declares no ports: it needs "interfaces" or a "portTemplate"'));
          continue;
        }
        if (effectiveInterfaces(spec).length === 0) {
          specs.push(brokenSpec(full, 'resolves to zero ports - a device with nothing to cable to'));
          continue;
        }
        // A template expands to names `prefix + (start + i)`, so a non-string prefix or a non-integer start invents
        // names nobody meant: prefix 5 with start "1" yields Gi10, Gi11 ... as if the port numbering began at ten.
        if (spec.portTemplate) {
          const t = spec.portTemplate;
          if (t.prefix != null && typeof t.prefix !== 'string') {
            specs.push(brokenSpec(full, '"portTemplate.prefix" must be a string, got ' + JSON.stringify(t.prefix)));
            continue;
          }
          if (t.start != null && !(typeof t.start === 'number' && Math.floor(t.start) === t.start && t.start >= 0)) {
            specs.push(brokenSpec(full, '"portTemplate.start" must be a whole number, got ' + JSON.stringify(t.start)));
            continue;
          }
        }
        // Two ports with one name. The engine keeps ports in a map keyed by name, so the later one silently
        // replaces the earlier: a spec that describes five ports becomes a device with four, and nothing anywhere
        // says so. The count on the box is then not the count in the file (#1317).
        {
          const ports = effectiveInterfaces(spec);
          const byName = new Map();
          for (const p of ports) byName.set(p.name, (byName.get(p.name) || 0) + 1);
          const clash = Array.from(byName).filter(function (e) { return e[1] > 1; })[0];
          if (clash) {
            specs.push(brokenSpec(full, 'port name ' + JSON.stringify(clash[0]) + ' is used ' + clash[1] +
              ' times - a device would keep ' + byName.size + ' of the ' + ports.length +
              ' ports the spec describes'));
            continue;
          }
        }
        // The same box twice. `modelKey()` squashes punctuation, so "ASR1001-X" and "ASR 1001-X" are one model -
        // which is the invariant the importer already gates on, and it has to hold for files that arrive any
        // other way too (issue #60).
        {
          const key = modelKey(spec);
          if (seenModel.has(key)) {
            specs.push(brokenSpec(full, 'declares ' + spec.vendor + ' ' + spec.model + ', which ' +
              path.basename(seenModel.get(key)) + ' already declares'));
            continue;
          }
          seenModel.set(key, full);
        }
        specs.push(spec);
      }
    }
  }
  walk(dir);
  specs.sort(function (a, b) {
    const av = CATEGORY_ORDER.indexOf(a.category);
    const bv = CATEGORY_ORDER.indexOf(b.category);
    const ao = av === -1 ? 99 : av;
    const bo = bv === -1 ? 99 : bv;
    if (ao !== bo) return ao - bo;
    return (a.vendor + '/' + a.label).localeCompare(b.vendor + '/' + b.label);
  });
  return specs;
}

// Identity key for a device. Vendors punctuate the same box several ways, so the
// exact vendor+model string is not an identity: "ASR1001-X" and "ASR 1001-X" are one
// router, and so are "RaspberryPi5" and "Raspberry Pi 5". Squashing every
// non-alphanumeric character turns punctuation variants into one key, which is what
// the catalogue's uniqueness invariant and the importer's duplicate gate compare
// (issue #60 - three models were catalogued twice and an exact-string check missed it).
function modelKey(spec) {
  function squash(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  return squash(spec && spec.vendor) + '|' + squash(spec && spec.model);
}

// ---------------------------------------------------------------------------
// Effective interfaces for a spec
// ---------------------------------------------------------------------------
// A spec describes its ports in one of three ways:
//   - explicitly:        "interfaces": [ {"name":"Gi1/0/1", ...}, ... ]
//   - compactly:         "portTemplate": {"prefix":"Et","start":1,"count":12,...}
//   - both at once:      "24x RJ45 + 4x SFP" as one template plus four interfaces
//
// The engine expands the template when it builds a device (engine/topology.js ->
// expandInterfaces), so the RUNTIME always has the ports. Anything that inspects a
// SPEC - an audit, an invariant, an importer - has to expand it the same way, or it
// reads an empty port list and reports nothing (issue #71: 187 of 905 specs are
// template-only, so the port-type audit and the hardware invariants were silent by
// construction for a fifth of the catalogue. That is how the FortiGate 200G shipped
// with its copper ports missing, see #60).
//
// This is the one place to ask, and it deliberately mirrors the engine rule rather
// than inventing a second one:
//   - generated ports first, then explicit ones, so a spec can say
//     "24x RJ45 + 4x SFP" as a template plus four interfaces;
//   - a template carries its hardware hints (cage / connector / speedCaps / media /
//     PoE / hardware) onto every port it generates, because those ports share one
//     physical design;
//   - a spec that declares nothing at all still gets one eth0, so callers never have
//     to special-case an empty list.
// test/template-expansion.test.js asserts this stays byte-identical to the engine's
// expansion over the whole catalogue.
//
// The cleanest end state is for engine/topology.js to call this function instead of
// keeping its own copy; that edit is out of scope for #71 (engine/** is frozen here),
// so for now the two are kept in step by that test.
function effectiveInterfaces(spec) {
  const out = [];
  const s = spec || {};
  if (s.portTemplate) {
    const t = s.portTemplate;
    const prefix = t.prefix || 'eth';
    const start = (t.start === undefined || t.start === null) ? 1 : t.start;
    const count = (t.count === undefined || t.count === null) ? 1 : t.count;
    // Refuse rather than obey: this function is called by the loader (which reports the file), by audits, and -
    // through engine/topology.js - by anything that builds a device from a spec, including a hand-edited saved
    // board. None of them wants a million ports, and `Infinity` never returns (#1319).
    const problem = portCountProblem(count);
    if (problem) throw new Error('portTemplate.count ' + problem);
    const type = t.type || 'ethernet';
    const speed = t.speed || '1G';
    // carry explicit hardware hints onto every generated port
    const extra = {};
    for (const k of ['cage', 'connector', 'media', 'supportedMedia', 'speedCaps', 'poeOut', 'poeIn', 'hardware']) {
      if (t[k] !== undefined) extra[k] = t[k];
    }
    for (let i = 0; i < count; i++) {
      out.push(Object.assign({ name: prefix + (start + i), type: type, speed: speed }, extra));
    }
  }
  if (Array.isArray(s.interfaces)) {
    for (const i of s.interfaces) out.push(Object.assign({}, i));
  }
  if (!out.length) out.push({ name: 'eth0', type: 'ethernet', speed: '1G' });
  return out;
}

// Group catalog by category for palette rendering.
function groupByCategory(specs) {
  const groups = {};
  for (const s of specs) {
    const cat = s.category || 'generic';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(s);
  }
  return groups;
}

module.exports = { loadCatalog, groupByCategory, modelKey, effectiveInterfaces, CATEGORY_ORDER,
  portCountProblem, MAX_TEMPLATE_PORTS };
