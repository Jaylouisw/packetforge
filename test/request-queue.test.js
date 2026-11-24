'use strict';
// The hardware request queue is the project's front door: anyone can ask for a
// device, and the maintainer loop reads that queue. If the parsing is wrong, a
// complete request looks empty and a well-formed one gets told it is missing
// fields - so the parsing itself is tested.
const { field, slug, CATEGORY_MAP, blockerLine, BLOCKED_LABEL, QUEUE_LABEL, isDeviceRequest } = require('../scripts/request-queue');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

// What GitHub actually renders for the issue form.
const FORM_BODY = [
  '### Vendor', '', 'MikroTik', '',
  '### Exact model name', '', 'CRS328-24P-4S+RM', '',
  '### Category', '', 'Switch (L2)', '',
  '### Ports and interfaces', '',
  '24x 1G RJ45 (PoE+ on all)', '4x 10G SFP+', '',
  '### PoE budget (watts)', '', '500', '',
  '### Datasheet or product page URL', '', 'https://mikrotik.com/product/crs328_24p_4s_rm', '',
  '### What do you want to model with it?', '', '_No response_', '',
  '### Capabilities', '', '_No response_', '',
  '### Before submitting', '',
  '- [X] I searched the catalog and existing issues, and this model is not there yet.',
  '- [X] The port list above comes from a datasheet, not from memory or another wiki.'
].join('\n');

console.log('Reading the issue form the way GitHub renders it:');
{
  ok(field(FORM_BODY, 'Vendor') === 'MikroTik', 'vendor');
  ok(field(FORM_BODY, 'Exact model name') === 'CRS328-24P-4S+RM', 'model');
  ok(field(FORM_BODY, 'Category') === 'Switch (L2)', 'category');
  ok(field(FORM_BODY, 'PoE budget \\(watts\\)') === '500', 'PoE budget');
  ok(/mikrotik\.com/.test(field(FORM_BODY, 'Datasheet or product page URL')), 'datasheet URL');
  ok(/24x 1G RJ45/.test(field(FORM_BODY, 'Ports and interfaces')),
    'a multi-line port list survives intact');
}

console.log('\nEmpty answers are empty, not the placeholder:');
{
  ok(field(FORM_BODY, 'What do you want to model with it\\?') === '',
    '"_No response_" is treated as blank');
  ok(field(FORM_BODY, 'Something that is not in the form') === '',
    'a missing field returns nothing instead of throwing');
  ok(field('', 'Vendor') === '', 'an empty body is safe');
  ok(field(null, 'Vendor') === '', 'a null body is safe');
}

console.log('\nA hand-filed issue without the form still parses:');
{
  const freeform = 'Please add the MikroTik CRS310.\n\nDatasheet: https://mikrotik.com/product/crs310_1g_4s_in\n';
  ok(field(freeform, 'Vendor') === '', 'no structured vendor field, so the caller falls back to the title');
}

console.log('\nCategory labels map to the catalog vocabulary:');
{
  ok(CATEGORY_MAP['switch (l2)'] === 'switch', 'Switch (L2) -> switch');
  ok(CATEGORY_MAP['olt (pon headend)'] === 'olt', 'OLT -> olt');
  ok(CATEGORY_MAP['cable modem (docsis)'] === 'modem', 'DOCSIS modem -> modem');
  ok(CATEGORY_MAP['phone / tablet'] === 'phone', 'phone -> phone');
  ok(CATEGORY_MAP['nvr / dvr'] === 'nvr', 'NVR -> nvr');
  ok(CATEGORY_MAP['iot / smart home'] === 'iot', 'IoT -> iot');
  const keys = Object.keys(CATEGORY_MAP);
  ok(keys.every(function (k) { return /^[a-z0-9 /()-]+$/.test(k); }),
    'every key is lowercase, matching how the form value is normalised');
}

