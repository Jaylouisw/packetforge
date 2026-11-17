'use strict';
// Six requests were closed as "impossible to model" while the catalogue already had every one
// of them: #54, #167, #360, #362, #374, #387. Nothing noticed, because the sweeper only looks
// at OPEN issues - closing a request removes it from every automated view, so a wrong close is
// permanent and invisible.
//
// `scripts/check-closed-issues.js` walks the other side of the ledger. These tests pin the part
// that decides, because a false "answered" here is exactly the mistake it exists to detect.
const path = require('path');
const { buildIndex, matchClosedIssue, auditClosedIssue, blockedRequestNumbers, loadCatalogueFiles, closedIssuesUrl, hasEvidence } = require(path.join(__dirname, '..', 'scripts', 'check-closed-issues.js'));

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; }
  else { failed++; console.log('  not ok - ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const SPECS = [
  { vendor: 'teltonika', model: 'RUTX12', file: 'devices/teltonika/rutx12.json', category: 'router' },
  { vendor: 'ubiquiti', model: 'U6-Extender', file: 'devices/ubiquiti/u6-extender.json', category: 'wireless' },
  { vendor: 'teltonika', model: 'TRM500', file: 'devices/teltonika/trm500.json', category: 'modem' },
  { vendor: 'huawei', model: 'NetEngine 8000 M1D-B', file: 'devices/huawei/netengine-8000-m1d-b.json', category: 'router' },
  { vendor: 'ubiquiti', model: 'Ultra', file: 'devices/ubiquiti/ultra.json', category: 'router' },
  { vendor: 'roku', model: 'Ultra', file: 'devices/roku/ultra.json', category: 'iot' }
];
const INDEX = buildIndex(SPECS);

console.log('');
console.log('The six that were closed while already modelled:');
const CASES = [
  { n: 387, title: '[Device]: Teltonika RUTX12 Dual LTE 4G CAT6 Industrial Cellular Router', file: 'devices/teltonika/rutx12.json' },
  { n: 54, title: '[Device]: Ubiquiti UniFi U6-Extender Access Point', file: 'devices/ubiquiti/u6-extender.json' },
  { n: 360, title: '[Device]: Teltonika TRM500 5G MODEM (TRM500)', file: 'devices/teltonika/trm500.json' }
];
for (const c of CASES) {
  const hit = matchClosedIssue({ number: c.n, title: c.title }, INDEX);
  ok(hit && hit.file === c.file, '#' + c.n + ' matches ' + c.file, hit ? hit.file : 'no match');
}

console.log('');
console.log('But it must not invent an answer:');
ok(matchClosedIssue({ number: 1, title: '[Device]: Ubiquiti Iso-Beam-19 RF Isolator Shield for NanoBeam NBE-M5-19' }, INDEX) === null,
  'a title naming a device that is not in the catalogue stays unmatched');
ok(matchClosedIssue({ number: 2, title: '[Device]: Some Unreleased Thing 9000' }, INDEX) === null,
  'an unknown device is not matched by a shared word');
ok(matchClosedIssue({ number: 3, title: '' }, INDEX) === null, 'an empty title matches nothing');
ok(matchClosedIssue({ number: 4, title: '[Device]: Ubiquiti Ultra' }, INDEX).vendor === 'ubiquiti',
  'two vendors with the same model name resolve to a real one, not to a crash');

console.log('');
console.log('Evidence is what makes a close checkable:');
ok(hasEvidence([{ body: 'Already in the catalogue: `devices/teltonika/rutx12.json`' }]) === true, 'a spec path counts');
ok(hasEvidence([{ body: 'Landed in #1204, see notes.' }]) === true, 'a landing PR counts');
ok(hasEvidence([{ body: 'done' }]) === false, '"done" is not evidence');
ok(hasEvidence([]) === false, 'no comments is not evidence');
ok(hasEvidence(null) === false, 'null comments is not evidence');

console.log('');
console.log('Verdicts, including the case that matters - closed, modelled, silent:');
const silent = auditClosedIssue({ number: 387, title: '[Device]: Teltonika RUTX12 Dual LTE 4G CAT6' }, INDEX, [{ body: 'closing, impossible to model' }]);
ok(silent.verdict === 'silent' && silent.file === 'devices/teltonika/rutx12.json', 'the #387 shape is reported as silent', JSON.stringify(silent));
const answered = auditClosedIssue({ number: 387, title: '[Device]: Teltonika RUTX12' }, INDEX, [{ body: 'Already in the catalogue: devices/teltonika/rutx12.json' }]);
ok(answered.verdict === 'answered', 'the same close with evidence is not a finding');
const unknown = auditClosedIssue({ number: 9, title: '[Device]: Nothing Like It' }, INDEX, [{ body: 'done' }]);
ok(unknown.verdict === 'unmatched', 'an unmatched subject is not a finding');
const unread = auditClosedIssue({ number: 387, title: '[Device]: Teltonika RUTX12' }, INDEX, null);
ok(unread.verdict === 'answered' && unread.documented === null,
  'when comments could not be fetched the finding is not blamed on the closer');

console.log('');
console.log('Against the real catalogue, the six real cases (this is the regression that matters):');
try {
  const { loadCatalog } = require(path.join(__dirname, '..', 'devices', 'registry'));
  const specs = loadCatalog(path.join(__dirname, '..', 'devices'));
  const index = buildIndex(specs);
  const real = [
    [387, '[Device]: Teltonika RUTX12 Dual LTE 4G CAT6 Industrial Cellular Router'],
    [54, '[Device]: Ubiquiti UniFi U6-Extender Access Point'],
    [167, '[Device]: Ubiquiti UniFi Access Point BeaconHD (UAP-BeaconHD)'],
    [360, '[Device]: Teltonika TRM500 5G MODEM (TRM500)'],
    [362, '[Device]: Teltonika TRM240 4G Industrial Cellular Modem (TRM240)'],
    [374, '[Device]: Teltonika TRB141 Industrial Rugged GPIO LTE Gateway']
  ];
  const misses = real.filter(function (r) { return !matchClosedIssue({ number: r[0], title: r[1] }, index); });
  ok(misses.length === 0, 'all six resolve against the live catalogue', misses.map(function (m) { return '#' + m[0]; }).join(', '));
} catch (e) {
  ok(false, 'the catalogue loads', e.message);
}

console.log('');
console.log('A close that contradicts our own blocked-request record is a finding:');
// #742 and #743 were closed by the merges of #1873 and #1867 on 2026-11-17, seconds after each
// issue's own last comment said "the issue stays open". Nothing was built: the vendor still
// publishes no port value for either. Forgejo parses `<keyword> #N` anywhere in a PR body, so
// "Does **not** close #743" and "## What would close #742" both read as instructions to close.
// The catalogue cannot catch that - there is no device to match - so the record that can is
// research/open-device-requests.json, which declared both of them blocked at the time.
const MIRROR = { note: 'x', requests: [{ issue: 742, models: 'Huawei OceanProtect E8000' }, { issue: 743, models: 'OceanProtect X8100/X9100' }] };
const BLOCKED = blockedRequestNumbers(MIRROR);
ok(BLOCKED && BLOCKED.has(742) && BLOCKED.has(743), 'the mirror yields its issue numbers', JSON.stringify(Array.from(BLOCKED || [])));
ok(blockedRequestNumbers(null).size === 0, 'a missing mirror blocks nothing rather than throwing');
ok(blockedRequestNumbers({ requests: [{ models: 'no number' }] }).size === 0, 'an entry without an issue number is ignored');
const closed742 = auditClosedIssue({ number: 742, title: '[Device]: Huawei OceanProtect E8000 Backup Storage' }, INDEX, [{ body: 'Still blocked on the same field - the issue stays open.' }], BLOCKED);
ok(closed742.verdict === 'blocked', '#742 closed while still declared blocked is a finding', JSON.stringify(closed742));
ok(auditClosedIssue({ number: 900, title: '[Device]: Some Unreleased Thing 9000' }, INDEX, [], BLOCKED).verdict === 'unmatched',
  'an issue outside the mirror keeps its old verdict');
ok(auditClosedIssue({ number: 387, title: '[Device]: Teltonika RUTX12 Dual LTE 4G CAT6' }, INDEX, null, new Set([387])).verdict === 'blocked',
  'a blocked entry the catalogue now has is still a contradiction, not an answer');
ok(auditClosedIssue({ number: 387, title: '[Device]: Teltonika RUTX12 Dual LTE 4G CAT6' }, INDEX, [{ body: 'done' }]).verdict === 'silent',
  'without a mirror the old verdicts are unchanged');
try {
  const fs = require('fs');
  const file = path.join(__dirname, '..', 'research', 'open-device-requests.json');
  const real = blockedRequestNumbers(JSON.parse(fs.readFileSync(file, 'utf8')));
  ok(real.has(742), 'the live mirror still lists the E8000 request', JSON.stringify(Array.from(real)));
} catch (e) {
  ok(false, 'research/open-device-requests.json parses', e.message);
}

console.log('');
console.log('The window has to contain the newest close, not the newest number:');
const U = closedIssuesUrl('http://odin:3000/api/v1', 'jaylouisw/packetforge', 1);
ok(U.indexOf('state=closed') !== -1 && U.indexOf('type=issues') !== -1, 'the audit reads closed issues, not pulls', U);
ok(/[?&]sort=recentupdate(&|$)/.test(U), 'sorted by most recent update, so a fresh close is on page 1', U);
ok(closedIssuesUrl('b', 'r', 3) !== closedIssuesUrl('b', 'r', 2), 'pages differ');

console.log('');
console.log('A finding has to name the file it found - the catalogue loader drops the path:');
try {
  const FILES = loadCatalogueFiles(path.join(__dirname, '..', 'devices')).map(function (f) { return f; });
  const rutx = FILES.find(function (f) { return /^RUTX12$/i.test(String(f.model)); });
  ok(rutx && rutx.file === 'devices/teltonika/rutx12.json', 'the RUTX12 spec keeps its path', rutx && rutx.file);
  const bad = FILES.filter(function (f) { return !/^devices\/[^\/]+\/[^\/]+\.json$/.test(String(f.file)); });
  ok(bad.length === 0, 'every entry carries a repo-relative posix path', bad.slice(0, 3).map(function (f) { return f.model; }).join(', '));
  const fileIndex = buildIndex(FILES);
  const found = auditClosedIssue({ number: 804, title: '[Device]: OptiXtrans E6608T' }, fileIndex, []);
  ok(found.verdict === 'silent' && found.file === 'devices/huawei/optixtrans-e6608t.json',
    'a silent finding names the spec, not null', JSON.stringify(found));
} catch (e) {
  ok(false, 'the catalogue files load', e.message);
}

console.log('');
console.log('The open-request ledger must not name hardware the catalogue already holds:');
// #743 was closed on 2026-11-17 by the merge of #1902, which landed `devices/huawei/oceanprotect-x8100.json`
// and `-x9100.json` - the management plane, with the front-end census still unmodelled and named in each
// spec's own notes. The row stayed in `research/open-device-requests.json` anyway, so docs/DEVICE_REGISTRY.md
// counted a closed issue among "hardware requests are open" and `scripts/check-closed-issues.js` printed a
// contradiction for it on every merge. Nothing mechanical compared the two files: the mirror is keyed on the
// issue number, the catalogue on the model, and the only join was a human reading both. This is that join.
//
// A mirror entry's model list is prose with a slash in it ("OceanProtect X8100 / X9100") and the catalogue
// keys on `model` plus `aliases`, so the comparison splits the prose and checks both fields, case- and
// punctuation-insensitively. A row for hardware already in `devices/` is not an open request: the remaining
// gap belongs in the spec's notes or in a new request, not in a table of what is waiting on a vendor.
try {
  const fs = require('fs');
  const { norm: normName } = require(path.join(__dirname, '..', 'scripts', 'sweep-device-requests.js'));
  const { loadCatalog } = require(path.join(__dirname, '..', 'devices', 'registry'));
  const specs = loadCatalog(path.join(__dirname, '..', 'devices'));
  const byName = new Map();
  for (const spec of specs) {
    if (!spec) continue;
    if (spec.model) byName.set(normName(spec.model), spec.model);
    for (const alias of spec.aliases || []) byName.set(normName(alias), spec.model);
  }
  const ledger = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'open-device-requests.json'), 'utf8'));
  const requests = Array.isArray(ledger.requests) ? ledger.requests : [];
  const stale = [];
  for (const request of requests) {
    const tokens = String(request.models || '')
      .split(/[\/&,]| and /i)
      .map(function (t) { return t.trim(); })
      .filter(Boolean);
    for (const token of tokens) {
      const hit = byName.get(normName(token));
      if (hit) stale.push('#' + request.issue + ' -> ' + hit);
    }
  }
  ok(stale.length === 0, 'no open-request row names a model the catalogue holds', stale.join(', '));
  ok(!requests.some(function (r) { return Number(r.issue) === 743; }),
    '#743 is out of the ledger - #1902 answered it with the X8100/X9100 specs');
  ok(requests.some(function (r) { return Number(r.issue) === 742; }),
    'the E8000 request is still in the ledger, which is what proves the check can see a live row');
} catch (e) {
  ok(false, 'the ledger and the catalogue can be compared', e.message);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
