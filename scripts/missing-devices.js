#!/usr/bin/env node
'use strict';
// missing-devices.js -- what hardware is this topology asking for that we do not have?
//
// The maintainer rule for this project is "if a device doesn't exist, make it so".
// Until now that was a human reading a lab, noticing a red box and typing a JSON
// file. This script makes the first half mechanical: it reads topologies, diffs
// them against the catalogue and hands back one line per gap plus the exact
// command that closes it.
//
// It deliberately does NOT invent hardware. A missing model produces a SKELETON:
// vendor, model, an honestly-unknown category and an empty interface list. The
// port list is the one field the simulator's physical layer depends on, so it has
// to come from a datasheet -- an empty array is a question, a guessed array is a
// bug that only shows up when a lab refuses to cable.
//
// Usage:
//   node scripts/missing-devices.js                  # scan examples/ and report
//   node scripts/missing-devices.js examples lab5.json
//   node scripts/missing-devices.js --stubs          # also write research/incoming/missing-<vendor>.json
//   node scripts/missing-devices.js --json           # machine-readable
//   node scripts/missing-devices.js --no-issues      # skip the device-request scan
//   node scripts/missing-devices.js --strict         # also fail on open issue requests
//
// Exit codes: 0 = every referenced model exists, 1 = at least one is missing,
// 2 = the scan itself could not run (bad path, unreadable topology).
const fs = require('fs');
const path = require('path');
const { loadCatalog } = require('../devices/registry');
const { field, slug } = require('./request-queue');

const ROOT = path.join(__dirname, '..');
// Same override convention as scripts/import-devices.js: tests point these at a
// throwaway fixture so a run can never write into the real catalogue or clobber
// a skeleton a contributor is halfway through filling in.
const DEVICES = process.env.PF_DEVICES ? path.resolve(process.env.PF_DEVICES) : path.join(ROOT, 'devices');
const INCOMING = process.env.PF_INCOMING ? path.resolve(process.env.PF_INCOMING) : path.join(ROOT, 'research', 'incoming');
const REPO = process.env.PF_REPO || 'Jaylouisw/packetforge';
// The canonical host, from the one file that defines it. A hardware request link that points
// somewhere other than where development happens is a dead end for the person following it.
const canonical = require('./canonical');
const tracker = require('./forgejo-api');
const TEMPLATE_URL = canonical.issue('device_request.yml');

// The vocabulary scripts/import-devices.js will accept. A skeleton outside this
// set is a draft, not a device, which is why 'unknown' exists here and nowhere
// in the importer: it must be replaced before it can be imported.
const CATEGORIES = ['router', 'switch', 'l3-switch', 'firewall', 'ont', 'host', 'server',
  'wireless', 'ptp', 'cloud', 'olt', 'splitter', 'modem', 'powerline', 'nas', 'desktop', 'laptop',
  'phone', 'tablet', 'printer', 'camera', 'nvr', 'iot'];

// Category from the model string, but only when the string says it outright.
// "EdgeSwitch-16" is a switch; "CRS326-24G" might be one, but that is MikroTik
// product knowledge, not something the string states, so it stays unknown.
// Order matters: the first rule that matches wins.
const CATEGORY_RULES = [
  [/\bl3\b.*\b[a-z0-9]*switch/, 'l3-switch'],
  // Compound names count ("EdgeSwitch", "EdgeRouter"): the model string is still
  // saying, in words, what the box is.
  [/\b[a-z0-9]*switch/, 'switch'],
  [/\b[a-z0-9]*router/, 'router'],
  [/\bfirewall/, 'firewall'],
  [/\b(access[ -]?point|wireless[ -]?ap)\b/, 'wireless'],
  [/\bolt\b/, 'olt'],
  [/\b(ont|onu)\b/, 'ont'],
  [/\bmodem\b/, 'modem'],
  [/\bpowerline\b/, 'powerline'],
  [/\bnas\b/, 'nas'],
  [/\b(nvr|dvr)\b/, 'nvr'],
  [/\b(ip[ -]?camera|camera)\b/, 'camera'],
  [/\bprinter\b/, 'printer'],
  [/\bsplitter\b/, 'splitter'],
  [/\bptp\b/, 'ptp'],
  [/\bserver\b/, 'server'],
  [/\blaptop\b/, 'laptop'],
  [/\bdesktop\b/, 'desktop'],
  [/\btablet\b/, 'tablet'],
  [/\bphone\b/, 'phone']
];

