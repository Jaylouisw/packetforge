'use strict';
// The missing-devices scanner is what turns "if a device doesn't exist, make it
// so" from a habit into a gate. Three things must hold or the tool is worse than
// nothing:
//
//   1. It must fail on a topology that names hardware the catalogue lacks, and
//      stay quiet about hardware that is already there. A false positive blocks
//      every PR; a false negative lets the lab rot.
//   2. It must not write anything unless --stubs is given. A report-only run that
//      quietly creates files under research/incoming would look like research.
//   3. The skeleton it does write must not invent a device. category 'unknown'
//      and interfaces [] are the whole point: the port list has to come from a
//      datasheet, so the form hands the contributor a blank to fill in rather
//      than a plausible switch that refuses real cabling.
//
// Everything runs against a throwaway catalogue via PF_DEVICES/PF_INCOMING so
// this test can never touch devices/ or research/incoming.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { guessCategory, parseIssueRequests, diffIssueRequests, CATEGORIES } = require('../scripts/missing-devices');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const SCRIPT = path.join(__dirname, '..', 'scripts', 'missing-devices.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-missing-'));
const devicesDir = path.join(tmp, 'devices');
const labsDir = path.join(tmp, 'labs');
const incomingDir = path.join(tmp, 'incoming');
const cleanDir = path.join(tmp, 'clean-labs');
fs.mkdirSync(path.join(devicesDir, 'acme'), { recursive: true });
fs.mkdirSync(labsDir, { recursive: true });
fs.mkdirSync(incomingDir, { recursive: true });
fs.mkdirSync(cleanDir, { recursive: true });

// The catalogue we "have": exactly one model.
fs.writeFileSync(path.join(devicesDir, 'acme', 'exists-24.json'), JSON.stringify({
  vendor: 'acme', model: 'EXISTS-24', label: 'Exists 24', category: 'switch',
  capabilities: ['l2-forward', 'cli'],
  interfaces: [{ name: 'Gi0/1', type: 'ethernet', speed: '1G' }]
}, null, 2));

// A lab that asks for it twice, plus two models we do not have. PHANTOM-9000
// also appears in a second lab so the reference count is genuinely aggregated.
const labA = path.join(labsDir, 'lab-a.json');
fs.writeFileSync(labA, JSON.stringify({
  format: 'packetforge-topology', version: 1,
  devices: [
    { id: 'd1', vendor: 'acme', model: 'EXISTS-24' },
    { id: 'd2', vendor: 'acme', model: 'EXISTS-24' },
    { id: 'd3', vendor: 'acme', model: 'PHANTOM-9000' },
    { id: 'd4', vendor: 'acme', model: 'PHANTOM-9000' },
    { id: 'd5', vendor: 'acme', model: 'EDGESWITCH-8' }
  ],
  links: []
}, null, 2));
fs.writeFileSync(path.join(labsDir, 'lab-b.json'), JSON.stringify({
  format: 'packetforge-topology', version: 1,
  devices: [{ id: 'd1', vendor: 'acme', model: 'PHANTOM-9000' }],
  links: []
}, null, 2));

// A lab that only asks for hardware we already have.
fs.writeFileSync(path.join(cleanDir, 'lab-clean.json'), JSON.stringify({
  format: 'packetforge-topology', version: 1,
  devices: [{ id: 'd1', vendor: 'acme', model: 'EXISTS-24' }],
  links: []
}, null, 2));

