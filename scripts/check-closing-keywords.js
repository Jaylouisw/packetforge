#!/usr/bin/env node
'use strict';
// "Does not close #N" closes #N.
//
// Measured three times, twice on 2026-11-18 and once on 2026-11-20, on this forge, in this
// repository:
//
//   * pull request #2000, body "Refs #803 - does not close it" and, further down,
//     "Why it cannot close #803:"  ->  issue 803 went to closed at 16:04:48Z, two seconds after
//     the merge, with no comment posted on it;
//   * pull request #2005, body "This PR does not close #130 - UDW-PRO still has no Ubiquiti
//     source"  ->  issue 130 went to closed at 18:00:05Z, also with no comment;
//   * pull request #2301, body "Does not close #130 or #803 - the two open device requests are
//     blocked on their vendors"  ->  issue 130 went to closed at 19:08:37Z, three seconds after
//     the merge, again with no comment. Issue 803 stayed open: the run does not treat "or" as a
//     separator, so the keyword bound to the first number and the second reference was ignored.
//
// None of the three closes was scripts/close-merged-issues.js: that script posts a comment before
// it changes state, and its marker was never written. All three were the forge reading a keyword
// next to a number in a merged body - the same mechanism that legitimately closed #1526 from
// #1635 - and all three had to be reopened by hand. The damage is not the minute of work: a
// reopened request has lost its place in the queue, and a reader who trusts state open learns not
// to.
//
// The same shape sat untouched in #1867 and #1873 ("Does not close #743", "it does not close the
// issue"), which is why docs/CI.md used to say the two parsers agree. They do not always agree,
// and nobody here knows the forge rule - so stop relying on it. Write a body that cannot be
// misread: put the reference beside "Refs" with no closing keyword in the sentence, or write
// "issue N" with no hash at all, which is not a reference to anything.
//
// This is the check you run before pushing, not a gate: it reports the references in a body that
// the forge could read as a close while this repository own sweep would not, which is exactly the
// set that closes by accident.
//
//   node scripts/check-closing-keywords.js --text "Refs #1 - does not close #2"
//   node scripts/check-closing-keywords.js --file body.md
//   git log -1 --format=%B | node scripts/check-closing-keywords.js --file -
//   node scripts/check-closing-keywords.js --pr 2005           # body + commit messages
//   node scripts/check-closing-keywords.js --pr 2005 --strict  # exit 1 on an at-risk reference
//
// Exit status is 0 unless --strict is given and something is at risk, so this cannot turn a
// careful sentence into a red build by being run somewhere nobody expected.

const fs = require('fs');
const path = require('path');

