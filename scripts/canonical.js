'use strict';
/**
 * Where this project actually lives.
 *
 * Development is on Forgejo, not GitHub. Every URL that a reader might follow - clone
 * instructions, issue links, badges, the package metadata, the generated wiki - has to agree with
 * this file, because a stale one sends a contributor somewhere the work is not happening.
 *
 * `scripts/check-canonical-urls.js` enforces it, and `test/canonical-urls.test.js` proves the
 * checker can fail. Change the base here and run that test to find every place that needs to
 * follow.
 */

const OWNER = 'jaylouisw';
const NAME = 'packetforge';

// The public, canonical home.
const WEB = 'https://git.jayw.uk';

// NOTE: this instance currently sits behind Cloudflare Access, so an anonymous visitor is
// redirected to a login page. If that changes - or if the public face moves to another host -
// change WEB and OWNER here, then fix whatever the checker reports.
const BASE = WEB + '/' + OWNER + '/' + NAME;

// The URL forms that must never appear in a tracked file. CHANGELOG.md is exempt: it records what
// happened, and rewriting history to pretend the move never occurred would be a worse lie than a
// stale link in a changelog entry.
const FORBIDDEN = [
  /github\.com\/Jaylouisw\/packetforge/i,
  /github\.com\/jaylouisw\/packetforge/i
];

const EXEMPT_FILES = new Set(['CHANGELOG.md']);

/**
 * Files that may name the old location on purpose, each with the reason it must.
 *
 * The rule is not "github.com may never appear" - a document about the mirror has to be able to
 * name the mirror, and a test that proves the guard fails has to contain the string it plants. The
 * rule is "nothing may present GitHub as the place to clone from or contribute to". These two are
 * the exceptions, and each says why, so the next person can judge whether it still holds.
 */
const ALLOW = {
  'docs/MIRRORING.md': 'describes the push mirror, so it must name the mirror remote',
  'test/canonical-urls.test.js': 'plants a stale URL deliberately to prove the guard can fail'
};

module.exports = {
  OWNER: OWNER,
  NAME: NAME,
  WEB: WEB,
  BASE: BASE,
  FORBIDDEN: FORBIDDEN,
  EXEMPT_FILES: EXEMPT_FILES,
  ALLOW: ALLOW,

  repo: function (path) { return BASE + (path || ''); },
  clone: function () { return BASE + '.git'; },
  issue: function (template) {
    return BASE + '/issues/new' + (template ? '?template=' + template : '');
  },
  source: function (path, branch) {
    return BASE + '/src/branch/' + (branch || 'main') + '/' + path;
  },
  badge: function (workflow, label) {
    return BASE + '/badges/workflows/' + workflow + '/badge.svg' +
      (label ? '?label=' + encodeURIComponent(label) : '');
  }
};