function guessCategory(model) {
  // Normalise separators so word-boundary rules see "edge switch 16" rather than
  // relying on \b treating "-" as a boundary (it does, but "+" and "_" do not).
  const s = String(model || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const rule of CATEGORY_RULES) {
    const m = s.match(rule[0]);
    if (m) {
      return {
        category: rule[1],
        note: 'Guessed from the model string ("' + m[0].trim() + '"); confirm it against the datasheet.'
      };
    }
  }
  return {
    category: 'unknown',
    note: 'The model string does not name a device type, so the category is unknown. ' +
      'Set it from the datasheet -- see docs/REQUESTING-HARDWARE.md for the vocabulary.'
  };
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function display(p) {
  const rel = path.relative(ROOT, p);
  return toPosix(rel && !rel.startsWith('..') ? rel : p);
}

// A topology is { devices: [...] }; `nodes` is accepted because importers other
// than this one use it, but a file with neither is not a lab and is skipped
// rather than reported as an empty success.
function topologyDevices(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (Array.isArray(doc.devices)) return doc.devices;
  if (Array.isArray(doc.nodes)) return doc.nodes;
  return null;
}

function collectFiles(targets) {
  const out = [];
  const seen = new Set();
  const problems = [];
  // One shared `seen` across the whole walk, so passing a directory and a file
  // inside it does not count the same lab twice.
  function walk(abs) {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(abs).sort()) walk(path.join(abs, entry));
      return;
    }
    if (!abs.endsWith('.json')) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  }
  for (const t of targets) {
    const abs = path.resolve(t);
    try { fs.statSync(abs); } catch (e) { problems.push(t + ': no such file or directory'); continue; }
    walk(abs);
  }
  return { files: out, problems: problems };
}

// Returns Map key -> { vendor, model, count, files:Set, sample }
function scanTopologies(files) {
  const refs = new Map();
  const scanned = [];
  const skipped = [];
  let deviceCount = 0;
  for (const file of files) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      skipped.push({ file: file, reason: 'invalid JSON: ' + e.message });
      continue;
    }
    const devices = topologyDevices(doc);
    if (!devices) { skipped.push({ file: file, reason: 'no devices[] array' }); continue; }
    scanned.push(file);
    for (const d of devices) {
      if (!d || typeof d !== 'object') continue;
      const model = d.model || d.type;
      if (!model) continue;
      const vendor = d.vendor || '(unknown)';
      const key = String(vendor).toLowerCase() + '|' + String(model).toLowerCase();
      deviceCount++;
      let rec = refs.get(key);
      if (!rec) {
        rec = { vendor: String(vendor).toLowerCase(), model: String(model), count: 0, files: new Set(), sample: d };
        refs.set(key, rec);
      }
      rec.count++;
      rec.files.add(file);
    }
  }
  return { refs: refs, scanned: scanned, skipped: skipped, deviceCount: deviceCount };
}

// The issue form renders '### Vendor' / '### Exact model name' blocks. Hand-filed
// issues do not, so the title ("[Device]: Vendor Model") is the fallback -- and a
// request with no vendor is still worth reporting, just not writable.
function parseIssueRequests(issues) {
  return (issues || []).map(function (it) {
    const body = it.body || '';
    let vendor = field(body, 'Vendor').toLowerCase();
    let model = field(body, 'Exact model name') || field(body, 'Model');
    if (!vendor || !model) {
      const m = String(it.title || '').match(/\[Device\]:\s*(.+)/i);
      if (m) model = model || m[1].trim();
    }
    return {
      number: it.number,
      url: it.url,
      title: it.title,
      vendor: vendor || null,
      model: model || null
    };
  }).filter(function (r) { return r.model; });
}