// A keyword and a reference with nothing meaningful between them. The colon and comma are here
// because "closes: #12" is how a changelog line reads; an intervening word ("close the issue, see
// #12") is not a reference and is deliberately not matched.
const RISK = /\b(fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\b[ \t]*[:,]?[ \t]*#(\d+)/gi;

// Where a claim may start, and what makes one negated - the rules scripts/close-merged-issues.js
// applies, restated rather than imported so this script can say "the forge might, this repository
// would not" without making a decision about closing. test/closing-keywords.test.js holds the two
// in step by running both over the real bodies quoted in docs/CI.md.
// The rest of a run: "Fixes #12, closes #13 and #14" is one claim citing three issues, and a
// forge reads the run, not only its first member.
const RUN = /^ *(?:[,;&/]|and|also|then) *(?:(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved) *[:,]? *)?#([0-9]+)/i;

const CLAIM_START = /(?:^|\n|[.!?:;])[ \t"'(]*(?:(?:also|additionally|furthermore|then|finally)\b[ \t]+)?$/i;
const NEGATION = /(?:n't|\bnot|\bnever|\bcannot|\bno\s+longer)\s*$/i;

function stripMarkup(s) {
  return String(s == null ? '' : s)
    .replace(/[*_`~]+/g, '')
    .replace(/^[ \t]*(?:[-+>]|\d+[.)])[ \t]+/gm, '');
}

function lineNumberAt(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

function snippet(text, index, length) {
  const start = Math.max(0, index - 46);
  const end = Math.min(text.length, index + length + 34);
  return (start > 0 ? '...' : '') +
    text.slice(start, end).replace(/\s+/g, ' ').trim() +
    (end < text.length ? '...' : '');
}

/**
 * Every keyword-plus-number in the text, with the reason it sits where it does.
 *
 * kind is "claim" when this repository own rules would treat the words as a closing claim - the
 * reference is meant to close - and "negated", "mid-sentence" or "hypothetical" when they would
 * not. Everything in the second group is the failure this script exists for: the sentence says it
 * does not close the issue, and a parser that reads the words without the sentence closes it.
 */
// A sentence about what would happen is not a claim whether or not it sounds like one - "what
// would close this" and "if the board table existed, this fixes it" are the two shapes that keep
// appearing in this repository's request threads.
const HEDGES = [' if ', ' when ', ' would ', ' could ', ' should ', ' suppose ', ' assume ', ' unless '];
function hedged(clause) {
  const c = ' ' + String(clause == null ? '' : clause).toLowerCase() + ' ';
  for (const h of HEDGES) if (c.indexOf(h) !== -1) return true;
  return false;
}

// The words before a keyword, read back to the last sentence boundary. A line break IS a boundary
// for CLAIM_START - a claim really can open a line - but it is not one for NEGATION: a body hard
// wrapped at 80 columns puts "does not" and "close #130" on different lines, and reading only the
// text after the break hands NEGATION an empty string, which turns a disclaimer into a claim. So
// when the text immediately before the keyword carries no word of its own, the clause continues on
// the line above. Measured on the shape that closed #803 and #130, wrapped at 79 columns.
function clauseBefore(text, index) {
  const segs = String(text).slice(Math.max(0, index - 40), index).split(/[.!?:;\n]/);
  let clause = segs.pop();
  while (!/[A-Za-z0-9]/.test(clause) && segs.length) clause = segs.pop() + ' ' + clause;
  return clause;
}

function scan(text) {
  const s = stripMarkup(text);
  const out = [];
  RISK.lastIndex = 0;
  let scannedTo = 0;
  let m;
  while ((m = RISK.exec(s)) !== null) {
    if (m.index < scannedTo) continue;    // already part of the run before it
    const before = s.slice(0, m.index);
    const clause = clauseBefore(s, m.index);
    let kind = 'claim';
    let why = '';
    if (NEGATION.test(clause)) {
      kind = 'negated';
      why = 'a keyword after not/never/cannot';
    } else if (!CLAIM_START.test(before)) {
      kind = 'mid-sentence';
      why = 'a keyword that does not open a line or a sentence';
    } else if (/\b(?:if|when|would|could|should|suppose|assume)\b[^.\n]*$/i.test(clause)) {
      kind = 'hypothetical';
      why = 'a keyword in a sentence about what would happen';
    }
    if (kind === 'mid-sentence' && hedged(clause)) {
      kind = 'hypothetical';
      why = 'a keyword in a sentence about what would happen';
    }
    out.push({
      number: Number(m[2]),
      keyword: m[1].toLowerCase(),
      kind: kind,
      why: why,
      line: lineNumberAt(s, m.index),
      snippet: snippet(s, m.index, m[0].length)
    });
    let rest = s.slice(m.index + m[0].length);
    let at = m.index + m[0].length;
    let step;
    while ((step = RUN.exec(rest)) !== null) {
      out.push({
        number: Number(step[1]),
        keyword: '',
        kind: kind,
        why: why,
        line: lineNumberAt(s, at),
        snippet: snippet(s, at, step[0].length)
      });
      at += step[0].length;
      rest = rest.slice(step[0].length);
    }
    scannedTo = at;
  }
  return out;
}

/** The references the forge could read as a close that this repository would not. */
function atRisk(text) {
  return scan(text).filter(function (r) { return r.kind !== 'claim'; });
}

// ---------------------------------------------------------------------------------------------
// Reading the thing that is about to be merged.

function apiBase() {
  if (process.env.FORGEJO_URL) {
    return String(process.env.FORGEJO_URL).replace(/\/+$/, '').replace(/\/api\/v1$/, '') + '/api/v1';
  }
  return 'http://odin:3000/api/v1';
}

async function forgeGet(pathname) {
  const headers = { 'Accept': 'application/json' };
  const tok = process.env.FORGEJO_TOKEN || process.env.TOKEN;
  if (tok) headers['Authorization'] = 'token ' + tok;
  const res = await fetch(apiBase() + pathname, { headers: headers });
  if (!res.ok) throw new Error('GET ' + pathname + ' -> HTTP ' + res.status);
  return res.json();
}

// A merged pull request is read the way the forge reads it: the body, and the messages of the
// commits it brought. A squash subject carries no keyword anywhere in this repository, but a body
// is not the only place a sentence gets written.
async function readPullRequest(number, repo) {
  const r = repo || process.env.FORGEJO_REPO || 'jaylouisw/packetforge';
  const pr = await forgeGet('/repos/' + r + '/pulls/' + number);
  let commits = [];
  try {
    commits = await forgeGet('/repos/' + r + '/pulls/' + number + '/commits?limit=50');
  } catch (e) {
    commits = [];
  }
  return {
    label: 'pull request #' + number + ' (' + (pr.title || '') + ')',
    parts: [{ where: 'body', text: pr.body || '' }].concat(
      (commits || []).map(function (c) {
        return { where: 'commit ' + String(c.sha || '').slice(0, 8), text: (c.commit && c.commit.message) || '' };
      })
    )
  };
}

function report(result) {
  const refs = [];
  for (const part of result.parts) {
    for (const hit of scan(part.text)) refs.push(Object.assign({ where: part.where }, hit));
  }
  const risky = refs.filter(function (r) { return r.kind !== 'claim'; });
  console.log('check-closing-keywords: ' + result.label);
  if (!refs.length) {
    console.log('  no keyword sits next to a number - nothing here can be read as a close');
  } else {
    for (const r of refs) {
      const verdict = r.kind === 'claim' ? 'claim' : 'AT RISK (' + r.kind + ')';
      console.log('  ' + r.where + ':' + r.line + '  #' + r.number + '  ' + verdict);
      if (r.kind !== 'claim') console.log('      ' + r.why + ' - the forge may still close it');
      console.log('      ' + r.snippet);
    }
  }
  console.log('  ' + refs.length + ' reference(s), ' + risky.length + ' at risk');
  if (risky.length) {
    console.log('  rewrite an at-risk one as "Refs #" plus the number (no closing keyword in the');
    console.log('  sentence), or as "issue N" with no hash (no reference at all).');
  }
  return risky;
}

async function main() {
  const argv = process.argv.slice(2);
  const value = function (flag) {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    return argv[i + 1] == null ? '' : argv[i + 1];
  };
  const strict = argv.includes('--strict');
  const pr = value('--pr');
  const file = value('--file');
  const text = value('--text');

  let result;
  try {
    if (pr) {
      result = await readPullRequest(pr, value('--repo'));
    } else if (file) {
      const body = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(file), 'utf8');
      const label = file === '-' ? 'stdin' : file;
      result = { label: label, parts: [{ where: label, text: body }] };
    } else if (text != null) {
      result = { label: '--text', parts: [{ where: '--text', text: text }] };
    } else {
      console.error('usage: check-closing-keywords.js (--pr N | --file F | --text S) [--strict] [--repo owner/name]');
      process.exit(2);
    }
  } catch (e) {
    console.error('check-closing-keywords: cannot read the text - ' + e.message);
    process.exit(2);
  }

  const risky = report(result);
  if (strict && risky.length) process.exit(1);
}

module.exports = { scan: scan, atRisk: atRisk, stripMarkup: stripMarkup };

if (require.main === module) {
  main().catch(function (e) {
    console.error('check-closing-keywords failed: ' + e.message);
    process.exit(2);
  });
}
