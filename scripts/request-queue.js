#!/usr/bin/env node
'use strict';
// Hardware request queue.
//
// Lists open hardware requests from GitHub, checks each one against the catalog
// and prints what is ready to implement. Zero dependencies: it reads GitHub's
// REST API through scripts/github-api.ts.
//
//   node scripts/request-queue.js              # the queue
//   node scripts/request-queue.js --json       # machine-readable
//   node scripts/request-queue.js --skeleton 3 # JSON stub for request #3
//
// A request is "ready" when it names a vendor, a model and a datasheet URL, the
// model is not already in the catalog, and no maintainer has labelled it
// `blocked-on-build`. Everything else is waiting on the requester, and the script
// says which field is missing so the reply can be specific rather than "please
// provide more information".
//
// `blocked-on-build` exists because the four form fields are not the whole gate.
// A request can be complete as a form and still be unbuildable: an OTN subrack has
// service slots and no ports until a board is named, so "ready" there means
// "--skeleton writes a one-port box", which is the class of error the catalogue
// exists to prevent. A maintainer applies the label once the thread names the
// missing field, and the queue quotes the thread rather than guessing.

const path = require('path');
const tracker = require('./github-api.ts');
const { loadCatalog } = require('../devices/registry');

// The tracker is GitHub, and the client above is the one place that knows it. It reads the REST
// API directly rather than shelling out to `gh`, which on a machine that has it installed and
// authenticated answers about whichever repository it thinks you mean.
const REPO = tracker.OWNER + '/' + tracker.NAME;

// The issue form renders each field as '### Label' followed by the value.
function field(body, label) {
  const re = new RegExp('###\\s*' + label + '\\s*\\n+([\\s\\S]*?)(?=\\n###|$)', 'i');
  const m = String(body || '').match(re);
  if (!m) return '';
  return m[1].trim().replace(/^_No response_$/i, '');
}

// Applied by hand, read here. A request carrying it is never counted ready.
const BLOCKED_LABEL = 'blocked-on-build';

// What counts as a request: the label *or* the title.
//
// The label is applied by a workflow after filing, so it can be absent on a real request - #2521
// sat open carrying only the "device" label, and every reader that asked the tracker for
// labels=device-request answered "queue is empty" while the app's /api/requests listed it (#2524).
// The title shape is what the rest of this repo already uses: server/requests.js and
// scripts/sweep-device-requests.js both test the same prefix regex, and the closer
// (close-merged-issues.js) considers "[Device]:" titles for the same reason. Matching it here too
// means the reader and the closer can no longer disagree about whether an issue is a request.
const QUEUE_LABEL = 'device-request';
const REQUEST_TITLE = /^\[(device|hardware)\]/i;

function labelNames(issue) {
  const raw = (issue && issue.labels) || [];
  if (!Array.isArray(raw)) return [];
  return raw.map(function (l) { return typeof l === 'string' ? l : (l && l.name) || ''; })
    .filter(function (l) { return l; });
}

function isDeviceRequest(issue) {
  if (labelNames(issue).indexOf(QUEUE_LABEL) !== -1) return true;
  return REQUEST_TITLE.test(String((issue && issue.title) || ''));
}

