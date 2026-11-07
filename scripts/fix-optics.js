'use strict';
// fix-optics.js -- make optical uplinks expressible.
//
// A spec that says "48x 1G RJ45, 4x 1G SFP" but models all 52 ports with one
// portTemplate gives every port a copper RJ45 cage, because cage is inferred
// from the port NAME and "1/1/49" looks like copper. A 1G SFP uplink is then
// indistinguishable from a 1G RJ45 port, so the simulator lets you plug copper
// into a fibre cage.
//
// This rewrites such devices so the uplinks are explicit interfaces carrying an
// explicit "cage". Only the description is trusted as the source of truth, and
// only when the counts are unambiguous.
//
// Usage:
//   node scripts/fix-optics.js            # report what it would change
//   node scripts/fix-optics.js --apply    # rewrite the JSON files
const fs = require('fs');
const path = require('path');
const { loadCatalog } = require('../devices/registry');
const { expandInterfaces } = require('../engine/topology');
const media = require('../engine/media');

const ROOT = path.join(__dirname, '..');
const DEVICES = path.join(ROOT, 'devices');
const OPTICAL_CAGES = ['sfp', 'sfp+', 'sfp28', 'qsfp+', 'qsfp28'];

// Both patterns REQUIRE the "Nx" multiplier. Without it "40G QSFP+" would parse
// as count=4, speed=0G, because the digits of the speed get eaten by the count.
const OPTICAL_RE = /(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*([GM])\s*(?:SFP56|SFP28|SFP\+|SFP|QSFP28|QSFP\+|QSFP|XFPP?|CFP)\b/gi;
// "24x 1G RJ45", "48 x RJ-45", "24x RJ45"
const COPPER_RE = /(\d+)\s*x\s*(?:(\d+(?:\.\d+)?)\s*([GM])\s*)?(?:RJ-?45)\b/gi;

function cageFor(speedG) {
  const g = Number(speedG);
  if (g >= 100) return 'qsfp28';
  if (g >= 40) return 'qsfp+';
  if (g >= 25) return 'sfp28';
  if (g >= 10) return 'sfp+';
  return 'sfp';                 // 1G optical cage
}

function speedStr(num, unit) {
  return String(num) + String(unit).toUpperCase();
}

// Pull every "Nx <speed> SFP-ish" claim out of the description.
function opticalClaims(desc) {
  const out = [];
  OPTICAL_RE.lastIndex = 0;
  let m;
  while ((m = OPTICAL_RE.exec(String(desc || ''))) !== null) {
    const g = parseFloat(m[2]);
    if (!(g > 0)) continue;
    out.push({ count: parseInt(m[1], 10), speed: speedStr(m[2], m[3]) });
  }
  return out;
}

// Copper port claims. Returns an ARRAY so the caller can refuse devices with
// mixed copper speeds ("10x 1G RJ45 + 2x 2.5G RJ45"), which one portTemplate
// cannot represent.
function copperClaims(desc) {
  const out = [];
  COPPER_RE.lastIndex = 0;
  let m;
  while ((m = COPPER_RE.exec(String(desc || ''))) !== null) {
    out.push({ count: parseInt(m[1], 10), speed: m[2] ? speedStr(m[2], m[3]) : null });
  }
  return out;
}

// Map "vendor|model" to the real file on disk. Deriving a filename from the
// model is unsafe: devices/ubiquiti/er-4.json holds model "EdgeRouter-4".
function indexFiles() {
  const map = Object.create(null);
  for (const vendor of fs.readdirSync(DEVICES)) {
    const vdir = path.join(DEVICES, vendor);
    if (!fs.statSync(vdir).isDirectory()) continue;
    for (const f of fs.readdirSync(vdir)) {
      if (!/\.json$/i.test(f)) continue;
      const full = path.join(vdir, f);
      try {
        const j = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (j && j.vendor && j.model) map[j.vendor + '|' + j.model] = full;
      } catch (e) { /* unreadable files are reported by the audit */ }
    }
  }
  return map;
}

function main() {
  const apply = process.argv.indexOf('--apply') !== -1;
  const cat = loadCatalog(DEVICES);
  const files = indexFiles();
  const changes = [];
  const skipped = [];

  for (const spec of cat) {
    const ifaces = expandInterfaces(spec);
    const optical = ifaces.filter(function (i) {
      return OPTICAL_CAGES.indexOf(media.derivePortHardware(i, spec).cage) !== -1;
    }).length;
    if (optical > 0) continue;                       // already expresses optics

    const claims = opticalClaims(spec.description);
    if (!claims.length) continue;                    // nothing to go on

    const total = claims.reduce(function (a, c) { return a + c.count; }, 0);
    // The COPPER_RE needs a speed capture group for this check to be useful.
    const coppers = copperClaims(spec.description);
    if (coppers.length !== 1) {
      skipped.push({
        model: spec.vendor + '/' + spec.model,
        why: coppers.length ? coppers.length + ' copper groups (mixed speeds) - needs manual review'
                            : 'no explicit "Nx ... RJ45" claim to size the copper ports'
      });
      continue;
    }
    const copper = coppers[0].count;
    // Universal guard: only append uplinks when the device currently declares
    // exactly its copper ports. If it already declares more, the uplinks exist
    // (merely typed as copper) and appending would duplicate them.
    if (ifaces.length !== copper) {
      skipped.push({
        model: spec.vendor + '/' + spec.model,
        why: ifaces.length + ' ports declared vs ' + copper + ' copper claimed - uplinks already present, needs cage annotation not append'
      });
      continue;
    }
    const srcFile = files[spec.vendor + '|' + spec.model];
    if (!srcFile) { skipped.push({ model: spec.vendor + '/' + spec.model, why: 'source file not found' }); continue; }
    const raw = JSON.parse(fs.readFileSync(srcFile, 'utf8'));

    // A template can only represent one copper speed; refuse a mismatch.
    if (raw.portTemplate && coppers[0].speed && String(raw.portTemplate.speed) !== coppers[0].speed) {
      skipped.push({
        model: spec.vendor + '/' + spec.model,
        why: 'template speed ' + raw.portTemplate.speed + ' != claimed copper speed ' + coppers[0].speed
      });
      continue;
    }
    if (copper + total > 512) {
      skipped.push({ model: spec.vendor + '/' + spec.model, why: 'total ports ' + (copper + total) + ' out of range' });
      continue;
    }
    const plan = { model: spec.vendor + '/' + spec.model, added: [], shrunk: null, before: ifaces.length };

    if (raw.portTemplate) {
      // The template models the copper ports; the uplinks become explicit
      // interfaces with a real optical cage.
      if (!(copper >= 1 && copper <= 512)) {
        skipped.push({ model: plan.model, why: 'copper count ' + copper + ' out of range' });
        continue;
      }
      if (Number(raw.portTemplate.count) !== copper) {
        plan.shrunk = { from: Number(raw.portTemplate.count), to: copper };
      }
      const start = Number(raw.portTemplate.start) || 0;
      let n = start + copper;
      for (const c of claims) {
        for (let k = 0; k < c.count; k++) {
          plan.added.push({ name: raw.portTemplate.prefix + (n++), type: 'ethernet', speed: c.speed, cage: cageFor(parseFloat(c.speed)) });
        }
      }
    } else {
      // Explicit list: append the uplinks ONLY when they are genuinely missing.
      // If the device already has more ports than copper claims, its uplinks are
      // already present (just typed as copper) and appending would duplicate them.
      if (ifaces.length !== copper) {
        skipped.push({
          model: plan.model,
          why: ifaces.length + ' ports already declared vs ' + copper + ' copper claimed - uplinks present, need cage annotation not append'
        });
        continue;
      }
      let n = ifaces.length + 1;
      for (const c of claims) {
        for (let k = 0; k < c.count; k++) {
          plan.added.push({ name: 'SFP' + (n++), type: 'ethernet', speed: c.speed, cage: cageFor(parseFloat(c.speed)) });
        }
      }
    }

    changes.push({ spec: spec, raw: raw, plan: plan, file: srcFile });
  }

  for (const c of changes) {
    const p = c.plan;
    console.log((p.model).padEnd(38) +
      (p.shrunk ? 'ports ' + p.shrunk.from + '->' + p.shrunk.to + '  ' : '') +
      '+ ' + p.added.map(function (a) { return a.name + '/' + a.speed + '/' + a.cage; }).join(' '));
    if (!apply) continue;

    const raw = c.raw;
    if (p.shrunk) raw.portTemplate.count = p.shrunk.to;
    raw.interfaces = (raw.interfaces || []).concat(p.added);
    fs.writeFileSync(c.file, JSON.stringify(raw, null, 2) + '\n');
  }

  console.log('\n' + changes.length + ' device(s) ' + (apply ? 'rewritten' : 'would be rewritten') +
    ', ' + skipped.length + ' skipped');
  for (const s of skipped.slice(0, 10)) console.log('   skip ' + s.model + ': ' + s.why);
  if (!apply && changes.length) console.log('Re-run with --apply to write.');
  return 0;
}

process.exit(main());
