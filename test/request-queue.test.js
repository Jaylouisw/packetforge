'use strict';
// The hardware request queue is the project's front door: anyone can ask for a
// device, and the maintainer loop reads that queue. If the parsing is wrong, a
// complete request looks empty and a well-formed one gets told it is missing
// fields - so the parsing itself is tested.
const { field, slug, CATEGORY_MAP, blockerLine, BLOCKED_LABEL,
  requestOrigin, selectRequests, labelNote, REQUEST_LABEL } = require('../scripts/request-queue');

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

console.log('\nA request is its label OR its title, and the queue says which one matched:');
{
  ok(REQUEST_LABEL === 'device-request', 'the label name is the one the workflow applies');
  ok(requestOrigin(null) === null, 'a missing issue is not a request');
  ok(requestOrigin({}) === null, 'an issue with no title and no labels is not a request');

  ok(requestOrigin({ title: '[Device]: Acme PHANTOM-9000', labels: [] }) === 'title',
    '#2521: a real request whose label never landed is still a request');
  ok(requestOrigin({ title: 'Please add the Acme PHANTOM-9000',
    labels: ['device', 'device-request'] }) === 'label', 'the label alone is enough');
  ok(requestOrigin({ title: 'Please add the Acme PHANTOM-9000',
    labels: [{ name: 'device-request' }] }) === 'label',
    'a free-form title is a request when it carries the label (the tracker sends objects)');
  ok(requestOrigin({ title: '[Hardware]: Acme PHANTOM-9000', labels: [] }) === 'title',
    '[Hardware]: is the same request shape');
  ok(requestOrigin({ title: '  [device]: Acme PHANTOM-9000', labels: [] }) === 'title',
    'leading space and case do not hide a request');
  ok(requestOrigin({ title: 'bug: the [Device]: template is broken', labels: [] }) === null,
    'a bug report that mentions [Device]: is not a request');
  ok(requestOrigin({ title: 'Add the Acme PHANTOM-9000', labels: ['blocked-on-build'] }) === null,
    'carrying only blocked-on-build does not make something a request');
  ok(requestOrigin({ title: '[Device]: Acme X', labels: ['DEVICE-REQUEST'] }) === 'label',
    'label matching is case-insensitive');
}

console.log('\nSelection keeps every request and invents none:');
{
  const picked = selectRequests([
    { number: 1, title: '[Device]: Acme A', labels: ['device-request'] },
    { number: 2, title: '[Device]: Acme B', labels: ['device'] },
    { number: 3, title: 'server crashed on start', labels: ['bug'] },
    { number: 4, title: 'Please add Acme C', labels: ['device-request'] }
  ]);
  ok(picked.length === 3, 'three tracker rows are three requests, one of them title-only');
  ok(picked.map(function (p) { return p.issue.number; }).join(',') === '1,2,4', 'tracker order is kept');
  ok(picked[1].origin === 'title', 'the unlabelled one is marked as title-only');
  ok(picked[2].origin === 'label', 'the free-form one is marked as labelled');
  ok(selectRequests(null).length === 0, 'a missing list is empty, not a throw');
}

console.log('\nThe queue line asks for the missing label:');
{
  ok(labelNote({ origin: 'label' }) === '', 'a labelled request gets no note');
  ok(labelNote({ origin: 'title' }) === '  [no ' + REQUEST_LABEL + ' label]',
    'a title-only request says which label to apply');
  ok(labelNote({}) === '', 'an entry with no origin is not mislabelled');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
