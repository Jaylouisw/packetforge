'use strict';
/**
 * Where this project actually lives.
 *
 * Development, CI and the issue tracker are on **GitHub**, at BASE below. Every URL that a reader
 * might follow - clone instructions, issue links, badges, the package metadata, the generated wiki -
 * has to agree with this file, because a stale one sends a contributor somewhere the work is not
 * happening.
 *
 * The project has moved twice and both times the links took months to follow. Until 2026-11-08 it
 * lived on GitHub; from then it ran on a self-hosted Forgejo instance (`git.jayw.uk`), and on
 * 2026-11-27 it moved back. The Forgejo instance is a **retained read-only archive**: it still
 * answers, nothing new is merged there. The guard below is inverted rather than deleted, because
 * the failure it catches was never "GitHub is bad" - it is "a document sends a reader to where the
 * work is not".
 *
 * `scripts/check-canonical-urls.js` enforces it, and `test/canonical-urls.test.js` proves the
 * checker can fail in both directions. Change the base here and run that test to find every place
 * that needs to follow.
 *
 * This is `.ts`, and it is *required* by `.js` files (`require('./canonical.ts')` - the extension
 * is not optional; CommonJS resolves `.js`, `.json` and `.node`, never a bare `.ts`). So it is
 * also the proof that a typed helper can sit under untyped callers: the annotations below are
 * erased by the runtime at load time, and the `.js` callers keep their `require` and their
 * property access unchanged. Every export carries a type; `any` appears nowhere.
 */

/** The retired forge, kept as an archive. */
export interface Archive {
  readonly web: string;
  readonly base: string;
  readonly internal: string;
}

/** The shape of the module, so a caller can be typed against it and a missing member is caught. */
export interface Canonical {
  readonly OWNER: string;
  readonly NAME: string;
  readonly WEB: string;
  readonly BASE: string;
  readonly ARCHIVE: Archive;
  readonly FORBIDDEN: readonly RegExp[];
  readonly FORBIDDEN_IN_DOCS: readonly RegExp[];
  readonly FORGE_CLAIMS: readonly RegExp[];
  readonly EXEMPT_FILES: ReadonlySet<string>;
  readonly EXEMPT_PREFIXES: readonly string[];
  readonly ALLOW: Readonly<Record<string, string>>;
  repo(path?: string): string;
  clone(): string;
  issue(template?: string): string;
  source(path: string, branch?: string): string;
  badge(workflow: string, label?: string): string;
  actions(workflow?: string): string;
}

const OWNER: string = 'jaylouisw';
const NAME: string = 'packetforge';

// The public, canonical home: the workshop.
const WEB: string = 'https://github.com';

const BASE: string = WEB + '/' + OWNER + '/' + NAME;

/**
 * The retired forge, kept as a read-only archive.
 *
 * Defined here so the two or three documents that have to talk about it - the migration note, the
 * instance's own runbook, the public-access page - can do so from a definition rather than from a
 * literal. Nothing a contributor is told to clone, file an issue on, or read CI from may use these.
 */
const ARCHIVE: Archive = {
  web: 'https://git.jayw.uk',
  base: 'https://git.jayw.uk/' + OWNER + '/' + NAME,
  // The lab-network name for the same instance, and the base of its API.
  internal: 'http://odin:3000'
};

/**
 * The URL forms that must never appear in a tracked file, because they send a reader to the archive
 * as though it were the workshop.
 *
 * Scoped to the repository path rather than to the bare host on purpose: a document *about* the
 * archive has to be able to name the host, while `/jaylouisw/packetforge` on that host is never the
 * right place to send anyone. The internal API name is forbidden outright - it is not reachable by
 * a reader and does not answer to a stranger at all.
 *
 * CHANGELOG.md and `docs/plans/` are exempt: they record what happened, and rewriting history to
 * pretend the moves never occurred would be a worse lie than a stale link in a changelog entry.
 */
const FORBIDDEN: readonly RegExp[] = [
  /git\.jayw\.uk\/jaylouisw\/packetforge/i
];