function run(args) {
  const env = Object.assign({}, process.env, {
    PF_DEVICES: devicesDir,
    PF_INCOMING: incomingDir
  });
  // --no-issues keeps the test off the network and off the real issue tracker.
  const full = [SCRIPT].concat(args).concat(['--no-issues']);
  try {
    const out = execFileSync(process.execPath, full, { encoding: 'utf8', env: env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}

function incomingFiles() {
  return fs.readdirSync(incomingDir).filter(function (f) { return f.endsWith('.json'); });
}

console.log('A lab that names hardware we do not have fails the gate:');
{
  const r = run([labsDir, '--json']);
  let report = null;
  try { report = JSON.parse(r.out); } catch (e) { /* asserted below */ }
  ok(r.code === 1, 'exit code is 1 when a referenced model is missing');
  ok(!!report, 'with --json it prints a parsable report');
  const missing = (report && report.missing) || [];
  const models = missing.map(function (m) { return m.model; });
  ok(models.indexOf('PHANTOM-9000') !== -1, 'the unknown model is reported');
  ok(models.indexOf('EDGESWITCH-8') !== -1, 'every unknown model is reported, not just the first');
  ok(models.indexOf('EXISTS-24') === -1, 'the known model is NOT reported');

  const phantom = missing.find(function (m) { return m.model === 'PHANTOM-9000'; });
  ok(!!phantom && phantom.count === 3, 'references are counted across files (3)');
  ok(!!phantom && phantom.files.length === 2, 'both referencing files are listed');
  ok(!!phantom && phantom.vendor === 'acme', 'grouped under the right vendor');
  ok(report.scanned.topologies === 2, 'both topology files were scanned');
  ok(report.ok === false, 'report marks itself not-ok');
}

console.log('\nNothing is written unless --stubs is passed:');
{
  ok(incomingFiles().length === 0, 'the report-only run created no file under research/incoming');

  const human = run([labsDir]);
  ok(human.code === 1, 'the human-readable run also exits 1');
  ok(/PHANTOM-9000/.test(human.out), 'the role name appears in the report');
  ok(/node scripts\/missing-devices\.js --stubs/.test(human.out),
    'it prints the exact next command for a missing model');
  ok(/issues\/new\?template=device_request\.yml/.test(human.out),
    'it prints the hardware-request template URL');
  ok(incomingFiles().length === 0, 'printing commands writes nothing either');
}

console.log('\nA compliant topology passes:');
{
  const r = run([cleanDir, '--json']);
  ok(r.code === 0, 'exit code is 0 when every referenced model exists');
  const report = JSON.parse(r.out);
  ok(report.missing.length === 0, 'no missing models');
  ok(report.ok === true, 'report marks itself ok');
}

console.log('\n--stubs writes a form, not a fabricated device:');
{
  const r = run([labsDir, '--stubs', '--json']);
  ok(r.code === 1, 'writing skeletons does not hide the failure -- still exit 1');
  let report = null;
  try { report = JSON.parse(r.out); } catch (e) { /* asserted below */ }
  ok(!!report, '--stubs --json keeps stdout parsable instead of logging into it');
  ok(!!report && Array.isArray(report.writes) && report.writes.length === 1 &&
    /missing-acme\.json$/.test(report.writes[0].file),
    'the report says which file it wrote');
  const files = incomingFiles();
  ok(files.length === 1 && files[0] === 'missing-acme.json',
    'one skeleton per vendor, named missing-<vendor>.json');

  const skeletons = JSON.parse(fs.readFileSync(path.join(incomingDir, 'missing-acme.json'), 'utf8'));
  ok(Array.isArray(skeletons) && skeletons.length === 2, 'one entry per missing model');

  const phantom = skeletons.find(function (s) { return s.model === 'PHANTOM-9000'; });
  ok(!!phantom, 'the unknown model has an entry');
  ok(phantom.category === 'unknown',
    'category is unknown rather than guessed from a string that says nothing');
  ok(Array.isArray(phantom.interfaces) && phantom.interfaces.length === 0,
    'interfaces is an empty array -- no invented port list');
  ok(JSON.stringify(phantom.capabilities) === JSON.stringify(['host']),
    'capabilities is the obvious placeholder, not a claim about the hardware');
  ok(typeof phantom.note === 'string' && /datasheet/i.test(phantom.note),
    'the note says the port list must come from a datasheet');
  ok(typeof phantom.categoryNote === 'string' && /datasheet/i.test(phantom.categoryNote),
    'the unknown category is explained, not silent');
  ok(phantom.vendor === 'acme' && phantom.label === 'PHANTOM-9000',
    'vendor and label are filled in so the contributor only supplies facts');
  ok(Array.isArray(phantom.requestedBy) && phantom.requestedBy.length === 2,
    'the skeleton records which labs asked for it');
  ok(!('portTemplate' in phantom), 'no port template is invented either');

  const edge = skeletons.find(function (s) { return s.model === 'EDGESWITCH-8'; });
  ok(!!edge && edge.category === 'switch',
    'a model string that names its type outright does get that category');
  ok(!!edge && /guessed from the model string/i.test(edge.categoryNote),
    'and the guess is labelled as a guess');
  ok(Array.isArray(edge.interfaces) && edge.interfaces.length === 0,
    'even a confidently-typed guess ships with no ports');
}

console.log('\nRe-running is safe for whoever is filling the form in:');
{
  const file = path.join(incomingDir, 'missing-acme.json');
  const first = fs.readFileSync(file, 'utf8');
  run([labsDir, '--stubs']);
  ok(fs.readFileSync(file, 'utf8') === first, 'a second --stubs run does not duplicate or rewrite the file');

  // A contributor has started work: a category, one port, a datasheet.
  const edited = JSON.parse(first);
  const phantom = edited.find(function (s) { return s.model === 'PHANTOM-9000'; });
  phantom.category = 'l3-switch';
  phantom.interfaces = [{ name: 'Gi0/1', type: 'ethernet', speed: '1G' }];
  phantom.sourceUrl = 'https://example.com/phantom-9000.pdf';
  fs.writeFileSync(file, JSON.stringify(edited, null, 2) + '\n');

  run([labsDir, '--stubs']);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  const kept = after.find(function (s) { return s.model === 'PHANTOM-9000'; });
  ok(kept.category === 'l3-switch', 'a human-entered category is not overwritten by the guess');
  ok(kept.interfaces.length === 1, 'a human-entered port list is not wiped');
  ok(kept.sourceUrl === 'https://example.com/phantom-9000.pdf', 'the datasheet URL survives');
}

console.log('\nCategory inference refuses to guess ahead of the string:');
{
  ok(guessCategory('ZPHYR-9000').category === 'unknown', 'an opaque model number stays unknown');
  ok(guessCategory('CRS328-24P-4S+RM').category === 'unknown',
    'a vendor-specific prefix (CRS = router/switch) is product knowledge, not a string fact');
  ok(guessCategory('generic-router').category === 'router', 'a literal name is used');
  ok(guessCategory('EdgeSwitch-16').category === 'switch', 'a compound literal name is used');
  ok(guessCategory('OLT-16').category === 'olt', 'OLT is unambiguous');
  ok(guessCategory('Front-Panel-8').category === 'unknown',
    '"ont" inside another word is not an ONT');
  ok(guessCategory('').category === 'unknown', 'an empty model string is safe');
  ok(guessCategory(null).category === 'unknown', 'a null model string is safe');

  const inferred = ['generic-router', 'EdgeSwitch-16', 'OLT-16', 'ACME-Camera', 'ACME-NAS']
    .map(function (m) { return guessCategory(m).category; });
  ok(inferred.every(function (c) { return CATEGORIES.indexOf(c) !== -1; }),
    "every inferred category is one scripts/import-devices.js accepts");
  ok(CATEGORIES.indexOf('unknown') === -1,
    "'unknown' is deliberately outside the importer's vocabulary, so a skeleton cannot be imported unedited");
}

console.log('\nOpen requests join the report, and a missing gh is not a failure:');
{
  const parsed = parseIssueRequests([
    { number: 7, url: 'https://example/7', title: '[Device]: Acme PHANTOM-9000',
      body: '### Vendor\n\nAcme\n\n### Exact model name\n\nPHANTOM-9000\n\n### Category\n\nSwitch (L2)\n' },
    { number: 8, url: 'https://example/8', title: '[Device]: Synology DS923+', body: 'Please add it.' },
    { number: 9, url: 'https://example/9', title: 'Not a hardware request', body: '' }
  ]);
  ok(parsed.length === 2, 'an issue that names no model is dropped rather than reported as a gap');
  ok(parsed[0].vendor === 'acme' && parsed[0].model === 'PHANTOM-9000', 'issue-form fields are read');
  ok(parsed[1].vendor === null && parsed[1].model === 'Synology DS923+',
    'a hand-filed issue falls back to its title');

  const have = new Set(['acme|exists-24']);
  ok(diffIssueRequests(parsed, have, new Set(['acme|phantom-9000'])).length === 0,
    'a request a lab already reported is not counted twice');
  const fresh = diffIssueRequests(parsed, have, new Set());
  ok(fresh.length === 1 && fresh[0].number === 7,
    'a request without a vendor cannot be written to devices/<vendor>/, so it is left to request-queue.js');

  const r = run([cleanDir]);
  ok(/not scanned/.test(r.out) && /--no-issues/.test(r.out),
    'when the issue scan is off, the report says so instead of failing');
  ok(r.code === 0, 'and the exit code still reflects the topologies, which are clean');
}

console.log('\nA device entry with no vendor is reported, but nothing is written for it:');
{
  const d = path.join(tmp, 'no-vendor');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'lab.json'), JSON.stringify({ devices: [{ model: 'NOVENDOR-1' }] }));
  const r = run([d, '--stubs', '--json']);
  ok(r.code === 1, 'it is still a gap and still fails the gate');
  const rep = JSON.parse(r.out);
  ok(rep.missing[0].vendor === '(unknown)', 'it is reported under (unknown)');
  ok(rep.missing[0].skeleton === null, 'no skeleton path is promised when there is no vendor directory');
  ok(incomingFiles().every(function (f) { return f.indexOf('unknown') === -1; }),
    'and no missing-unknown.json appears in research/incoming');
}

console.log('\nBad input is an error, not a silent pass:');
{
  const r = run([path.join(tmp, 'does-not-exist')]);
  ok(r.code === 2, 'a missing path exits 2 rather than reporting success');
  const empty = path.join(tmp, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  ok(run([empty]).code === 2, 'a directory with no labs exits 2');

  // A spec dump is JSON but not a topology. Treating it as an empty lab would
  // turn a renamed format key into a silent pass.
  const notLabs = path.join(tmp, 'not-labs');
  fs.mkdirSync(notLabs, { recursive: true });
  fs.writeFileSync(path.join(notLabs, 'specs.json'), JSON.stringify([{ vendor: 'acme', model: 'X' }]));
  ok(run([notLabs]).code === 2, 'a directory of non-topology JSON exits 2 rather than passing');

  const mixed = path.join(tmp, 'mixed');
  fs.mkdirSync(mixed, { recursive: true });
  fs.copyFileSync(path.join(cleanDir, 'lab-clean.json'), path.join(mixed, 'lab.json'));
  fs.copyFileSync(path.join(notLabs, 'specs.json'), path.join(mixed, 'specs.json'));
  const mixedRun = run([mixed]);
  ok(mixedRun.code === 0, 'a non-topology file next to a lab is skipped, not fatal');
  ok(/skipped .*specs\.json/.test(mixedRun.out), 'and the skip is reported');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
