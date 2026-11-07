'use strict';
// import-devices.js -- validate and merge swarm-researched device specs.
//
// Research agents write free-form JSON arrays into research/incoming/*.json.
// That output is untrusted: a wrong port count, an unknown category or a
// duplicate model would silently corrupt the catalogue that the physical-layer
// validator depends on. So every spec is checked here before it is written to
// devices/<vendor>/<model>.json.
//
// Usage:
//   node scripts/import-devices.js --dry-run     # report only, write nothing
//   node scripts/import-devices.js               # validate and write
//   node scripts/import-devices.js --json        # machine-readable summary
const fs = require('fs');
const path = require('path');
const { expandInterfaces } = require('../engine/topology');
const media = require('../engine/media');
const { loadCatalog } = require('../devices/registry');

const ROOT = path.join(__dirname, '..');
// PF_INCOMING lets the importer be tested against a fixture directory without
// touching research/incoming while research agents are still writing there.
const INCOMING = process.env.PF_INCOMING
  ? path.resolve(process.env.PF_INCOMING)
  : path.join(ROOT, 'research', 'incoming');
const DEVICES = process.env.PF_DEVICES
  ? path.resolve(process.env.PF_DEVICES)
  : path.join(ROOT, 'devices');

// Vocabulary accepted by the registry and the UI.
const CATEGORIES = ['router', 'switch', 'l3-switch', 'firewall', 'ont', 'host', 'server',
  'wireless', 'ptp', 'cloud', 'olt', 'modem', 'powerline', 'nas', 'desktop', 'laptop',
  'phone', 'tablet', 'printer', 'camera', 'nvr', 'iot'];
const CAPABILITIES = ['cli', 'dhcp-client', 'dhcp-server', 'firewall', 'host', 'http-server',
  'l2-forward', 'l3-forward', 'nat', 'wireless'];
// Researchers describe endpoints in the vocabulary of the device, not of this
// engine ("ipv4-host", "wifi-client"). Map those onto the capabilities the
// simulator actually implements rather than losing an otherwise good spec.
const CAPABILITY_ALIASES = {
  'ipv4-host': 'host',
  'ip6-host': 'host',
  'host-stack': 'host',
  'wifi-client': 'wireless',
  'wireless-client': 'wireless',
  'wifi-ap': 'wireless',
  'access-point': 'wireless',
  'routing': 'l3-forward',
  'routing-engine': 'l3-forward',
  'switching': 'l2-forward',
  'l2-switch': 'l2-forward',
  'l3-switch': 'l3-forward',
  'bridge': 'l2-forward',
  'dhcp': 'dhcp-server',
  'dhcp-client-v4': 'dhcp-client',
  'http': 'http-server',
  'web-ui': 'http-server',
  'management': 'cli',
  'ssh': 'cli',
  'console': 'cli'
};

function normaliseCapabilities(list) {
  const out = [];
  for (const raw of (list || [])) {
    const c = String(raw).toLowerCase().trim();
    const mapped = CAPABILITY_ALIASES[c] || c;
    if (out.indexOf(mapped) === -1) out.push(mapped);
  }
  return out;
}

