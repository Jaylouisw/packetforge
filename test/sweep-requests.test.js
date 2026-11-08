'use strict';
// The request sweeper answers one question: is this hardware request already satisfied
// by a spec in the catalogue? It is deliberately conservative - a wrong "yes" closes
// someone's request by pointing at a different product - but it was answering "no" to
// requests that were word-for-word satisfied, because it cut the title at the first
// bracket.
//
// "HUAWEI 4G Mobile WiFi 3 (E5785)" became "HUAWEI 4G Mobile WiFi 3", which does not
// match a model named "4G Mobile WiFi 3 (E5785)", and the E5783 next to it stopped being
// distinguishable at all. Measured against the live backlog: 0 of 250 requests matched
// before, 30 of 250 after. These checks hold the parsing that difference depends on.
const path = require('path');
const { requestSubject, requestCandidates, norm } = require(path.join(__dirname, '..', 'scripts', 'sweep-device-requests.js'));

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  <- ' + detail : '')); }
}

console.log('A model code in brackets is the model, not a note:');
ok(requestSubject('[Device]: HUAWEI 4G Mobile WiFi 3 (E5785)') === 'HUAWEI 4G Mobile WiFi 3 (E5785)',
  'the bracketed code survives',
  requestSubject('[Device]: HUAWEI 4G Mobile WiFi 3 (E5785)'));
ok(requestSubject('[Device]: HUAWEI 4G Mobile WiFi 3 (E5783)') === 'HUAWEI 4G Mobile WiFi 3 (E5783)',
  'and two requests differing only by that code stay distinct');
ok(norm(requestSubject('[Device]: HUAWEI 4G Mobile WiFi 3 (E5785)')) !==
   norm(requestSubject('[Device]: HUAWEI 4G Mobile WiFi 3 (E5783)')),
  'so they normalise to different keys — the whole point');
ok(norm(requestSubject('[Device]: HUAWEI 4G Mobile WiFi 3 (E5785)')) === 'huawei 4g mobile wifi 3 e5785',
  'the normalised key is the vendor, the line and the code');

console.log('\nThe description after the dash is still dropped:');
ok(requestSubject('[Device]: TP-Link TL-SG105E — 5-port gigabit Easy Smart switch') === 'TP-Link TL-SG105E',
  'an em dash ends the subject',
  requestSubject('[Device]: TP-Link TL-SG105E — 5-port gigabit Easy Smart switch'));
ok(requestSubject('[Device]: Aruba 2540 48G 4SFP+ Switch (JL355A) — rack switch') === 'Aruba 2540 48G 4SFP+ Switch (JL355A)',
  'a trailing bracket before the dash survives');
ok(requestSubject('[Device]: Pepwave MAX BR1 Pro: LTE failover') === 'Pepwave MAX BR1 Pro',
  'a colon ends the subject too');
ok(requestSubject('[Device]: plain model name') === 'plain model name',
  'a title with nothing to cut comes back whole');

console.log('\nThe bracket marker itself is stripped:');
ok(requestSubject('[Device]: MikroTik hEX Refresh Router (E50UG)') === 'MikroTik hEX Refresh Router (E50UG)',
  'the [Device] prefix is removed and the rest kept');
ok(requestSubject('[Hardware]: something') === 'something', 'a [Hardware] prefix is removed too');
ok(requestSubject('') === '', 'an empty title does not throw');

console.log('\nNormalisation keeps what distinguishes products:');
ok(norm('WiFi Mesh 3+') === 'wifi mesh 3 plus', 'a trailing + becomes the word plus');
ok(norm('WiFi Mesh 3') === 'wifi mesh 3', 'so 3+ and 3 do not collide');
ok(norm('S53UG+5HaxD2HaxD-TC&R11e-LTE7') === 's53ug plus 5haxd2haxd tc r11e lte7',
  'mixed punctuation collapses to separators',
  norm('S53UG+5HaxD2HaxD-TC&R11e-LTE7'));
ok(norm('  A   B  ') === 'a b', 'runs of whitespace collapse');
ok(norm(null) === '', 'null normalises to empty rather than throwing');

console.log('\nThe parenthetical is tried both ways, never dropped blindly:');
const src = require('fs').readFileSync(path.join(__dirname, '..', 'scripts', 'sweep-device-requests.js'), 'utf8');
ok(/for \(const candidate of subjects\)/.test(src),
  'the matcher loops over both forms of the subject');
ok(/function requestCandidates/.test(src) && /const subjects = requestCandidates\(rawSubject\)/.test(src),
  'the bracket-free form is built for the fallback, in one function main() calls');
ok(!/\\s\+\\\(/.test(src.split('\n').filter(function (l) { return /const cut = t\.search/.test(l); })[0] || ''),
  'and the subject is no longer cut at a bracket before matching');

if (failed) { console.error('\n' + failed + ' sweep-requests check(s) failed'); process.exit(1); }
console.log('\n' + passed + ' sweep-requests checks passed.');

// ---------------------------------------------------------------------------
// The other half of the same defect: the model code is in the parentheses, and
// the catalogue is keyed on the code. "Ubiquiti UniFi Switch Pro XG 24" is not
// a model name; "USW-Pro-XG-24" is. Until both forms were tried, a request whose
// device was modelled word-for-word still read as open - 189 Ubiquiti requests
// looked like work and were a backlog of answers nobody had sent.
// ---------------------------------------------------------------------------
const cands = requestCandidates(requestSubject('[Device]: Ubiquiti UniFi Switch Pro XG 24 (USW-Pro-XG-24)'));
ok(cands.indexOf('USW-Pro-XG-24') !== -1, 'the bracketed model code is tried as its own candidate', JSON.stringify(cands));
ok(cands.indexOf('Ubiquiti UniFi Switch Pro XG 24') !== -1, 'and the title with the parenthetical removed', JSON.stringify(cands));
ok(cands[0] === 'Ubiquiti UniFi Switch Pro XG 24 (USW-Pro-XG-24)', 'the subject as written is still tried first');
ok(requestCandidates('plain model name').length === 1, 'a subject with no brackets yields one candidate');
ok(requestCandidates('').length === 1, 'an empty subject does not throw or loop');
const two = requestCandidates('Vendor Thing (AAA-1, BBB-2)');
ok(two.indexOf('AAA-1') !== -1 && two.indexOf('BBB-2') !== -1, 'two codes in one bracket are both tried', JSON.stringify(two));
const dup = requestCandidates('X (X)');
ok(dup.filter(function (c) { return c === 'X'; }).length === 1, 'a code repeated as the whole title is not tried twice');

// The model code is not always in brackets and not always at the end. "Teltonika RUT241
// Industrial 4G LTE Wi-Fi Router" puts it in the middle, where the suffix search cannot
// reach it - and RUT241 is in the catalogue. 27 open requests were in that shape.
const mid = requestCandidates(requestSubject('[Device]: Teltonika RUT241 Industrial 4G LTE Wi-Fi Router'));
ok(mid.indexOf('RUT241') !== -1, 'a model code in the middle of the title is tried on its own', JSON.stringify(mid));
ok(requestCandidates('Vendor 5-Pack Thing').indexOf('5-Pack') !== -1, 'a token containing a digit is tried');
ok(requestCandidates('Vendor 48 Port Switch').indexOf('48') === -1, 'but a two-character number is not a model code');
ok(requestCandidates('Vendor plain words here').length === 1, 'titles with no digits add no token candidates');
const nodup = requestCandidates('RUT241 RUT241');
ok(nodup.filter(function (c) { return c === 'RUT241'; }).length === 1, 'a repeated code is only tried once');
