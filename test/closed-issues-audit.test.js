'use strict';
// Six requests were closed as "impossible to model" while the catalogue already had every one
// of them: #54, #167, #360, #362, #374, #387. Nothing noticed, because the sweeper only looks
// at OPEN issues - closing a request removes it from every automated view, so a wrong close is
// permanent and invisible.
//
// `scripts/check-closed-issues.js` walks the other side of the ledger. These tests pin the part
// that decides, because a false "answered" here is exactly the mistake it exists to detect.
const path = require('path');
const { buildIndex, matchClosedIssue, auditClosedIssue, hasEvidence } = require(path.join(__dirname, '..', 'scripts', 'check-closed-issues.js'));

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

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