// Open requests are a wish list, not a broken lab, so they are reported in their
// own section and only gate CI under --strict.
async function scanIssues() {
  // Forgejo, through its API. The old version shelled out to `gh`, which on a machine that has it
  // installed and authenticated answers about the GitHub mirror instead - a backlog nobody works
  // on, reported as fact.
  const scan = await tracker.scanRequests({ labels: 'device-request', max: 500 });
  if (!scan.available) {
    return { available: false, reason: scan.reason, count: 0, requests: [] };
  }
  const requests = parseIssueRequests(scan.requests);
  return { available: true, reason: null, count: requests.length, requests: requests };
}

// An open request only counts as a gap if the catalogue still lacks it and no
// topology already asked for it. A request with no vendor cannot be written to
// devices/<vendor>/, so it is reported by request-queue.js instead of here.
function diffIssueRequests(requests, have, alreadyMissing) {
  const out = [];
  for (const r of (requests || [])) {
    if (!r.vendor || !r.model) continue;
    const key = r.vendor + '|' + r.model.toLowerCase();
    if (have.has(key) || alreadyMissing.has(key)) continue;
    alreadyMissing.add(key);
    out.push(r);
  }
  return out;
}

function buildSkeleton(vendor, model, files, guess, count) {
  if (!guess) guess = guessCategory(model);
  return {
    vendor: vendor,
    model: model,
    label: model,
    category: guess.category,
    categoryNote: guess.note,
    description: 'TODO: one or two sentences from the datasheet.',
    // The placeholder that makes it obvious nothing here is researched yet: it
    // grants no routing, no switching and no CLI.
    capabilities: ['host'],
    // Empty on purpose. The importer and test/hardware-invariants.test.js both
    // trust these entries, so an invented port list would be worse than none.
    interfaces: [],
    note: 'The port list must come from the datasheet: every physical port, its speed and ' +
      'which are optical. It is empty here because guessing it would create a device that ' +
      'silently refuses the cabling a real one accepts. Fill it in, drop categoryNote, then ' +
      'run: node scripts/import-devices.js --apply',
    sourceUrl: 'TODO: datasheet or product page URL',
    requestedBy: files.map(display),
    references: count == null ? files.length : count
  };
}

