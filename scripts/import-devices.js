'use strict';
// import-devices.js -- validate and merge swarm-researched device specs.
//
// Research agents write free-form JSON arrays into research/incoming/*.json.
// That output is untrusted: a wrong port count, an unknown category or a
// duplicate model would silently corrupt the catalogue that the physical-layer
// validator depends on. So every spec is checked here before it is written to
// devices/<vendor>/<model>.json.
//
// "Duplicate" means the same box, not the same string: identity is compared with all
// punctuation stripped (modelKey in devices/registry.js), so a research agent cannot
// write "ISR 4331" beside the "ISR4331" already in the catalogue (issue #60).
//
// Usage:
//   node scripts/import-devices.js --dry-run     # report only, write nothing
//   node scripts/import-devices.js               # validate and write
//   node scripts/import-devices.js --json        # machine-readable summary
const fs = require('fs');
const path = require('path');
const { expandInterfaces } = require('../engine/topology');
const media = require('../engine/media');
const { loadCatalog, modelKey } = require('../devices/registry');

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
  'wireless', 'ptp', 'cloud', 'olt', 'splitter', 'modem', 'powerline', 'nas', 'desktop', 'laptop',
  'phone', 'tablet', 'printer', 'camera', 'nvr', 'iot', 'tap'];
const CAPABILITIES = ['cli', 'dhcp-client', 'dhcp-server', 'firewall', 'host', 'http-server',
  'l2-forward', 'l3-forward', 'nat', 'wireless',
  // Hardware descriptors. These describe power, not forwarding: they grant no
  // behaviour, so they cannot make the simulator pretend a box routes.
  'poe-injector', 'poe-pse', 'poe-pd', 'passive-poe', '802.3af', '802.3at', '802.3bt'];
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

// 'usb' is deliberately absent: a USB port is not a network interface. It was
// modelled once as a 12 Mbit/s USB console NIC and phones ended up advertising a
// gigabit over it. A real USB console port should be declared type "console".
const TYPES = ['ethernet', 'wireless', 'console', 'coax', 'dsl', 'adsl', 'vdsl', 'powerline', 'plc', 'mains', 'pon'];
// media.parseSpeedMbps is deliberately permissive ("7G" parses to 7000), so the
// importer validates against the explicit set of line rates the engine supports.
// Fibre Channel rates are not Ethernet rates, but they are real line rates and a SAN
// switch has to state them honestly rather than rounding an 8G port up to 10G - which
// also made the port claim a rate its cage cannot carry.
const SPEEDS = { '8M': 8, '24M': 24, '50M': 50, '200M': 200, '300M': 300, '100M': 100, '1G': 1000, '2.5G': 2500, '5G': 5000, '8G': 8000, '10G': 10000, '16G': 16000, '25G': 25000, '32G': 32000, '40G': 40000, '64G': 64000, '100G': 100000, '200G': 200000, '400G': 400000 };

