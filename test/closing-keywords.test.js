'use strict';
// A body that says "does not close #130" closed #130.
//
// scripts/check-closing-keywords.js exists because the forge and this repository disagree about
// negation, and only one of them had to be right for a request to leave the queue. These tests pin
// the two things that make the checker useful rather than noisy: it reads real merged bodies the
// way the forge evidently read them, and it stays in step with parseClosingKeywords, which is the
// rule this repository uses to decide a close is intended.
const path = require('path');
const { scan, atRisk, stripMarkup } = require(path.join(__dirname, '..', 'scripts', 'check-closing-keywords.js'));
const { parseClosingKeywords } = require(path.join(__dirname, '..', 'scripts', 'close-merged-issues.js'));

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; }
  else { failed++; console.log('  not ok - ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

// The bodies that decided this script. Verbatim from the forge, minus the parts that do not
// mention a number.
const BODIES = {
  // Closed issue 803 at 2026-11-18T16:04:48Z, two seconds after the merge.
  pr2000: 'Refs #803 - does not close it.\n\n**Why it cannot close #803:** that same three-board assembly is priced at "2 Slot".',
  // Closed issue 130 at 2026-11-18T18:00:05Z, two seconds after the merge.
  pr2005: 'Related to #130, which found the same defect one layer up.\n\n**This PR does not close #130** - UDW-PRO still has no Ubiquiti source',
  // The identical shape, merged, that closed nothing.
  pr1867: 'Does **not** close #743 - the IOM census is still unpublished',
  // A reference with no keyword beside it: the safest of the three public shapes.
  pr1873: 'Refs #742 - this PR records measurements; it does **not** close the issue.',
  // A heading, not a claim.
  pr1873heading: '## What would close #742',
  // The claim that worked, and should still read as one.
  pr1635: 'Fixes #1526.\n\nCAPABILITIES advertised vlan, lacp and stp.'
};

console.log('a reference the sentence disclaims is still a reference');
{
  const hits = atRisk(BODIES.pr2005);
  ok(hits.length === 1 && hits[0].number === 130, 'the #2005 body is flagged', JSON.stringify(hits.map(h => h.number)));
  ok(hits[0] && hits[0].kind === 'negated', 'and flagged as negated', hits[0] && hits[0].kind);
  ok(hits[0] && /does not close #130/.test(hits[0].snippet), 'the snippet shows the words that did it', hits[0] && hits[0].snippet);

  const hits2000 = atRisk(BODIES.pr2000);
  ok(hits2000.length === 1 && hits2000[0].number === 803, 'the #2000 body is flagged', JSON.stringify(hits2000.map(h => h.number)));
  ok(hits2000[0] && hits2000[0].line === 3, 'and the line number is the one the sentence is on', hits2000[0] && String(hits2000[0].line));

  ok(atRisk(BODIES.pr1867).length === 1, 'emphasis does not hide the negation (**not** close)');
  ok(atRisk(BODIES.pr1867)[0].number === 743, 'and the number is 743');
}

console.log('');
console.log('a body that claims a close is a claim, not a risk');
{
  ok(atRisk(BODIES.pr1635).length === 0, '#1635 reads as a claim');
  const claims = scan(BODIES.pr1635);
  ok(claims.length === 1 && claims[0].number === 1526 && claims[0].kind === 'claim', 'one claim, #1526', JSON.stringify(claims));
  ok(atRisk('Fixes #12, closes #13 and #14').length === 0, 'a run of claims is all claims');
  const many = scan('Fixes #12, closes #13 and #14');
  ok(many.length === 3, 'and all three numbers are seen', String(many.length));
}

console.log('');
console.log('a number with no keyword beside it is not a reference at all');
{
  ok(scan(BODIES.pr1873).length === 0, '#1873 names no number after a keyword', JSON.stringify(scan(BODIES.pr1873)));
  const heading = scan(BODIES.pr1873heading);
  ok(heading.length === 1 && heading[0].kind === 'hypothetical', 'the heading "What would close #742" is a hypothetical, not a claim', heading[0] && heading[0].kind);
  ok(atRisk(BODIES.pr1873heading).length === 1, 'and it is still reported: the forge closed #130 on a shape no weaker than this one');
  ok(scan('see #12 for context').length === 0, 'a bare mention is silent');
}

console.log('');
console.log('the two parsers are held in step');
{
  // For every body above, "this repository would call it a claim" and "parseClosingKeywords
  // returns the number" have to agree - that is the whole claim this tool makes about itself.
  for (const name of Object.keys(BODIES)) {
    const text = BODIES[name];
    const flagged = scan(text).filter(r => r.kind === 'claim').map(r => r.number).sort();
    const parsed = parseClosingKeywords(text).slice().sort();
    ok(JSON.stringify(flagged) === JSON.stringify(parsed),
      name + ': the two agree on which numbers are claims', flagged + ' vs ' + parsed);
  }
}

console.log('');
console.log('a disclaimer that was hard-wrapped is still a disclaimer');
{
  // The two sentences that closed #803 and #130, wrapped at 80 columns - which is how the bodies
  // in this repository are written. Splitting the clause on the newline and keeping only the tail
  // handed NEGATION an empty string, so the wrap turned "does not close #130" into a claim: the
  // checker said "0 at risk" and parseClosingKeywords returned [130], i.e. the sweeper itself
  // would have closed the request. The wrap is not a sentence boundary.
  const one = 'This PR records the census and does not close #130: no source exists.';
  const wrapped = 'This PR records the census and does not\nclose #130: no source exists.';
  const wrappedCannot = 'It cannot\nresolve #130 until Ubiquiti publishes the census.';

  ok(atRisk(one).length === 1, 'one line: the disclaimer is reported (control)');
  const w = atRisk(wrapped);
  ok(w.length === 1 && w[0].number === 130, 'wrapped: still reported', JSON.stringify(w.map(h => h.number)));
  ok(w[0] && w[0].kind === 'negated', 'wrapped: negated, not a claim', w[0] && w[0].kind);
  ok(parseClosingKeywords(wrapped).indexOf(130) === -1, 'wrapped: the sweeper does not close #130', JSON.stringify(parseClosingKeywords(wrapped)));
  ok(parseClosingKeywords(wrappedCannot).indexOf(130) === -1, 'wrapped after "cannot": the sweeper does not close #130', JSON.stringify(parseClosingKeywords(wrappedCannot)));
  ok(atRisk(wrappedCannot).length === 1, 'wrapped after "cannot": still reported');
}

console.log('');
console.log('a claim that follows a wrap is still a claim');
{
  // The fix must not read every line-broken keyword as a disclaimer, or the sweeper stops
  // closing the requests that really were answered.
  ok(parseClosingKeywords('The census is complete.\nFixes #130').indexOf(130) !== -1, 'a claim on the line after a full stop still closes', JSON.stringify(parseClosingKeywords('The census is complete.\nFixes #130')));
  ok(atRisk('The census is complete.\nFixes #130').length === 0, 'and it is not reported as a risk');
  ok(JSON.stringify(parseClosingKeywords('Fixes #12\nFixes #13')) === '[12,13]', 'two claims on two lines are both claims', JSON.stringify(parseClosingKeywords('Fixes #12\nFixes #13')));
  ok(atRisk('Port 8 does not take power.\nFixes #130').length === 0, 'a negation in an earlier sentence does not taint the next claim');
}

console.log('');
console.log('what it says about a sentence it cannot classify');
{
  ok(stripMarkup('**This PR does not close #130**') === 'This PR does not close #130', 'emphasis is stripped before reading');
  const mid = scan('we also close #77 in passing, among other things');
  ok(mid.length === 1 && mid[0].kind === 'mid-sentence', 'a keyword inside a sentence is mid-sentence', mid[0] && mid[0].kind);
  ok(atRisk('we also close #77 in passing').length === 1, 'and it is reported, because a forge may not care where it sits');
  const hyp = scan('If it would close #9, the census is unpublished');
  ok(hyp.length === 1 && hyp[0].kind === 'hypothetical', 'a keyword about what would happen is hypothetical', hyp[0] && hyp[0].kind);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
