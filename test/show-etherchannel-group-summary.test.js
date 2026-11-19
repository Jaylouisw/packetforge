'use strict';
// `show etherchannel <group> summary` was refused as though the number were a typo.
//
// A box accepts a channel-group number in front of the keyword - every command reference prints
// `show etherchannel 1 summary` - and the number narrows the table's rows. It does not narrow the two
// count lines above the table: a switch holding groups 1 and 2 answers `show etherchannel 2 summary` with
// `Number of channel-groups in use: 2` and one row.
//
// Evidence: research/show-etherchannel-group-summary.md - the Catalyst 2960-X 15.2(6)E / 9500 16.6 /
// 9200 26.x command references (grammar, and samples in the `show etherchannel 1 summary` form), the
// CCNP-style lab whose DLS1 holds two groups and whose ALS1 holds one, and a Catalyst 2960-S thread in
// the Proxmox forum with two groups. Both two-group captures show the counts at 2 over one row.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

// Two groups on one box: group 1 with two members, group 10 with one. No cables, so every member is (D) -
// the question here is which rows the table keeps, not whether a bundle came up.
function twoGroups() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw1');
  const s = new CliSession(sw, t, new Simulator(t));
  const ports = [...sw.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  s.run('configure terminal');
  for (const p of [ports[0].name, ports[1].name]) {
    s.run('interface ' + p);
    s.run('channel-group 1 mode active');
  }
  s.run('interface ' + ports[2].name);
  s.run('channel-group 10 mode on');
  s.run('end');
  return { s: s, cmd: function (c) { return ((s.run(c).output) || []).map(String); } };
}

// A table row: the line starts with the group number and a space.
function rows(lines) {
  return lines.filter(function (l) { return /^\d+ /.test(l); });
}

console.log('');
console.log('The number picks the row; the counts stay the device\'s:');
{
  const env = twoGroups();
  const all = env.cmd('show etherchannel summary');
  ok(rows(all).length === 2, 'the unfiltered view still prints both groups',
    JSON.stringify(rows(all)));
  ok(all[9] === 'Number of channel-groups in use: 2', 'the unfiltered count is two groups', all[9]);

  const one = env.cmd('show etherchannel 1 summary');
  ok(one.length === 9 + 2 + 1 + 1 + 4, 'the key, both counts, the header, the rule and one group\'s block',
    JSON.stringify(one));
  ok(one.slice(0, 9).join('\n') === all.slice(0, 9).join('\n'),
    'the nine-line key is the same one the unfiltered view prints');
  ok(one[9] === 'Number of channel-groups in use: 2',
    'the first count is the device\'s two groups, not the one row printed', one[9]);
  ok(one[10] === 'Number of aggregators:           2',
    'and the second count likewise', JSON.stringify(one[10]));
  ok(one[11] === 'Group  Port-channel  Protocol    Ports', 'the header is printed', one[11]);
  ok(one[12] === '------+-------------+-----------+-----------------------------------------------',
    'and the rule under it', one[12]);
  ok(rows(one).length === 1 && rows(one)[0].indexOf('1 ') === 0,
    'exactly one row, and it is group 1\'s', JSON.stringify(rows(one)));
  ok(one.join('\n').indexOf('Po10') === -1, 'group 10 is not in the answer to a question about group 1');
}

console.log('');
console.log('The other group is reachable by its own number:');
{
  const env = twoGroups();
  const ten = env.cmd('show etherchannel 10 summary');
  ok(rows(ten).length === 1 && rows(ten)[0].indexOf('10 ') === 0,
    'group 10 is the only row', JSON.stringify(rows(ten)));
  ok(rows(ten)[0].indexOf('Po10(') === 7, 'and it names Po10 in the Port-channel column', rows(ten)[0]);
  ok(ten[9] === 'Number of channel-groups in use: 2', 'the count is still the device\'s', ten[9]);
  ok(env.cmd('show etherchannel 1 summary').join('\n').indexOf('10 ') === -1,
    'the two filtered answers do not contain each other\'s row');
}

console.log('');
console.log('The number works with or without the keyword, and under both spellings of the view:');
{
  const env = twoGroups();
  const withKeyword = env.cmd('show etherchannel 1 summary');
  ok(env.cmd('show etherchannel 1').join('\n') === withKeyword.join('\n'),
    '`show etherchannel 1` answers with the same filtered table');
  ok(env.cmd('show port-channel 1 summary').join('\n') === withKeyword.join('\n'),
    'and so does the other spelling of the view');
  ok(env.cmd('show etherchannel 01 summary').join('\n') === withKeyword.join('\n'),
    'a leading zero is the same group number');
}

console.log('');
console.log('A number that names no group prints the view with nothing in it:');
{
  const env = twoGroups();
  const none = env.cmd('show etherchannel 3 summary');
  ok(none.length === 13, 'the key, both counts, the header and the rule - no rows',
    JSON.stringify(none));
  ok(none[9] === 'Number of channel-groups in use: 2' && none[10] === 'Number of aggregators:           2',
    'the counts still describe the box', JSON.stringify(none.slice(9, 11)));
  ok(none[11] === 'Group  Port-channel  Protocol    Ports' && /^-+\+/.test(none[12]),
    'the header and rule are printed under them');
  ok(none.every(function (l) { return l.indexOf('% ') !== 0; }), 'and nothing is reported as an error',
    JSON.stringify(none.slice(0, 2)));
}

console.log('');
console.log('A word the view cannot use is still refused, in the name that was typed:');
{
  const env = twoGroups();
  const bad = env.cmd('show etherchannel flurbish')[0];
  ok(/^% show etherchannel does not take "flurbish"/.test(bad), 'the word is quoted back', bad);
  ok(/name a group number to narrow it/.test(bad) && /show etherchannel 1 summary/.test(bad),
    'and the sentence says a number is what narrows the table', bad);
  const afterNumber = env.cmd('show etherchannel 1 flurbish')[0];
  ok(/does not take "flurbish"/.test(afterNumber), 'a word after the number is refused too', afterNumber);
  const alias = env.cmd('show port-channel flurbish')[0];
  ok(/^% show port-channel does not take "flurbish"/.test(alias) && /show port-channel 1 summary/.test(alias),
    'the alias refuses under its own spelling, and its example uses that spelling too', alias);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