/**
 * The same idea, for the address only the lab network can resolve.
 *
 * Kept in a second list because it is scoped to documents rather than to every file: a *script*
 * may legitimately address the internal API (the archive's own client and the triage tools do),
 * but a page a reader is meant to follow may not hand them `odin:3000`, which resolves to nothing
 * outside one LAN. A doc that needs to name it has an entry in ALLOW and a reason.
 */
const FORBIDDEN_IN_DOCS: readonly RegExp[] = [
  /odin:3000/i
];

/**
 * Sentences that make the archive the place work happens.
 *
 * A URL check cannot tell "moved back on 2026-11-27" from "we develop on Forgejo", and the second
 * sentence costs a contributor more than a dead link: it is a working link to the wrong workshop.
 * Each pattern is narrow on purpose, so a document that describes the archive in the past tense and
 * dates the move does not trip it.
 */
const FORGE_CLAIMS: readonly RegExp[] = [
  /\b(project|development|work|ci|everything|releases?)\b[^.]{0,40}\b(live|lives|run|runs|is developed|are developed|is hosted|are hosted|remains|stays|happen|happens)\b[^.]{0,40}\bforgejo\b/i,
  /\bforgejo\s+(is|remains|stays)\s+(the\s+)?(canonical|source of truth|workshop|tracker|home)\b/i
];

// Whole files that are historical records. Exact names.
const EXEMPT_FILES: ReadonlySet<string> = new Set(['CHANGELOG.md']);

// Prefixes that are historical records. A past fact stays a past fact: `docs/plans/` holds the
// reasoning written while the project was on Forgejo, and it is evidence about decisions, not
// instructions to a contributor.
const EXEMPT_PREFIXES: readonly string[] = ['docs/plans/'];

/**
 * Files that may name the archive on purpose, each with the reason it must.
 *
 * The rule is not "Forgejo may never appear" - the migration note has to say where the project came
 * from, and a test that proves the guard fails has to contain the string it plants. The rule is
 * "nothing may present the archive as the place to clone from, file an issue on, or read CI from".
 * Each entry says why, so the next person can judge whether it still holds.
 */
const ALLOW: Readonly<Record<string, string>> = {
  'docs/MIRRORING.md': 'records the move and the retained archive, so it must name the archive and its URLs',
  'docs/PUBLIC-ACCESS.md': 'documents the archive instance\'s Cloudflare Access front door, which means naming that host',
  'docs/FORGE_TROUBLESHOOTING.md': 'is the runbook for the archive instance when it wedges; every probe in it is a URL on that host',
  'test/canonical-urls.test.js': 'plants a stale archive URL deliberately to prove the guard can fail',
  'AGENTS.md': 'is a protected agent-instruction file that the documentation lanes may not edit, so it still names the archive API until a human moves it'
};

const canonical: Canonical = {
  OWNER: OWNER,
  NAME: NAME,
  WEB: WEB,
  BASE: BASE,
  ARCHIVE: ARCHIVE,
  FORBIDDEN: FORBIDDEN,
  FORBIDDEN_IN_DOCS: FORBIDDEN_IN_DOCS,
  FORGE_CLAIMS: FORGE_CLAIMS,
  EXEMPT_FILES: EXEMPT_FILES,
  EXEMPT_PREFIXES: EXEMPT_PREFIXES,
  ALLOW: ALLOW,

  repo(path?: string): string { return BASE + (path || ''); },
  clone(): string { return BASE + '.git'; },
  issue(template?: string): string {
    return BASE + '/issues/new' + (template ? '?template=' + template : '');
  },
  // GitHub's form: /blob/<branch>/<path>. The archive used /src/branch/<branch>/<path>.
  source(path: string, branch?: string): string {
    return BASE + '/blob/' + (branch || 'main') + '/' + path;
  },
  // GitHub's form: /actions/workflows/<file>/badge.svg. The archive used /badges/.
  badge(workflow: string, label?: string): string {
    return BASE + '/actions/workflows/' + workflow + '/badge.svg' +
      (label ? '?label=' + encodeURIComponent(label) : '');
  },
  // Where a reader goes to watch that workflow run.
  actions(workflow?: string): string {
    return BASE + '/actions' + (workflow ? '/workflows/' + workflow : '');
  }
};

module.exports = canonical;
