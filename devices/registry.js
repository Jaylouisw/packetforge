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

module.exports = { loadCatalog, groupByCategory, modelKey, CATEGORY_ORDER };
