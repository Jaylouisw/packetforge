#!/usr/bin/env node
'use strict';
// Hardware request queue.
//
// Lists open hardware requests from GitHub, checks each one against the catalog
// and prints what is ready to implement. Zero dependencies: it shells out to the
// `gh` CLI, which is already how this repo is maintained.
//
//   node scripts/request-queue.js              # the queue
//   node scripts/request-queue.js --json       # machine-readable
//   node scripts/request-queue.js --skeleton 3 # JSON stub for request #3
//
// A request is "ready" when it names a vendor, a model and a datasheet URL, and
// the model is not already in the catalog. Everything else is waiting on the
// requester, and the script says which field is missing so the reply can be
// specific rather than "please provide more information".

const path = require('path');
const tracker = require('./forgejo-api');
const { loadCatalog } = require('../devices/registry');

// The tracker is Forgejo. `gh` would either not exist or, worse, quietly answer about the GitHub
// mirror - a backlog nobody is working on.
const REPO = tracker.OWNER + '/' + tracker.NAME;

// The issue form renders each field as '### Label' followed by the value.
function field(body, label) {
  const re = new RegExp('###\\s*' + label + '\\s*\\n+([\\s\\S]*?)(?=\\n###|$)', 'i');
  const m = String(body || '').match(re);
  if (!m) return '';
  return m[1].trim().replace(/^_No response_$/i, '');
}

const CATEGORY_MAP = {
  'router': 'router',
  'switch (l2)': 'switch',
  'switch (l3)': 'l3-switch',
  'firewall': 'firewall',
  'wireless ap': 'wireless',
  'point-to-point radio': 'ptp',
  'olt (pon headend)': 'olt',
  'ont / onu': 'ont',
  'cable modem (docsis)': 'modem',
  'dsl modem / media converter': 'modem',
  'powerline / moca adapter': 'powerline',
  'server': 'server',
  'nas': 'nas',
  'desktop': 'desktop',
  'laptop': 'laptop',
  'phone / tablet': 'phone',
  'printer': 'printer',
  'ip camera': 'camera',
  'nvr / dvr': 'nvr',
  'iot / smart home': 'iot',
  'end host (generic)': 'host'
};

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const skelIdx = argv.indexOf('--skeleton');

  const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
  const have = new Set(catalog.map(function (s) {
    return String(s.vendor).toLowerCase() + '|' + String(s.model).toLowerCase();
  }));

  const gate = tracker.availability();
  if (!gate.available) {
    console.error('Could not read issues from ' + REPO + '.');
    console.error(gate.reason);
    // Exit 2, not 0: "could not look" must never be reported as "nothing to do".
    process.exit(2);
  }

  let issues;
  try {
    issues = await tracker.listOpenIssues({ labels: 'device-request', max: 500 });
  } catch (e) {
    console.error('Could not read issues from ' + REPO + '.');
    console.error(String(e.message).split('\n')[0]);
    process.exit(2);
  }

  // Hand-filed issues may not use the form; fall back to the title.
  const queue = issues.map(function (it) {
    const body = it.body || '';
    let vendor = field(body, 'Vendor');
    let model = field(body, 'Exact model name') || field(body, 'Model');
    if (!vendor || !model) {
      const m = String(it.title).match(/\[Device\]:\s*(.+)/i);
      if (m) model = model || m[1].trim();
    }
    const category = CATEGORY_MAP[field(body, 'Category').toLowerCase()] || 'other';
    const datasheet = field(body, 'Datasheet or product page URL') || field(body, 'Datasheet / product page URL');
    const ports = field(body, 'Ports and interfaces') || field(body, 'Ports / interfaces');
    const poe = field(body, 'PoE budget (watts)');

    const missing = [];
    if (!vendor) missing.push('vendor');
    if (!model) missing.push('model');
    if (!datasheet || !/^https?:\/\//i.test(datasheet)) missing.push('datasheet URL');
    if (!ports) missing.push('port list');

    const dup = vendor && model && have.has(vendor.toLowerCase() + '|' + model.toLowerCase());

    return {
      number: it.number,
      title: it.title,
      url: it.url,
      author: it.author || null,
      created: it.createdAt,
      ageDays: Math.floor((Date.now() - new Date(it.createdAt).getTime()) / 86400000),
      vendor: vendor || null,
      model: model || null,
      category: category,
      datasheet: datasheet || null,
      poe: poe || null,
      ready: missing.length === 0 && !dup,
      duplicateOf: dup ? 'already in the catalog' : null,
      missing: missing,
      suggestedPath: vendor && model
        ? path.join('devices', slug(vendor), slug(model) + '.json').replace(/\\/g, '/')
        : null
    };
  });

  if (skelIdx !== -1) {
    const n = Number(argv[skelIdx + 1]);
    const req = queue.find(function (q) { return q.number === n; });
    if (!req) { console.error('No request #' + n + ' in the queue.'); process.exit(1); }
    const stub = {
      vendor: req.vendor || 'VENDOR',
      model: req.model || 'MODEL',
      label: (req.model || 'MODEL') + ' ' + req.category,
      category: req.category === 'other' ? 'switch' : req.category,
      description: 'TODO: one or two sentences from the datasheet.',
      capabilities: [],
      interfaces: [
        { name: 'eth0', type: 'ethernet', speed: '1G' }
      ],
      sourceUrl: req.datasheet || 'TODO'
    };
    console.log(JSON.stringify(stub, null, 2));
    console.log('\n// suggested path: ' + req.suggestedPath);
    console.log('// then: npm test   (the invariants will check it)');
    return;
  }

  if (asJson) { console.log(JSON.stringify(queue, null, 2)); return; }

  const ready = queue.filter(function (q) { return q.ready; });
  const blocked = queue.filter(function (q) { return !q.ready && !q.duplicateOf; });
  const dupes = queue.filter(function (q) { return q.duplicateOf; });

  console.log('Hardware requests in ' + REPO);
  console.log('  open: ' + queue.length + '   ready: ' + ready.length +
    '   waiting on requester: ' + blocked.length + '   already catalogued: ' + dupes.length);
  console.log('  catalog: ' + catalog.length + ' models');

  if (ready.length) {
    console.log('\nReady to implement (vendor, model and datasheet all present):');
    for (const q of ready) {
      console.log('  #' + q.number + '  ' + q.vendor + ' ' + q.model + '  [' + q.category + ']  ' +
        q.ageDays + 'd old');
      console.log('        ' + q.suggestedPath);
      console.log('        node scripts/request-queue.js --skeleton ' + q.number);
    }
  }

  if (blocked.length) {
    console.log('\nWaiting on the requester:');
    for (const q of blocked) {
      console.log('  #' + q.number + '  ' + q.title.replace(/^\[Device\]:\s*/, '') +
        '  — missing ' + q.missing.join(', ') + '  (' + q.ageDays + 'd old)');
    }
  }

  if (dupes.length) {
    console.log('\nAlready in the catalog (can be closed):');
    for (const q of dupes) console.log('  #' + q.number + '  ' + q.vendor + ' ' + q.model);
  }

  if (!queue.length) {
    console.log('\nQueue is empty. Nothing to do — the catalog grew by whatever requests were merged.');
  }
}

module.exports = { field: field, slug: slug, CATEGORY_MAP: CATEGORY_MAP, parseIssue: null };

if (require.main === module) {
  // main() is async now: an unhandled rejection would exit 0 on some Node versions and look like
  // a clean run that simply found nothing.
  main().catch(function (e) {
    console.error(String(e && e.stack || e));
    process.exit(2);
  });
}