const TYPES = ['ethernet', 'wireless', 'console', 'usb'];
// media.parseSpeedMbps is deliberately permissive ("7G" parses to 7000), so the
// importer validates against the explicit set of line rates the engine supports.
const SPEEDS = { '100M': 100, '1G': 1000, '2.5G': 2500, '5G': 5000, '10G': 10000, '25G': 25000, '40G': 40000, '100G': 100000 };

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function validateSpec(spec) {
  const errors = [];
  const warnings = [];
  if (!spec || typeof spec !== 'object') return { ok: false, errors: ['spec is not an object'], warnings: warnings };

  const vendor = String(spec.vendor || '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(vendor)) errors.push('vendor "' + vendor + '" must be lowercase alphanumeric/dash');
  if (!spec.model || typeof spec.model !== 'string') errors.push('missing model');
  if (spec.category && CATEGORIES.indexOf(spec.category) === -1) {
    errors.push('category "' + spec.category + '" is not one of ' + CATEGORIES.join('/'));
  }
  if (!spec.category) errors.push('missing category');

  if (!Array.isArray(spec.capabilities) || !spec.capabilities.length) {
    errors.push('capabilities must be a non-empty array');
  } else {
    spec.capabilities = normaliseCapabilities(spec.capabilities);
    for (const c of spec.capabilities) {
      if (CAPABILITIES.indexOf(c) === -1) errors.push('unknown capability "' + c + '"');
    }
  }

  // Wireless ports carry a radio throughput, not a cabled line rate. If the
  // research agent left it out, infer a conservative band-appropriate value and
  // record a warning, so the provenance of that number stays visible.
  if (Array.isArray(spec.interfaces)) {
    for (const i of spec.interfaces) {
      if (i && i.type === 'wireless' && !i.speed) {
        const n = String(i.name || '');
        i.speed = /2\.4/.test(n) ? '600M' : /6G/.test(n) ? '9.6G' : /5/.test(n) ? '4.8G' : '1G';
        warnings.push('wireless "' + n + '" had no throughput; defaulted to ' + i.speed);
      }
    }
  }

  // Ports: the spec must DECLARE ports. expandInterfaces() silently falls back
  // to a default 'eth0' when nothing is declared, so check the declaration
  // first -- otherwise a portless device would be imported as a 1-port box.
  const declaresPorts =
    (Array.isArray(spec.interfaces) && spec.interfaces.length > 0) ||
    (spec.portTemplate && Number(spec.portTemplate.count) > 0);
  if (!declaresPorts) {
    errors.push('no interfaces (need a non-empty "interfaces" array or a "portTemplate" with count > 0)');
  }
  if (spec.portTemplate) {
    const pt = spec.portTemplate;
    if (typeof pt.prefix !== 'string' || !pt.prefix) errors.push('portTemplate.prefix must be a non-empty string');
    const n = Number(pt.count);
    if (!(n >= 1 && n <= 512)) errors.push('portTemplate.count must be 1..512 (got ' + pt.count + ')');
    if (pt.speed && SPEEDS[pt.speed] === undefined) errors.push('portTemplate.speed "' + pt.speed + '" is not a supported line rate');
    if (pt.type && TYPES.indexOf(pt.type) === -1) errors.push('portTemplate.type "' + pt.type + '" is unknown');
  }

  let ifaces = [];
  if (declaresPorts) {
    try {
      ifaces = expandInterfaces(spec);
    } catch (e) {
      errors.push('interface expansion failed: ' + e.message);
    }
  }
  if (declaresPorts && !ifaces.length) errors.push('interface expansion produced no ports');

  const seen = Object.create(null);
  for (const i of ifaces) {
    const name = i && i.name;
    if (!name) { errors.push('interface without a name'); continue; }
    if (seen[name]) errors.push('duplicate interface name "' + name + '"');
    seen[name] = true;
    if (i.type && TYPES.indexOf(i.type) === -1) errors.push('interface "' + name + '" has unknown type "' + i.type + '"');
    if (i.type !== 'console' && i.type !== 'usb') {
      if (!i.speed) {
        errors.push('interface "' + name + '" has no speed');
      } else if (i.type === 'wireless') {
        // Radio throughput, e.g. 867M or 4.8G -- not a standard line rate.
        if (!/^\d+(\.\d+)?[MG]$/.test(String(i.speed))) {
          errors.push('wireless "' + name + '" speed "' + i.speed + '" should look like 600M or 4.8G');
        }
      } else if (SPEEDS[i.speed] === undefined) {
        errors.push('interface "' + name + '" speed "' + i.speed + '" is not one of ' + Object.keys(SPEEDS).join('/'));
      }
    }
  }

  if (!spec.label) warnings.push('no label (model will be used)');
  if (!spec.description) warnings.push('no description');

  return { ok: errors.length === 0, errors: errors, warnings: warnings };
}

function readIncoming() {
  if (!fs.existsSync(INCOMING)) return [];
  const all = fs.readdirSync(INCOMING).filter(function (f) { return /\.json$/i.test(f); }).sort();
  // research/incoming also holds research artefacts - PoE budget tables, port
  // split tables, optics catalogues. Those are not device specs and reading them
  // as such buries the real rejections in noise. Device batches are named
  // devices-*.json; anything else is opt-in via --all.
  const onlyDevices = process.argv.indexOf('--all') === -1;
  const files = onlyDevices ? all.filter(function (f) { return /^devices-.*\.json$/i.test(f); }) : all;
  const out = [];
  for (const f of files) {
    const full = path.join(INCOMING, f);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      out.push({ file: f, fatal: 'invalid JSON: ' + e.message, specs: [] });
      continue;
    }
    const specs = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.devices) ? parsed.devices : [parsed]);
    out.push({ file: f, specs: specs });
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.indexOf('--dry-run') !== -1;
  const asJson = argv.indexOf('--json') !== -1;

  // Existing catalogue, keyed by vendor|model so we never overwrite vetted data.
  const existing = loadCatalog(DEVICES);
  const known = Object.create(null);
  for (const s of existing) known[String(s.vendor) + '|' + String(s.model).toLowerCase()] = true;

  const groups = readIncoming();
  if (!groups.length) {
    console.log('No files in ' + path.relative(ROOT, INCOMING) + ' -- nothing to import.');
    return 0;
  }

  const report = { files: groups.length, seen: 0, added: [], duplicates: [], rejected: [], warnings: [] };

  for (const g of groups) {
    if (g.fatal) { report.rejected.push({ file: g.file, model: '(whole file)', errors: [g.fatal] }); continue; }
    for (const spec of g.specs) {
      report.seen++;
      const v = validateSpec(spec);
      const key = String(spec && spec.vendor) + '|' + String(spec && spec.model).toLowerCase();
      if (!v.ok) {
        report.rejected.push({ file: g.file, vendor: spec && spec.vendor, model: spec && spec.model, errors: v.errors });
        continue;
      }
      if (known[key]) {
        report.duplicates.push({ file: g.file, vendor: spec.vendor, model: spec.model });
        continue;
      }
      known[key] = true;   // also guards duplicates inside the incoming batch
      if (v.warnings.length) report.warnings.push({ vendor: spec.vendor, model: spec.model, warnings: v.warnings });

      const clean = {
        vendor: spec.vendor,
        model: spec.model,
        label: spec.label || spec.model,
        category: spec.category,
        description: spec.description || (spec.vendor + ' ' + spec.model),
        capabilities: spec.capabilities.slice()
      };
      if (spec.portTemplate) clean.portTemplate = spec.portTemplate;
      if (Array.isArray(spec.interfaces)) {
        clean.interfaces = spec.interfaces.map(function (i) {
          return { name: i.name, type: i.type || 'ethernet', speed: i.speed };
        });
      }
      if (spec.icon) clean.icon = spec.icon;
      if (spec.color) clean.color = spec.color;

      if (!dryRun) {
        const dir = path.join(DEVICES, clean.vendor);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const out = path.join(dir, slug(clean.model) + '.json');
        fs.writeFileSync(out, JSON.stringify(clean, null, 2) + '\n');
      }
      report.added.push({ vendor: clean.vendor, model: clean.model, category: clean.category });
    }
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  const byVendor = {};
  for (const a of report.added) byVendor[a.vendor] = (byVendor[a.vendor] || 0) + 1;

  console.log('Scanned ' + report.files + ' file(s), ' + report.seen + ' spec(s)');
  console.log((dryRun ? 'Would add: ' : 'Added: ') + report.added.length +
    '  duplicates: ' + report.duplicates.length + '  rejected: ' + report.rejected.length);
  if (report.added.length) {
    console.log('  by vendor: ' + Object.keys(byVendor).sort().map(function (v) {
      return v + '=' + byVendor[v];
    }).join('  '));
  }
  if (report.duplicates.length) {
    console.log('\nDuplicates (skipped, existing entry kept):');
    for (const d of report.duplicates.slice(0, 20)) console.log('  - ' + d.vendor + '/' + d.model + '  (' + d.file + ')');
    if (report.duplicates.length > 20) console.log('  ... and ' + (report.duplicates.length - 20) + ' more');
  }
  if (report.rejected.length) {
    console.log('\nRejected:');
    for (const r of report.rejected) {
      console.log('  - ' + (r.vendor ? r.vendor + '/' + r.model : r.model) + '  (' + r.file + ')');
      for (const e of r.errors.slice(0, 4)) console.log('      ' + e);
    }
  }
  if (report.warnings.length) console.log('\n' + report.warnings.length + ' spec(s) had minor warnings (still imported).');
  if (dryRun) console.log('\nDry run: nothing was written. Re-run without --dry-run to import.');
  return 0;
}

process.exit(main());
