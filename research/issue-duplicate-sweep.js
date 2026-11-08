'use strict';
// Which open device requests are already answered by the catalogue?
//
// The device-request form has been used heavily, and a backlog is only useful if the entries
// in it are still true. This walks the open [Device] issues, reads the vendor and model out of
// the title and the datasheet URL out of the body, and asks the catalogue whether it already
// holds that model. It reports; it does not close anything - a human or an agent decides,
// because "already present" has to be verified against the actual spec before an issue is shut.
//
// Matching is deliberately conservative and has three levels:
//   exact    - same vendor, same normalised model
//   vendorless exact - same normalised model under any vendor (catches a mis-filed vendor)
//   near     - one normalised model is a prefix of the other, or they differ only in a
//              documented SKU suffix; reported but never auto-classified as a duplicate
const fs = require('fs');
const path = require('path');
const { loadCatalog } = require('../devices/registry');

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function words(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// "[Device]: Vendor Model (PART, ...)" and "[Device]: HUAWEI 4G CPE 5"
function splitTitle(title) {
  const rest = title.replace(/^\[Device\]:\s*/i, '');
  const w = words(rest);
  if (!w.length) return { vendor: '', model: '' };
  const vendor = w[0];
  // The model is the title minus the vendor's first word, minus a trailing parenthetical.
  let model = rest.slice(rest.toLowerCase().indexOf(vendor) + vendor.length);
  model = model.replace(/\((?:[^()]*)\)\s*$/, '').trim();
  return { vendor: vendor, model: model.replace(/^[\s,:\-]+/, '').trim() };
}

const byNorm = new Map();
const byModelWords = [];
const fileOf = new Map();          // "vendor\u0000model" -> relative path, so the report can cite the file
const devRoot = path.join(__dirname, '..', 'devices');
for (const vendorDir of fs.readdirSync(devRoot)) {
  const abs = path.join(devRoot, vendorDir);
  if (!fs.statSync(abs).isDirectory()) continue;
  for (const f of fs.readdirSync(abs)) {
    if (!f.endsWith('.json')) continue;
    let spec = null;
    try { spec = JSON.parse(fs.readFileSync(path.join(abs, f), 'utf8')); } catch (e) { continue; }
    if (!spec || !spec.model) continue;
    fileOf.set(String(spec.vendor) + '\u0000' + String(spec.model), 'devices/' + vendorDir + '/' + f);
  }
}
for (const s of catalog) {
  const key = norm(s.model);
  if (!byNorm.has(key)) byNorm.set(key, []);
  byNorm.get(key).push(s);
  byModelWords.push({ spec: s, key: key, vendorKey: norm(s.vendor) });
}

const issues = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  .filter((i) => i.title.startsWith('[Device]'));

const exact = [], vendorless = [], near = [], none = [];

for (const issue of issues) {
  const { vendor, model } = splitTitle(issue.title);
  const key = norm(model);
  if (!key) { none.push({ issue: issue, vendor: vendor, model: model, why: 'no model in title' }); continue; }

  const hits = byNorm.get(key) || [];
  const sameVendor = hits.filter((h) => norm(h.vendor) === norm(vendor));
  if (sameVendor.length) {
    exact.push({ issue: issue, vendor: vendor, model: model, spec: sameVendor[0] });
    continue;
  }
  if (hits.length) {
    vendorless.push({ issue: issue, vendor: vendor, model: model, spec: hits[0] });
    continue;
  }

  // Near: the model and a catalogue model share a long common stem.
  let best = null;
  for (const m of byModelWords) {
    if (m.key.length < 6 || key.length < 6) continue;
    const shared = (m.key.startsWith(key) || key.startsWith(m.key));
    if (!shared) continue;
    const wouldBe = Math.min(m.key.length, key.length) / Math.max(m.key.length, key.length);
    if (wouldBe < 0.6) continue;
    const score = Math.min(m.key.length, key.length);
    if (!best || score > best.score) best = { spec: m.spec, score: score };
  }
  if (best) near.push({ issue: issue, vendor: vendor, model: model, spec: best.spec });
  else none.push({ issue: issue, vendor: vendor, model: model, why: 'not in catalogue' });
}

function line(tag, r) {
  const where = fileOf.get(String(r.spec.vendor) + '\u0000' + String(r.spec.model)) || '(file not found)';
  return tag + ' #' + r.issue.number + '  ' + r.issue.title.replace(/^\[Device\]:\s*/, '').slice(0, 62) +
    '\n        -> ' + r.spec.vendor + '/' + r.spec.model + '  (' + where + ')';
}

console.log('open device requests: ' + issues.length + '\n');
console.log('ALREADY PRESENT, same vendor: ' + exact.length);
for (const r of exact.slice(0, 60)) console.log('  ' + line('DUP', r));
if (exact.length > 60) console.log('  ... ' + (exact.length - 60) + ' more');
console.log('\nALREADY PRESENT, different vendor spelling: ' + vendorless.length);
for (const r of vendorless.slice(0, 30)) console.log('  ' + line('DUP?', r));
console.log('\nNEAR MISS (needs a human look): ' + near.length);
for (const r of near.slice(0, 30)) console.log('  ' + line('NEAR', r));
console.log('\nNOT IN CATALOGUE: ' + none.length);

const out = {
  exact: exact.map((r) => ({ number: r.issue.number, title: r.issue.title, vendor: r.spec.vendor, model: r.spec.model })),
  vendorless: vendorless.map((r) => ({ number: r.issue.number, title: r.issue.title, vendor: r.spec.vendor, model: r.spec.model })),
  near: near.map((r) => ({ number: r.issue.number, title: r.issue.title, vendor: r.spec.vendor, model: r.spec.model })),
  none: none.map((r) => ({ number: r.issue.number, title: r.issue.title, vendor: r.vendor, model: r.model, why: r.why }))
};
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
console.log('\nwrote ' + process.argv[3]);
