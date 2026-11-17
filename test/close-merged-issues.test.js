'use strict';
// Jay's question was "why are the issues still open if the PR that addresses them is merged?"
// The answer is that Forgejo closes on a keyword in a merged pull request body and on nothing
// else - so a forgotten keyword leaves the issue open forever, and a `[Device]:` request whose
// device lands in a later, unrelated pull request is never cited by anything at all.
//
// `scripts/close-merged-issues.js` is the automation that answers it. These tests pin the three
// things that decide whether it helps or does damage: what counts as a closing claim, whether a
// device is really in the catalogue, and whether a second run can repeat itself or reopen
// something a human reopened on purpose.
const path = require('path');
const {
  parseClosingKeywords,
  prNumberFromSubject,
  buildDeviceIndex,
  loadDeviceIndex,
  deviceMatch,
  markerFor,
  deviceMarker,
  sweepKeywords,
  sweepDevices,
  keywordComment
} = require(path.join(__dirname, '..', 'scripts', 'close-merged-issues.js'));

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; }
  else { failed++; console.log('  not ok - ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

// ---------------------------------------------------------------------------------------------
// A tracker that records what was asked of it. No network, and `writes` is the whole point: the
// dry-run test asserts it stays empty.

function fakeTracker(spec) {
  const issues = spec.issues || {};
  const prs = spec.prs || {};
  const calls = [];
  return {
    calls: calls,
    issues: issues,
    writes: function () { return calls.filter(function (c) { return c[0] !== 'GET'; }); },
    get: async function (p) {
      calls.push(['GET', p]);
      let m = /^\/issues\/(\d+)\/comments$/.exec(p);
      if (m) {
        const issue = issues[m[1]];
        if (!issue) throw new Error('GET ' + p + ' -> HTTP 404');
        return issue.comments || [];
      }
      m = /^\/issues\/(\d+)$/.exec(p);
      if (m) {
        const issue = issues[m[1]];
        if (!issue) throw new Error('GET ' + p + ' -> HTTP 404');
        return issue;
      }
      m = /^\/pulls\/(\d+)$/.exec(p);
      if (m) {
        const pr = prs[m[1]];
        if (!pr) throw new Error('GET ' + p + ' -> HTTP 404');
        return pr;
      }
      if (p === '/issues/0') throw new Error('unreachable');
      throw new Error('GET ' + p + ' -> HTTP 404');
    },
    post: async function (p, body) {
      calls.push(['POST', p, body]);
      const m = /^\/issues\/(\d+)\/comments$/.exec(p);
      if (m) {
        const issue = issues[m[1]];
        if (!issue) throw new Error('POST ' + p + ' -> HTTP 404');
        issue.comments = issue.comments || [];
        issue.comments.push({ body: body.body, fake: true });
        return { id: issue.comments.length };
      }
      throw new Error('POST ' + p + ' -> HTTP 404');
    },
    patch: async function (p, body) {
      calls.push(['PATCH', p, body]);
      const m = /^\/issues\/(\d+)$/.exec(p);
      if (m) {
        const issue = issues[m[1]];
        if (!issue) throw new Error('PATCH ' + p + ' -> HTTP 404');
        issue.state = body.state;
        return issue;
      }
      throw new Error('PATCH ' + p + ' -> HTTP 404');
    }
  };
}

const SPECS = [
  { vendor: 'teltonika', model: 'RUTX12', file: 'devices/teltonika/rutx12.json', category: 'router' },
  { vendor: 'aruba', model: '2530-48 (J9781A)', file: 'devices/aruba/2530-48.json', category: 'switch' },
  { vendor: 'ubiquiti', model: 'U6-Pro', file: 'devices/ubiquiti/u6-pro.json', category: 'wireless' },
  { vendor: 'roku', model: 'U6-Pro', file: 'devices/roku/u6-pro.json', category: 'iot' },
  { vendor: 'ubiquiti', model: 'Ultra', file: 'devices/ubiquiti/ultra.json', category: 'router' },
  { vendor: 'huawei', model: 'OptiXtrans E6616', file: 'devices/huawei/optixtrans-e6616.json', category: 'switch' }
];
const INDEX = buildDeviceIndex(SPECS);

(async function () {
  console.log('');
  console.log('A closing claim is a keyword and a number, and barely anything else:');
  ok(JSON.stringify(parseClosingKeywords('Fixes #12')) === '[12]', 'Fixes #12');
  ok(JSON.stringify(parseClosingKeywords('fixes #12')) === '[12]', 'lower case counts');
  ok(JSON.stringify(parseClosingKeywords('Fixed: #3')) === '[3]', 'past tense and a colon');
  ok(JSON.stringify(parseClosingKeywords('Fixes #1526.')) === '[1526]', 'the body PR #1635 actually used, which closed #1526');
  ok(JSON.stringify(parseClosingKeywords('resolves #9')) === '[9]', 'resolves');
  ok(JSON.stringify(parseClosingKeywords('resolved #9')) === '[9]', 'resolved');
  ok(JSON.stringify(parseClosingKeywords('- Fixes #12')) === '[12]', 'a bullet in front is not part of the sentence');
  ok(JSON.stringify(parseClosingKeywords('Evidence first.\n\nFixes #1204')) === '[1204]',
    'the keyword on its own line, further down the body');
  ok(JSON.stringify(parseClosingKeywords('fixes #12, closes #13 and #14')) === '[12,13,14]',
    'one keyword can cite several issues');
  ok(JSON.stringify(parseClosingKeywords('Fixes #12. Also closes #99')) === '[12,99]', 'two claims in one body');
  ok(JSON.stringify(parseClosingKeywords('Fixes #12 and fixes #12')) === '[12]', 'the same issue once');

  console.log('');
  console.log('And a number that is only mentioned is not a claim - this is the bug the whole thing could cause:');
  ok(parseClosingKeywords('see #12 for context').length === 0, '"see #12" claims nothing');
  ok(parseClosingKeywords('related to #12, tracked there').length === 0, '"related to #12" claims nothing');
  ok(parseClosingKeywords('re #12: I can reproduce').length === 0, 'a quoted subject is not a claim');
  ok(parseClosingKeywords('fixes the #12 workflow').length === 0, 'a keyword with words before the number is not a claim');
  ok(parseClosingKeywords('This closes #4.').length === 0,
    'a keyword buried mid-sentence is not a claim - it goes on its own line or it does not count');
  ok(parseClosingKeywords('affixes #3').length === 0, '"affixes" is not "fixes"');
  ok(parseClosingKeywords('unfixed #3').length === 0, '"unfixed" is the opposite of a claim');
  ok(parseClosingKeywords('').length === 0, 'nothing at all');
  ok(parseClosingKeywords(null).length === 0, 'null body is not a claim');

  console.log('');
  console.log('The three real pull request bodies that would have caused a wrong close:');
  // Both are merged, both name a number next to a keyword, neither claims the issue is fixed,
  // and both issues are still open - which is what Forgejo decided when it merged them.
  ok(parseClosingKeywords('Does **not** close #743 - the IOM census is still unpublished, and no spec is written from research notes.').length === 0,
    'PR #1867 says it does not close #743, and it does not');
  ok(parseClosingKeywords('Refs #742 - this PR records measurements; it does **not** close the issue.').length === 0,
    'PR #1873 says it does not close #742, and it does not');
  ok(parseClosingKeywords('## What would close #742\n\nOne rendered section of the product description.').length === 0,
    'a heading asking what is still missing is not a claim either');
  ok(JSON.stringify(parseClosingKeywords('Fixes #12, does not close #13')) === '[12]',
    'and a negated second clause inside a real claim stays out of it');

  console.log('');
  console.log('The pull request behind a squash commit:');
  ok(prNumberFromSubject('lldp: the neighbour table ends with `N` (#1897)') === 1897, 'the trailing (#N) is the pull request');
  ok(prNumberFromSubject('docs: a thing (#12)\n\nCo-authored-by: x <y@z>') === 12, 'the first line only');
  ok(prNumberFromSubject('fix: no pull request number here') === null, 'no number, no pull request');
  ok(prNumberFromSubject('') === null, 'an empty message');

  console.log('');
  console.log('A device is present only when the catalogue says so:');
  const rutx = deviceMatch('[Device]: Teltonika RUTX12 Dual LTE 4G CAT6 Industrial Cellular Router', INDEX);
  ok(rutx && rutx.file === 'devices/teltonika/rutx12.json', 'an exact model name matches, with its file', rutx && rutx.file);
  const code = deviceMatch('[Device]: Aruba 2530-48 Switch (J9781A)', INDEX);
  ok(code && code.file === 'devices/aruba/2530-48.json', 'a bracketed part number matches the spec that stores it', code && code.file);
  ok(deviceMatch('[Device]: OptiXtrans E6616X', INDEX) === null,
    'a variant is a different product: E6616X is not the catalogues E6616');
  ok(deviceMatch('[Device]: Teltonika RUTX12 POE+', INDEX) === null, 'the PoE+ variant is not the plain unit');
  ok(deviceMatch('[Device]: Ubiquiti Iso-Beam-19 RF Isolator Shield for NanoBeam NBE-M5-19', INDEX) === null,
    'an accessory naming the device it clips onto is not a request for that device');
  ok(deviceMatch('[Device]: Some Unreleased Thing 9000', INDEX) === null, 'an unknown device matches nothing');
  ok(deviceMatch('[Device]: Ubiquiti U6-Pro', INDEX).vendor === 'ubiquiti',
    'two vendors with the same model name resolve by the vendor in the title');
  ok(deviceMatch('[Device]: Roku U6-Pro', INDEX).vendor === 'roku', 'and the other way round');
  ok(deviceMatch('[Device]: Ubiquiti Ultra', INDEX) === null,
    'a bare product-line word is not a product, even when the catalogue has an entry called that');
  ok(deviceMatch('[Device]: U6-Pro', INDEX) !== null,
    'a model code written on its own is enough - the code is the key, not the sentence around it');
  ok(deviceMatch('', INDEX) === null, 'an empty title matches nothing');

  console.log('');
  console.log('Keyword sweep, dry run - it decides, and writes nothing:');
  {
    const api = fakeTracker({ issues: { 42: { number: 42, title: 'a request', state: 'open', comments: [] } } });
    const res = await sweepKeywords({
      api: api, index: INDEX, dryRun: true,
      commits: [{ sha: 'abcdef1234567890', message: 'router: add the RUTX12 (#100)\n\nFixes #42' }],
      log: function () {}
    });
    ok(res.wouldClose.length === 1 && res.wouldClose[0].number === 42, 'it proposes #42', JSON.stringify(res.wouldClose));
    ok(api.writes().length === 0, 'dry run posted and patched nothing', JSON.stringify(api.writes()));
    ok(res.closed.length === 0, 'nothing is reported closed in a dry run');
  }

  console.log('');
  console.log('Keyword sweep, apply - the comment names the commit and the pull request:');
  {
    const issue = { number: 42, title: 'a request', state: 'open', comments: [] };
    const api = fakeTracker({
      issues: { 42: issue },
      prs: { 100: { number: 100, state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z', body: 'Adds the router.\n\nFixes #42' } }
    });
    const res = await sweepKeywords({
      api: api, index: INDEX, dryRun: false,
      commits: [{ sha: 'abcdef1234567890', message: 'router: add the RUTX12 (#100)' }],
      log: function () {}
    });
    ok(res.closed.length === 1 && res.closed[0].number === 42, 'the PR body keyword closed #42', JSON.stringify(res.closed));
    ok(issue.state === 'closed', 'the issue is closed through the API');
    const body = (issue.comments[0] || {}).body || '';
    ok(body.indexOf('abcdef1') !== -1, 'the comment names the commit SHA', body.slice(0, 80));
    ok(body.indexOf('#100') !== -1, 'the comment names the pull request');
    ok(body.indexOf(markerFor('abcdef1234567890')) !== -1, 'the comment carries the idempotency marker');
    ok(api.writes().length === 2, 'exactly one comment and one close', String(api.writes().length));
  }

  console.log('');
  console.log('A pull request that was not merged cannot close anything through its body:');
  {
    const issue = { number: 7, title: 'a request', state: 'open', comments: [] };
    const api = fakeTracker({
      issues: { 7: issue },
      prs: { 101: { number: 101, state: 'open', merged: false, body: 'Fixes #7' } }
    });
    const res = await sweepKeywords({
      api: api, index: INDEX, dryRun: false,
      commits: [{ sha: 'beef1234', message: 'wip: not merged yet (#101)' }],
      log: function () {}
    });
    ok(res.closed.length === 0 && api.writes().length === 0, 'an open pull request body claims nothing');
  }

  console.log('');
  console.log('Idempotency - a second run is silent:');
  {
    const issue = { number: 42, title: 'a request', state: 'closed', comments: [{ body: keywordComment('abcdef1234567890', 100, 'router: add the RUTX12 (#100)') }] };
    const api = fakeTracker({ issues: { 42: issue } });
    const res = await sweepKeywords({
      api: api, index: INDEX, dryRun: false,
      commits: [{ sha: 'abcdef1234567890', message: 'router: add the RUTX12 (#100)\n\nFixes #42' }],
      log: function () {}
    });
    ok(res.closed.length === 0, 'an already-closed issue is not closed again');
    ok(res.skipped.length === 1, 'it is reported as skipped', JSON.stringify(res.skipped));
    ok(api.writes().length === 0, 'and no comment is posted twice', JSON.stringify(api.writes()));
  }
  {
    // Closed by this commit once, reopened on purpose by a human. The comment marker is what
    // tells the two apart from "nobody ever closed this".
    const issue = { number: 42, title: 'a request', state: 'open', comments: [{ body: keywordComment('abcdef1234567890', 100, 'x') }] };
    const api = fakeTracker({ issues: { 42: issue } });
    const res = await sweepKeywords({
      api: api, index: INDEX, dryRun: false,
      commits: [{ sha: 'abcdef1234567890', message: 'router: add the RUTX12 (#100)\n\nFixes #42' }],
      log: function () {}
    });
    ok(api.writes().length === 0, 'a reopened issue is not re-closed and not commented again');
    ok(issue.state === 'open', 'it is left open, which is what reopening asked for');
    ok(res.skipped.length === 1, 'the skip is reported');
  }
  {
    const api = fakeTracker({ issues: { 5: { number: 5, title: 'a bug', state: 'open', comments: [] } } });
    const res = await sweepKeywords({
      api: api, index: INDEX, dryRun: false,
      commits: [{ sha: 'deadbeef', message: 'docs: mention #5 without claiming it\n\nsee #5 for context' }],
      log: function () {}
    });
    ok(res.considered === 0 && api.writes().length === 0, 'a commit that only mentions #5 closes nothing');
  }
  {
    const api = fakeTracker({ issues: { 8: { number: 8, title: 'a pull request in the issue number space', state: 'open', pull_request: { id: 1 }, comments: [] } } });
    const res = await sweepKeywords({
      api: api, index: INDEX, dryRun: false,
      commits: [{ sha: 'cafe1234', message: 'fix: something\n\nFixes #8' }],
      log: function () {}
    });
    ok(res.closed.length === 0 && api.writes().length === 0, 'a number that belongs to a pull request is never closed as an issue');
  }

  console.log('');
  console.log('Device sweep - one close, one comment, with the spec path:');
  {
    const open = { number: 130, title: '[Device]: Teltonika RUTX12 Dual LTE 4G CAT6', state: 'open', comments: [] };
    const noise = { number: 131, title: 'RUTX12 loses its LTE bearer after 24 h', state: 'open', comments: [] };
    const missing = { number: 132, title: '[Device]: OptiXtrans E6616X', state: 'open', comments: [] };
    const api = fakeTracker({ issues: { 130: open, 131: noise, 132: missing } });
    const dry = await sweepDevices({ api: api, index: INDEX, issues: [open, noise, missing], dryRun: true, log: function () {} });
    ok(dry.wouldClose.length === 1 && dry.wouldClose[0].number === 130, 'only the modelled request is proposed');
    ok(api.writes().length === 0, 'a dry run closes nothing');

    const applied = await sweepDevices({ api: api, index: INDEX, issues: [open, noise, missing], dryRun: false, log: function () {} });
    ok(applied.closed.length === 1 && applied.closed[0].number === 130, 'the request is closed');
    ok(open.comments[0].body.indexOf('devices/teltonika/rutx12.json') !== -1, 'the comment names the spec path');
    ok(open.comments[0].body.indexOf('teltonika RUTX12') !== -1, 'the comment names the model');
    ok(noise.state === 'open', 'a bug report that mentions the model but is not a [Device] request is untouched');
    ok(missing.state === 'open', 'the variant request stays open');

    const again = await sweepDevices({ api: api, index: INDEX, issues: [open], dryRun: false, log: function () {} });
    ok(again.closed.length === 0, 'a closed request is not closed again');
    ok((open.comments || []).length === 1, 'and the comment is not posted twice', String((open.comments || []).length));
  }
  {
    const reopened = { number: 140, title: '[Device]: Teltonika RUTX12', state: 'open', comments: [{ body: 'x\n\n<!-- ' + deviceMarker('teltonika', 'RUTX12') + ' -->' }] };
    const api = fakeTracker({ issues: { 140: reopened } });
    await sweepDevices({ api: api, index: INDEX, issues: [reopened], dryRun: false, log: function () {} });
    ok(api.writes().length === 0, 'a device request a human reopened is not re-closed');
    ok(reopened.state === 'open', 'and stays open');
  }

  console.log('');
  console.log('Against the real catalogue - the queue Jay is looking at:');
  try {
    const index = loadDeviceIndex();
    const queue = [
      [810, '[Device]: OptiXtrans E9624'],
      [808, '[Device]: OptiXtrans E9612'],
      [807, '[Device]: OptiXtrans E9605'],
      [803, '[Device]: OptiXtrans E6616X'],
      [743, '[Device]: Huawei OceanProtect X8100/X9100 Backup Storage'],
      [742, '[Device]: Huawei OceanProtect E8000 Backup Storage'],
      [130, '[Device]: Ubiquiti UniFi Dream Wall Pro (UDW-PRO)']
    ];
    const proposed = queue.filter(function (q) { return deviceMatch(q[1], index); });
    ok(proposed.length === 0,
      'none of the seven open requests is in the catalogue, so none is closed by this workflow',
      proposed.map(function (p) { return '#' + p[0]; }).join(', '));
    // A near miss is a miss, and this is the near miss: E6616 is modelled, E6616X is not.
    ok(deviceMatch('[Device]: OptiXtrans E6616', index) !== null, 'while E6616 itself is modelled');
    ok(deviceMatch('[Device]: OptiXtrans E6616', index).file === 'devices/huawei/optixtrans-e6616.json',
      'and matching it names the file', deviceMatch('[Device]: OptiXtrans E6616', index).file);
    // The positive case has to work against the real catalogue too, or a green pump is not one.
    const real = deviceMatch('[Device]: Teltonika RUTX12 Dual LTE 4G CAT6 Industrial Cellular Router', index);
    ok(real && real.file === 'devices/teltonika/rutx12.json',
      'a request the catalogue does answer resolves to its spec file', real && real.file);
  } catch (e) {
    ok(false, 'the real catalogue loads', e.message);
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})().catch(function (e) {
  console.error(e && e.stack || e);
  process.exitCode = 1;
});