console.log('\nFilenames are derived safely from user text:');
{
  ok(slug('MikroTik') === 'mikrotik', 'lowercases');
  ok(slug('CRS328-24P-4S+RM') === 'crs328-24p-4s-rm', 'strips the + out of a model name');
  ok(slug('PowerEdge R650 (2.5" chassis)') === 'poweredge-r650-2-5-chassis',
    'spaces and quotes collapse to single dashes');
  ok(slug('../../etc/passwd') === 'etc-passwd',
    'a path traversal attempt cannot escape the vendor directory');
  ok(slug('x'.repeat(200)).length <= 60, 'absurdly long names are truncated');
}

console.log('\nA blocked request quotes the thread, it does not summarise it:');
{
  ok(BLOCKED_LABEL === 'blocked-on-build', 'the label name is the one applied by hand');
  ok(blockerLine([]) === null, 'no comments means no quote, not an empty string');
  ok(blockerLine(null) === null, 'a failed read is safe');

  const thread = [
    { body: 'Opening status: **blocked on a stated configuration.**\n\nWhat would close it: a board.' },
    { body: '**Re-checked. Still blocked, on one named file.** PR #1893 records it.' }
  ];
  ok(/^Re-checked\. Still blocked, on one named file\./.test(blockerLine(thread)),
    'the newest comment that mentions the block is the one quoted');
  ok(/\*\*/.test(blockerLine(thread)) === false, 'markdown emphasis is stripped');

  const newerOffTopic = thread.concat([{ body: 'Merged in #1900, thanks!' }]);
  ok(/Still blocked/.test(blockerLine(newerOffTopic)),
    'a later comment that does not mention a block does not hide the verdict');

  ok(blockerLine([{ body: 'Can you add the 10G model as well?' }]) ===
    'Can you add the 10G model as well?',
    'with no verdict line, the newest comment is quoted rather than nothing');

  ok(blockerLine([{ body: '> **Blocked:** the vendor publishes slots, not ports.' }]) ===
    'Blocked: the vendor publishes slots, not ports.',
    'a quoted line loses its quote marker');

  ok(blockerLine([{ body: 'x'.repeat(500) }]).length === 220,
    'a long comment is capped, so one paragraph cannot flood the queue');
}

console.log('\nA request is the label or the title, because the label can be missing:');
{
  ok(QUEUE_LABEL === 'device-request', 'the canonical label is the one triage applies');
  ok(isDeviceRequest({ number: 1, title: '[Device]: TP-Link TL-SG1005P', labels: ['device-request'] }) === true,
    'the label alone is a request, whatever the title');
  ok(isDeviceRequest({ number: 2521, title: '[Device]: Aruba CX 8360 v2 family', labels: ['device'] }) === true,
    'a [Device]: title without the label is still a request (#2521)');
  ok(isDeviceRequest({ number: 2, title: '[hardware] MikroTik CRS310', labels: [] }) === true,
    'the [hardware] spelling counts too, as the server and the sweeper read it');
  ok(isDeviceRequest({ number: 3, title: 'crash: show ip route throws', labels: ['device-request'] }) === true,
    'a labelled issue is a request even when its title is a bug report');
  ok(isDeviceRequest({ number: 4, title: 'show ip route prints the wrong gateway', labels: ['bug'] }) === false,
    'a bug report that names a device is not a request');
  ok(isDeviceRequest({ number: 5, title: 'device: something', labels: [] }) === false,
    'the word alone is not the shape - only the bracketed prefix is');
  ok(isDeviceRequest({ number: 6, title: '[Device] no colon', labels: [] }) === true,
    'the colon is punctuation, not part of the shape');
  ok(isDeviceRequest({ number: 7, title: 'anything', labels: [{ name: 'device-request' }] }) === true,
    'labels in the raw API shape are read by name');
  ok(isDeviceRequest(null) === false && isDeviceRequest({}) === false,
    'a missing issue is not a request');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
