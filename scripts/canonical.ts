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
 *
 * This is `.ts`, and it is *required* by `.js` files (`require('./canonical.ts')` - the extension
 * is not optional; CommonJS resolves `.js`, `.json` and `.node`, never a bare `.ts`). So it is
 * also the proof that a typed helper can sit under untyped callers: the annotations below are
 * erased by the runtime at load time, and the `.js` callers keep their `require` and their
 * property access unchanged. Every export carries a type; `any` appears nowhere.
 */

/** The shape of the module, so a caller can be typed against it and a missing member is caught. */
export interface Canonical {
  readonly OWNER: string;
  readonly NAME: string;
  readonly WEB: string;
  readonly BASE: string;
  readonly FORBIDDEN: readonly RegExp[];
  readonly EXEMPT_FILES: ReadonlySet<string>;
  readonly ALLOW: Readonly<Record<string, string>>;
  repo(path?: string): string;
  clone(): string;
  issue(template?: string): string;
  source(path: string, branch?: string): string;
  badge(workflow: string, label?: string): string;
}

const OWNER: string = 'jaylouisw';
const NAME: string = 'packetforge';

// The public, canonical home.
const WEB: string = 'https://git.jayw.uk';

// NOTE: this instance currently sits behind Cloudflare Access, so an anonymous visitor is
// redirected to a login page. If that changes - or if the public face moves to another host -
// change WEB and OWNER here, then fix whatever the checker reports.
const BASE: string = WEB + '/' + OWNER + '/' + NAME;

// The URL forms that must never appear in a tracked file. CHANGELOG.md is exempt: it records what
// happened, and rewriting history to pretend the move never occurred would be a worse lie than a
// stale link in a changelog entry.
const FORBIDDEN: readonly RegExp[] = [
  /github\.com\/Jaylouisw\/packetforge/i,
  /github\.com\/jaylouisw\/packetforge/i
];

const EXEMPT_FILES: ReadonlySet<string> = new Set(['CHANGELOG.md']);

/**
 * Files that may name the old location on purpose, each with the reason it must.
 *
 * The rule is not "github.com may never appear" - a document about the mirror has to be able to
 * name the mirror, and a test that proves the guard fails has to contain the string it plants. The
 * rule is "nothing may present GitHub as the place to clone from or contribute to". These two are
 * the exceptions, and each says why, so the next person can judge whether it still holds.
 */
const ALLOW: Readonly<Record<string, string>> = {
  'docs/MIRRORING.md': 'describes the push mirror, so it must name the mirror remote',
  'test/canonical-urls.test.js': 'plants a stale URL deliberately to prove the guard can fail',
  'docs/PUBLIC-ACCESS.md': 'explains the public door, which means naming what sits behind it',
  'scripts/gh-bridge.js': 'is the GitHub client that carries contributions in; speaking to github.com is its entire job',
  'CONTRIBUTING.md': 'must tell contributors which door to knock on, which means naming the GitHub mirror'
};

const canonical: Canonical = {
  OWNER: OWNER,
  NAME: NAME,
  WEB: WEB,
  BASE: BASE,
  FORBIDDEN: FORBIDDEN,
  EXEMPT_FILES: EXEMPT_FILES,
  ALLOW: ALLOW,

  repo(path?: string): string { return BASE + (path || ''); },
  clone(): string { return BASE + '.git'; },
  issue(template?: string): string {
    return BASE + '/issues/new' + (template ? '?template=' + template : '');
  },
  source(path: string, branch?: string): string {
    return BASE + '/src/branch/' + (branch || 'main') + '/' + path;
  },
  badge(workflow: string, label?: string): string {
    return BASE + '/badges/workflows/' + workflow + '/badge.svg' +
      (label ? '?label=' + encodeURIComponent(label) : '');
  }
};

module.exports = canonical;