function writeSkeletons(missing) {
  const byVendor = {};
  for (const m of missing) {
    if (!m.vendor || m.vendor === '(unknown)') continue;   // no directory to put it in
    if (!byVendor[m.vendor]) byVendor[m.vendor] = [];
    byVendor[m.vendor].push(m);
  }
  const written = [];
  for (const vendor of Object.keys(byVendor).sort()) {
    const dir = path.join(INCOMING);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'missing-' + slug(vendor) + '.json');
    let existing = [];
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        existing = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.devices) ? parsed.devices : []);
      } catch (e) {
        // Never clobber a file a human is editing, even if it is temporarily broken.
        written.push({ vendor: vendor, file: file, added: [], error: 'existing file is not valid JSON; left untouched (' + e.message + ')' });
        continue;
      }
    }
    const have = new Set(existing.map(function (d) {
      return String(d && d.model || '').toLowerCase();
    }));
    const added = [];
    for (const m of byVendor[vendor]) {
      if (have.has(m.model.toLowerCase())) continue;
      const skel = buildSkeleton(m.vendor, m.model, m.files,{ category: m.category, note: m.categoryNote }, m.count);
      existing.push(skel);
      have.add(m.model.toLowerCase());
      added.push(m.model);
    }
    if (added.length) fs.writeFileSync(file, JSON.stringify(existing, null, 2) + '\n');
    written.push({ vendor: vendor, file: file, added: added, error: null });
  }
  return written;
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter(function (a) { return a.startsWith('--'); }));
  const targets = argv.filter(function (a) { return !a.startsWith('--'); });

  if (flags.has('--help') || flags.has('-h')) {
    console.log('Usage: node scripts/missing-devices.js [paths...] [--stubs] [--json] [--no-issues] [--strict]');
    return 0;
  }
  const known = new Set(['--stubs', '--json', '--no-issues', '--strict', '--help', '-h']);
  const bogus = [...flags].filter(function (f) { return !known.has(f); });
  if (bogus.length) {
    console.error('Unknown flag: ' + bogus.join(', '));
    console.error('Usage: node scripts/missing-devices.js [paths...] [--stubs] [--json] [--no-issues] [--strict]');
    return 2;
  }

  const writeStubs = flags.has('--stubs');
  const asJson = flags.has('--json');
  const scanGh = !flags.has('--no-issues');
  const strict = flags.has('--strict');

  const searchPaths = targets.length ? targets : [path.join(ROOT, 'examples')];
  const collected = collectFiles(searchPaths);
  if (collected.problems.length) {
    for (const p of collected.problems) console.error('Cannot scan ' + p);
    return 2;
  }
  if (!collected.files.length) {
    console.error('No .json files found in ' + searchPaths.map(display).join(', '));
    return 2;
  }

  const scan = scanTopologies(collected.files);
  if (!scan.scanned.length) {
    // A file with no devices[]/nodes[] is not a lab. Saying "nothing missing" for
    // a directory of such files would let a format change pass CI silently.
    console.error('No topology files found in ' + searchPaths.map(display).join(', ') + '.');
    for (const s of scan.skipped) console.error('  ' + display(s.file) + ' -- ' + s.reason);
    return 2;
  }
  const catalog = loadCatalog(DEVICES);
  const have = new Set(catalog.map(function (s) {
    return String(s.vendor).toLowerCase() + '|' + String(s.model).toLowerCase();
  }));

  const missing = [];
  for (const rec of scan.refs.values()) {
    if (have.has(rec.vendor.toLowerCase() + '|' + rec.model.toLowerCase())) continue;
    const guess = guessCategory(rec.model);
    missing.push({
      vendor: rec.vendor,
      model: rec.model,
      count: rec.count,
      files: [...rec.files],
      category: guess.category,
      categoryNote: guess.note,
      skeleton: path.join(INCOMING, 'missing-' + slug(rec.vendor) + '.json')
    });
  }
  missing.sort(function (a, b) {
    return (a.vendor + '|' + a.model.toLowerCase()).localeCompare(b.vendor + '|' + b.model.toLowerCase());
  });

  const issues = scanGh ? await scanIssues() : { available: false, reason: 'issue scan disabled with --no-issues', count: 0, requests: [] };
  // An open request only counts as a gap if the catalogue still lacks it.
  const seen = new Set(missing.map(function (m) { return m.vendor + '|' + m.model.toLowerCase(); }));
  const issueMissing = diffIssueRequests(issues.requests, have, seen);

  const totalMissing = missing.length + issueMissing.length;
  const gate = missing.length > 0 || (strict && issueMissing.length > 0);

  let writes = null;
  if (writeStubs) {
    writes = writeSkeletons(missing);
    // In --json mode the log must not pollute stdout, so it goes into the report
    // (and errors still go to stderr, where a caller will see them).
    for (const w of writes) if (w.error) console.error('! ' + display(w.file) + ': ' + w.error);
    if (!asJson) {
      for (const w of writes) {
        if (w.error) continue;
        if (w.added.length) console.log('Wrote ' + display(w.file) + ' (' + w.added.length + ' device(s): ' + w.added.join(', ') + ')');
        else console.log('Left ' + display(w.file) + ' alone (already contains these models).');
      }
      if (writes.length) console.log('');
    }
  }

  if (asJson) {
    const byVendor = {};
    for (const m of missing) {
      if (!byVendor[m.vendor]) byVendor[m.vendor] = [];
      byVendor[m.vendor].push(m.model);
    }
    console.log(JSON.stringify({
      ok: !gate,
      scanned: {
        files: scan.scanned.map(display),
        topologies: scan.scanned.length,
        devices: scan.deviceCount,
        skipped: scan.skipped.map(function (s) { return { file: display(s.file), reason: s.reason }; })
      },
      catalog: catalog.length,
      missing: missing.map(function (m) {
        return {
          vendor: m.vendor,
          model: m.model,
          count: m.count,
          files: m.files.map(display),
          category: m.category,
          categoryNote: m.categoryNote,
          skeleton: m.vendor === '(unknown)' ? null : display(m.skeleton)
        };
      }),
      byVendor: byVendor,
      issues: {
        checked: issues.available,
        reason: issues.reason,
        open: issues.count,
        missing: issueMissing.map(function (r) {
          return { number: r.number, vendor: r.vendor, model: r.model, url: r.url };
        })
      },
      writes: writes === null ? null : writes.map(function (w) {
        return { file: display(w.file), added: w.added, error: w.error };
      })
    }, null, 2));
    return gate ? 1 : 0;
  }

  console.log('Scanning ' + scan.scanned.length + ' topology file(s), ' + scan.deviceCount + ' device reference(s).');
  console.log('Catalogue: ' + catalog.length + ' models (' + display(DEVICES) + ')');
  for (const s of scan.skipped) console.log('  skipped ' + display(s.file) + ' -- ' + s.reason);

  if (!missing.length) {
    console.log('\nNothing missing: every model these topologies reference exists in the catalogue.');
  } else {
    console.log('\nMISSING: ' + missing.length + ' model(s) in ' + new Set(missing.map(function (m) { return m.vendor; })).size + ' vendor(s)\n');
    let currentVendor = null;
    for (const m of missing) {
      if (m.vendor !== currentVendor) {
        currentVendor = m.vendor;
        console.log(m.vendor + (m.vendor === '(unknown)' ? '  (device entry has no vendor field)' : ''));
      }
      console.log('  ' + m.model + '   referenced ' + m.count + 'x');
      for (const f of m.files) console.log('      ' + display(f));
      console.log('      category: ' + m.category + ' -- ' + m.categoryNote);
      if (m.vendor === '(unknown)') {
        // No vendor means no devices/<vendor>/ directory and no skeleton file.
        console.log('      next: add a "vendor" field to this device in the lab, then re-run');
      } else if (writeStubs) {
        console.log('      spec: ' + display(m.skeleton) + '  (fill in interfaces[] from the datasheet)');
        console.log('      next: node scripts/import-devices.js --apply && npm test');
      } else {
        console.log('      next: node scripts/missing-devices.js --stubs   (writes ' + display(m.skeleton) + ')');
      }
      console.log('      request: ' + TEMPLATE_URL);
      console.log('');
    }
  }

  console.log('Open device-request issues:');
  if (!issues.available) {
    console.log('  not scanned: ' + issues.reason + ' -- the topology scan above is unaffected.');
  } else {
    console.log('  ' + issues.count + ' open, ' + issueMissing.length + ' of them still missing from the catalogue');
    for (const r of issueMissing) {
      console.log('  #' + r.number + '  ' + r.vendor + ' ' + r.model + '  [' + guessCategory(r.model).category + ']');
      console.log('      ' + r.url);
      console.log('      next: node scripts/request-queue.js --skeleton ' + r.number);
    }
  }

  if (totalMissing) {
    console.log('\n' + totalMissing + ' model(s) to add.');
    if (!writeStubs) console.log('Run with --stubs to write research/incoming/missing-<vendor>.json skeletons.');
  }
  if (gate) console.log('CI gate: FAILED (exit 1) -- a topology references hardware the catalogue does not have.');
  else if (missing.length === 0 && issueMissing.length) {
    console.log('CI gate: passed (open requests do not fail the build unless you pass --strict).');
  } else {
    console.log('CI gate: passed.');
  }
  return gate ? 1 : 0;
}

module.exports = {
  guessCategory: guessCategory,
  topologyDevices: topologyDevices,
  scanTopologies: scanTopologies,
  collectFiles: collectFiles,
  buildSkeleton: buildSkeleton,
  writeSkeletons: writeSkeletons,
  parseIssueRequests: parseIssueRequests,
  diffIssueRequests: diffIssueRequests,
  CATEGORIES: CATEGORIES,
  TEMPLATE_URL: TEMPLATE_URL
};

if (require.main === module) {
  main().then(function (code) { process.exit(code); }).catch(function (e) {
    console.error(String(e && e.stack || e));
    process.exit(2);
  });
}