// Levenshtein distance, used only to tell a typo from a descriptive label. Two
// edits apart is close enough to be a slip of the fingers ("l3-foward"), and far
// enough that real words like "midspan" stay clear of the closed set.
function editDistance(a, b) {
  const s = String(a), t = String(b);
  const rows = [];
  for (let i = 0; i <= s.length; i++) rows.push([i]);
  for (let j = 1; j <= t.length; j++) rows[0][j] = j;
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
    }
  }
  return rows[s.length][t.length];
}

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

  // A passive splitter is unpowered and has no software stack, so an empty
  // capability list is correct for it rather than an omission.
  // A passive part has no software stack at all, so an empty capability list is the
  // accurate description of it rather than an omission. That covers splitters and
  // also inline taps, which are just a splitter for copper.
  const passive = spec.category === 'splitter' ||
    /\bpassive\b/i.test(String(spec.description || ''));
  if (!Array.isArray(spec.capabilities)) spec.capabilities = [];
  if (!spec.capabilities.length && !passive) {
    errors.push('capabilities must be a non-empty array');
  } else if (spec.capabilities.length) {
    spec.capabilities = normaliseCapabilities(spec.capabilities);
    // Capabilities are a CLOSED set because the simulator branches on them: if a
    // spec says "l3-forward" the box routes, so an unknown string must never be
    // waved through. But researchers also use this field descriptively ("midspan",
    // "poe-splitter", "802.3bt-type-3"), and rejecting the whole spec over a label
    // loses a perfectly good device.
    //
    // So: a near-miss of a real capability is a typo and is rejected ("l3-foward"
    // would silently cost the device its routing); anything else is hardware
    // description and moves to `role`, which the engine never branches on.
    const described = [];
    const kept = [];
    for (const c of spec.capabilities) {
      if (CAPABILITIES.indexOf(c) !== -1) { kept.push(c); continue; }
      const near = CAPABILITIES.filter(function (k) { return editDistance(c, k) <= 2; });
      if (near.length) {
        errors.push('capability "' + c + '" looks like a typo of "' + near[0] + '"');
      } else {
        described.push(c);
      }
    }
    spec.capabilities = kept;
    if (described.length) {
      // Keep the description, just not in the field the simulator branches on.
      spec.role = described;
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
  // Writing is opt-in. Research agents kept running this script bare and pushing
  // specs straight into the catalogue, which is how three classes of modelling error
  // reached main without passing the invariant gate (issue #10). A default dry run
  // means an agent has to type --apply on purpose, and a stray invocation prints what
  // it would have done instead of doing it.
  const apply = argv.indexOf('--apply') !== -1 || argv.indexOf('--write') !== -1;
  // --upgrade repairs an existing entry when the incoming spec carries more detail than
  // the one on disk. Still opt-in: it rewrites catalogue files, so it must be asked for.
  const upgrade = argv.indexOf('--upgrade') !== -1;
  const dryRun = !apply;
  const asJson = argv.indexOf('--json') !== -1;

  // Existing catalogue, keyed by vendor|model so we never overwrite vetted data.
  const existing = loadCatalog(DEVICES);
  function vendorDir(vendor) { return path.join(DEVICES, String(vendor)); }

  function writeSpec(spec, dir, model) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, slug(model) + '.json');
    fs.writeFileSync(out, JSON.stringify(spec, null, 2) + String.fromCharCode(10));
    return out;
  }

  // Where each existing spec actually lives. A repair must overwrite THAT file: re-deriving
  // the name from the model would create a second file beside an existing one with different
  // capitalisation ('U7-Pro.json' vs 'u7-pro.json') and the catalogue would load both.
  //
  // Two maps, because there are two notions of identity. The exact one is used by --upgrade;
  // the normalised one is used by the duplicate gate, because two spellings of one model live
  // in two DIFFERENT files and neither map would see the other otherwise (issue #60).
  const existingPathByKey = Object.create(null);
  const existingPathByNormalised = Object.create(null);
  (function () {
    function walk(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.json$/i.test(e.name)) continue;
        try {
          const spec = JSON.parse(fs.readFileSync(full, 'utf8'));
          if (spec && spec.vendor && spec.model) {
            existingPathByKey[String(spec.vendor) + '|' + String(spec.model).toLowerCase()] = full;
            const nk = modelKey(spec);
            if (!existingPathByNormalised[nk]) existingPathByNormalised[nk] = full;
          }
        } catch (e) { /* a broken file is another script's problem */ }
      }
    }
    walk(DEVICES);
  })();

  function writeSpecTo(spec, fullPath) {
    fs.writeFileSync(fullPath, JSON.stringify(spec, null, 2) + String.fromCharCode(10));
    return fullPath;
  }

  const known = Object.create(null);
  const existingByKey = Object.create(null);
  // modelKey -> the spec that already owns that identity, so a punctuation variant of an
  // existing model is refused instead of being written beside it. Seeded from the catalogue
  // and extended with every spec this run accepts, so one batch cannot introduce both
  // spellings either.
  const byNormalisedKey = Object.create(null);
  for (const s of existing) {
    const k = String(s.vendor) + '|' + String(s.model).toLowerCase();
    known[k] = true;
    existingByKey[k] = s;
    const nk = modelKey(s);
    if (!byNormalisedKey[nk]) {
      byNormalisedKey[nk] = {
        vendor: s.vendor,
        model: s.model,
        where: existingPathByNormalised[nk]
          ? path.relative(ROOT, existingPathByNormalised[nk]).replace(/\\/g, '/')
          : 'the catalogue'
      };
    }
  }

  // How much hardware detail a spec actually carries. Used by --upgrade, which repairs a
  // damaged entry only when the incoming spec says strictly more than the one on disk -
  // so re-running the importer over a research file cannot quietly replace a carefully
  // corrected catalogue entry with a thinner one.
  function detailScore(spec) {
    if (!spec) return 0;
    let n = 0;
    const keep = ['connector', 'cage', 'speedCaps', 'poeIn', 'poeOut', 'comboWith', 'comboRole',
      'dualRole', 'role', 'bridgeGroup', 'description', 'duplex', 'mac'];
    for (const i of (spec.interfaces || [])) {
      for (const k of keep) if (i[k] !== undefined && i[k] !== null) n++;
    }
    for (const k of ['poe', 'notes', 'sourceUrl', 'portSplitNote', 'splitRatio', 'insertionLossDb', 'radios']) {
      if (spec[k] !== undefined && spec[k] !== null) n++;
    }
    return n;
  }

  const groups = readIncoming();
  if (!groups.length) {
    console.log('No files in ' + path.relative(ROOT, INCOMING) + ' -- nothing to import.');
    return 0;
  }

  const report = { files: groups.length, seen: 0, added: [], duplicates: [], rejected: [], collisions: [], warnings: [] };

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
        const onDisk = existingByKey[key];
        // Repair only an entry that carries NO hardware detail at all - the exact
        // signature of one this importer flattened. An entry with any connector,
        // speedCap, PoE figure or note on it is left alone, because a research file
        // being longer is not evidence that it is more correct than a corrected entry.
        const richer = detailScore(onDisk) === 0 && detailScore(spec) > 0;
        if (upgrade && richer) {
          // Repair in place. The existing file is the one to rewrite, so the catalogue
          // keeps its path and any hand-written corrections that are still richer win.
          const target = existingPathByKey[key];
          if (!dryRun && target) writeSpecTo(spec, target);
          report.upgraded = report.upgraded || [];
          report.upgraded.push({ vendor: spec.vendor, model: spec.model, was: detailScore(onDisk), now: detailScore(spec) });
        } else {
          report.duplicates.push({ file: g.file, vendor: spec.vendor, model: spec.model });
        }
        continue;
      }
      // Punctuation is not an identity (issue #60). "ISR4331" and "ISR 4331" are the same
      // router, but slug() spells their files differently, so nothing collided at write
      // time and the catalogue ended up offering the box twice - with different port
      // counts, and there was no way to tell from the model string which one you had.
      // An exact match is a routine re-import and is reported above as a duplicate (and
      // repaired by --upgrade); a match that only differs in punctuation is a modelling
      // error, so it is refused and the spec it collides with is named.
      const nk = modelKey(spec);
      const clash = byNormalisedKey[nk];
      if (clash) {
        report.rejected.push({
          file: g.file,
          vendor: spec.vendor,
          model: spec.model,
          errors: ['duplicate model: ' + spec.vendor + '/' + spec.model + ' is the same device as the ' +
            'existing ' + clash.vendor + '/' + clash.model + ' (normalised key ' + nk +
            ', punctuation ignored) in ' + clash.where +
            ' - correct that spec instead of adding a second spelling']
        });
        report.collisions.push({
          file: g.file,
          vendor: spec.vendor,
          model: spec.model,
          key: nk,
          collidesWith: clash.vendor + '/' + clash.model,
          where: clash.where
        });
        continue;
      }
      byNormalisedKey[nk] = { vendor: spec.vendor, model: spec.model, where: g.file };

      known[key] = true;   // also guards duplicates inside the incoming batch
      if (v.warnings.length) report.warnings.push({ vendor: spec.vendor, model: spec.model, warnings: v.warnings });

      // Preserve the spec.
      //
      // This used to rebuild each interface as {name, type, speed} and drop everything
      // else - connector, cage, speedCaps, poeIn, poeOut, comboWith, comboRole, dualRole,
      // role, bridgeGroup - plus the top-level poe, notes, sourceUrl, portSplitNote,
      // splitRatio and insertionLossDb. The loss was silent: the engine infers a cage from
      // the port name, so a spec that had lost its connector still produced a plausible
      // port, and nothing failed. 684 of 878 devices ended up as name/type/speed only and
      // 170 described PoE while carrying no budget at all (issue #22).
      //
      // Copying the spec through means a new field a contributor adds survives the import
      // without anyone having to remember to whitelist it here.
      const clean = Object.assign({}, spec, {
        label: spec.label || spec.model,
        description: spec.description || (spec.vendor + ' ' + spec.model),
        capabilities: (spec.capabilities || []).slice()
      });
      if (Array.isArray(spec.interfaces)) {
        clean.interfaces = spec.interfaces.map(function (i) {
          // Keep every declared property; only normalise the ones the engine requires
          // and refuse a USB interface, which is not a network port.
          const out = Object.assign({}, i);
          out.name = i.name;
          out.type = i.type || 'ethernet';
          out.speed = i.speed;
          return out;
        });
      }

      if (!dryRun) writeSpec(clean, vendorDir(clean.vendor), clean.model);
      report.added.push({ vendor: clean.vendor, model: clean.model, category: clean.category });
    }
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return report.collisions.length ? 1 : 0;
  }

  const byVendor = {};
  for (const a of report.added) byVendor[a.vendor] = (byVendor[a.vendor] || 0) + 1;

  console.log('Scanned ' + report.files + ' file(s), ' + report.seen + ' spec(s)');
  console.log((dryRun ? 'Would add: ' : 'Added: ') + report.added.length +
    '  duplicates: ' + report.duplicates.length + '  rejected: ' + report.rejected.length +
    (report.collisions.length ? '  refused duplicate spellings: ' + report.collisions.length : '') +
    ((report.upgraded || []).length ? '  upgraded: ' + report.upgraded.length : ''));
  if ((report.upgraded || []).length) {
    console.log(dryRun ? 'Would repair (incoming spec carries more detail):' : 'Repaired from a richer spec:');
    for (const u of report.upgraded.slice(0, 20)) console.log('  ' + u.vendor + '/' + u.model + '  detail ' + u.was + ' -> ' + u.now);
    if (report.upgraded.length > 20) console.log('  ... and ' + (report.upgraded.length - 20) + ' more');
  }
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
  if (report.collisions.length) {
    console.log('\nRefused - already in the catalogue under a different spelling:');
    for (const c of report.collisions.slice(0, 20)) {
      console.log('  - ' + c.vendor + '/' + c.model + '  (' + c.file + ')');
      console.log('      is the same device as ' + c.collidesWith + ' in ' + c.where + '  [key ' + c.key + ']');
    }
    if (report.collisions.length > 20) console.log('  ... and ' + (report.collisions.length - 20) + ' more');
    console.log('  Punctuation is not an identity: fix the spec that is already there rather than' +
      ' adding a second spelling of it.');
  }
  if (report.warnings.length) console.log('\n' + report.warnings.length + ' spec(s) had minor warnings (still imported).');
  if (dryRun) console.log('\nDry run: nothing was written. Re-run with --apply to import.');
  // A collision is a catalogue-integrity failure, not a benign re-import, so the batch fails
  // loudly. Exact duplicates stay non-fatal: re-running a research file must remain a no-op.
  return report.collisions.length ? 1 : 0;
}

process.exit(main());
