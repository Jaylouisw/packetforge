'use strict';
// registry.js — load all device definitions (JSON) from the devices/ tree.
// Any manufacturer / hardware model = drop a JSON file here. No code changes.
const fs = require('fs');
const path = require('path');

const CATEGORY_ORDER = ['router', 'switch', 'l3-switch', 'firewall', 'ont', 'host', 'server', 'wireless', 'ptp', 'cloud'];

function loadCatalog(dir) {
  dir = dir || __dirname;
  const specs = [];
  function walk(d) {
    for (const entry of fs.readdirSync(d)) {
      const full = path.join(d, entry);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith('.json')) {
        try {
          const spec = require(full);
          if (spec && spec.model) specs.push(spec);
        } catch (e) {
          // ignore malformed spec files but surface the error
          specs.push({ vendor: 'error', model: entry, label: 'Broken spec', error: e.message });
        }
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

module.exports = { loadCatalog, groupByCategory, modelKey, effectiveInterfaces, CATEGORY_ORDER };
