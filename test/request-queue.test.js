'use strict';
// The hardware request queue is the project's front door: anyone can ask for a
// device, and the maintainer loop reads that queue. If the parsing is wrong, a
// complete request looks empty and a well-formed one gets told it is missing
// fields - so the parsing itself is tested.
const { field, slug, CATEGORY_MAP } = require('../scripts/request-queue');

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

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