// The label says "blocked"; the thread says on what. Quote the maintainer's own
// sentence - the newest comment that mentions the block, else the newest comment -
// because a summary written by this script drifts away from the evidence.
function blockerLine(comments) {
  const list = Array.isArray(comments) ? comments : [];
  if (!list.length) return null;
  let pick = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const body = String((list[i] && list[i].body) || '');
    if (/\bblock(ed)?\b/i.test(body)) { pick = body; break; }
  }
  if (pick === null) pick = String((list[list.length - 1] && list[list.length - 1].body) || '');
  const line = pick.split('\n')
    .map(function (l) {
      return l.replace(/^[\s>#*_\-]+/, '').replace(/\*\*/g, '').trim();
    })
    .filter(function (l) { return l; })[0];
  if (!line) return null;
  return line.length > 220 ? line.slice(0, 217) + '...' : line;
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
    // No labels filter: the predicate below is the one definition of a request. Asking the
    // tracker to pre-filter by label is what left #2521 invisible here while it was open (#2524).
    issues = (await tracker.listOpenIssues({ max: 500 })).filter(isDeviceRequest);
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
      labels: labelNames(it),
      labelled: labelNames(it).indexOf(QUEUE_LABEL) !== -1,
      blockedOnBuild: (it.labels || []).indexOf(BLOCKED_LABEL) !== -1,
      blocker: null,
      ready: missing.length === 0 && !dup && (it.labels || []).indexOf(BLOCKED_LABEL) === -1,
      duplicateOf: dup ? 'already in the catalog' : null,
      missing: missing,
      suggestedPath: vendor && model
        ? path.join('devices', slug(vendor), slug(model) + '.json').replace(/\\/g, '/')
        : null
    };
  });

  // Only the labelled requests cost a second call each, and a failure to read one
  // must not turn a visible blocker into an invisible one.
  const blockedQueue = queue.filter(function (q) { return q.blockedOnBuild; });
  for (const q of blockedQueue) {
    try {
      q.blocker = blockerLine(await tracker.listIssueComments(q.number, { limit: 100 }));
    } catch (e) {
      q.blocker = null;
      q.blockerUnreadable = String((e && e.message) || e).split('\n')[0];
    }
  }

  if (skelIdx !== -1) {
    const n = Number(argv[skelIdx + 1]);
    const req = queue.find(function (q) { return q.number === n; });
    if (!req) { console.error('No request #' + n + ' in the queue.'); process.exit(1); }
    if (req.blockedOnBuild) {
      console.error('WARNING: #' + n + ' is labelled ' + BLOCKED_LABEL + ' - ' +
        (req.blocker || 'see the thread'));
      console.error('The stub below is an empty chassis written as a one-port box. Do not fill it');
      console.error('from datasheet maxima: state the build instead (docs/DEVICE_SCHEMA.md).');
    }
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
  const blockedOnBuild = blockedQueue.filter(function (q) { return !q.duplicateOf; });
  const blocked = queue.filter(function (q) {
    return !q.ready && !q.duplicateOf && !q.blockedOnBuild;
  });
  const dupes = queue.filter(function (q) { return q.duplicateOf; });

  console.log('Hardware requests in ' + REPO);
  console.log('  open: ' + queue.length + '   ready: ' + ready.length +
    '   blocked-on-build: ' + blockedOnBuild.length +
    '   waiting on requester: ' + blocked.length + '   already catalogued: ' + dupes.length);
  console.log('  catalog: ' + catalog.length + ' models');
  const unlabelled = queue.filter(function (q) { return !q.labelled; });
  if (unlabelled.length) {
    console.log('  in by title, not by label: ' + unlabelled.length);
  }

  if (ready.length) {
    console.log('\nReady to implement (vendor, model and datasheet all present):');
    for (const q of ready) {
      console.log('  #' + q.number + '  ' + q.vendor + ' ' + q.model + '  [' + q.category + ']  ' +
        q.ageDays + 'd old');
      console.log('        ' + q.suggestedPath);
      console.log('        node scripts/request-queue.js --skeleton ' + q.number);
    }
  }

  if (blockedOnBuild.length) {
    console.log('');
    console.log('Blocked on a field the vendor does not publish (not a skeleton: the stub is a one-port box):');
    for (const q of blockedOnBuild) {
      console.log('  #' + q.number + '  ' + (q.vendor || '?') + ' ' + (q.model || q.title) +
        '  [' + q.category + ']  ' + q.ageDays + 'd old');
      console.log('        ' + (q.blocker ||
        '(could not read the comments: ' + (q.blockerUnreadable || 'no reason given') + ')'));
      console.log('        ' + q.url);
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

  // A request reaches this queue by its title as well as by its label (#2524). Say so: a reader
  // that asks the tracker by label - and there is one - would not see these.
  if (unlabelled.length) {
    console.log('');
    console.log('In the queue by title alone - apply "' + QUEUE_LABEL + '" so a label-only reader sees them:');
    for (const q of unlabelled) {
      console.log('  #' + q.number + '  ' + q.title);
      console.log('        labels: ' + (q.labels.length ? q.labels.join(', ') : 'none'));
    }
  }

  if (!queue.length) {
    console.log('\nQueue is empty. Nothing to do — the catalog grew by whatever requests were merged.');
  }
}

module.exports = {
  field: field,
  slug: slug,
  blockerLine: blockerLine,
  BLOCKED_LABEL: BLOCKED_LABEL,
  QUEUE_LABEL: QUEUE_LABEL,
  isDeviceRequest: isDeviceRequest,
  CATEGORY_MAP: CATEGORY_MAP,
  parseIssue: null
};

if (require.main === module) {
  // main() is async now: an unhandled rejection would exit 0 on some Node versions and look like
  // a clean run that simply found nothing.
  main().catch(function (e) {
    console.error(String(e && e.stack || e));
    process.exit(2);
  });
}
