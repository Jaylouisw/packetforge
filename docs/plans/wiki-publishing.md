# Plan: the wiki has two publishers, and the local one cannot tell whether anything changed

Status: forward plan, no code. Closes **no** open issue - the tracker does not describe this
defect (`#1507`, the 46 GB forge volume, shares only the general theme of bytes written twice).
Improves tooling that already exists. Steps 1-3, 5 and 6 repair an inconsistency; step 4 changes
what a documented command does and is marked **needs Jay's approval**.

Measured on `549b99ca`, 2026-11-17, on a Windows checkout with `core.autocrlf=true`.

## What exists today

- `scripts/build-wiki.js` (231 lines) writes `docs/wiki/*.md` from templates held inline in that
  file. Today its output is byte-identical to what is committed: running it leaves
  `git status docs/wiki` empty.
- `.forgejo/workflows/wiki-sync.yml` is the publisher of record: on a push to `main` touching
  `docs/wiki/**` it clones `<origin host>/<owner>/<repo>.wiki.git` with `git:${WIKI_TOKEN}@`
  (`:67`), lands on `main` explicitly (`:72-76`), deletes pages that no longer exist upstream
  (`:80-85`), copies `docs/wiki/*.md` (`:86`), exits quietly when nothing differs (`:89-92`), and
  otherwise commits `Sync from docs/wiki (<sha>)` and pushes `origin main` (`:94-97`).
- `scripts/publish-wiki.js` (106 lines) does the same job locally: clone to `os.tmpdir()`
  (`:53`), skip a page when `prev === next` (`:72`), delete removed pages, commit, push
  `origin HEAD` (`:102`). It never checks out a branch, injects no credential, and defaults
  `REPO` to `https://git.jayw.uk/jaylouisw/packetforge.wiki.git` (`:23`).
- `package.json:63-64` exposes `wiki:build` and `wiki:publish`. There is no check mode.
- The published wiki is, right now, correct: a fresh clone at `a3c21e5` (2026-11-17 02:35) holds
  six pages, each identical to `docs/wiki/` once the carriage returns are ignored.
- No human-readable document describes any of this. `grep -rn wiki` in `docs/MAINTAINING.md`,
  `CONTRIBUTING.md` and `README.md` finds vendor wiki tables and nothing about this pipeline; the
  only descriptions are the comment headers in the two scripts and the workflow.

## What is missing or weak, ranked

1. **The comparison is against a checkout, not against content.** Measured:
   `node scripts/publish-wiki.js --dry-run` on `549b99ca` prints all six pages as `updated`, every
   time. `.gitattributes` stores `*.md` as `eol=lf`, so `docs/wiki/*.md` reads LF from disk, but
   the clone created at `:53` inherits `core.autocrlf=true` and checks the same bytes out as CRLF
   (`Home.md` 32 CR, `_Sidebar.md` 12, `Contributing.md` 41). `prev === next` at `:72` is
   therefore never true here, and the `Wiki is already up to date` branch at `:84` is dead on this
   host. A real run would commit six whitespace-only page rewrites and call it a publish.
2. **No read-only answer to "is the wiki current?"** `--dry-run` shares the broken comparison, and
   there is no exit code, so the question cannot be asked by a script, a gate, or a maintainer
   without eyeballing `git log` in the wiki clone.
3. **Two publishers with different rules.** The workflow needs `WIKI_TOKEN` (`:42-51`), lands on
   `main`, and is triggered by the merge that reviewed the pages; the script pushes whatever `HEAD`
   the ambient credential helper allows, with a different commit message. The local path can put
   bytes into the wiki that no PR reviewed, and can race a sync.
4. **Generated pages are indistinguishable from hand-written ones.** Nothing on a page says
   `build-wiki.js` owns it, and running it silently discards hand edits. `docs/wiki/Home.md:18` is
   additionally written by `scripts/regen-registry-doc.js` - two generators on one page, kept in
   step only by both being run.
5. **None of this is tested.** `grep -rn publish-wiki test/` finds nothing, and no CI step runs
   either script, so a template change that drops or renames a page is caught by nobody.

## Steps

1. **Compare content, not the checkout** (S). Clone with
   `-c core.autocrlf=false -c core.eol=lf` and compare with a trailing `\r` stripped; factor the
   decision into an exported `diffPages()` and add `test/publish-wiki-compare.test.js` covering
   identical, CRLF-vs-LF, new, removed and both-at-once. Acceptance: `--dry-run` on clean `main`
   prints the up-to-date line.
2. **`--check`** (S). Same walk, read-only, exit 1 naming each page and whether it is `new`,
   `updated`, `removed` or only differs by line ending; add
   `"wiki:check": "node scripts/publish-wiki.js --check"` after `package.json:64`.
3. **Authenticate the way the rest of the tree does** (S). Read `FORGEJO_TOKEN`
   (`scripts/forgejo-api.js:27`) and rewrite the https URL the way the workflow does at `:65`, via a
   one-shot `credential.helper` rather than a token in the URL, so the token never appears in
   `ps` or an error message. Default the host to `git remote get-url origin` instead of the
   hardcoded public host at `:23`, and correct the "GitHub creates `<repo>.wiki.git`" wording at
   `:60`.
4. **One writer for the mirror** (**needs Jay's approval**, S). Either `wiki:publish` becomes an
   alias for `wiki:check` and pushing requires an explicit `--push`, or the script is deleted and
   the workflow is the only publisher. Both remove the unreviewed path; the choice is a product
   decision because `npm run wiki:publish` is documented as a command that publishes.
5. **Say the pages are generated, and gate it** (M). A `<!-- generated by scripts/build-wiki.js -->`
   first line in every page, plus a CI step running
   `node scripts/build-wiki.js && git diff --exit-code docs/wiki`. The banner and the regenerated
   pages must land in the same PR; the workflow edit belongs to the CI stream.
6. **Document the pipeline** (S). A `docs/MAINTAINING.md` section: pages are generated, the
   workflow mirrors them on merge, `wiki:check` asks whether the wiki is current, `WIKI_TOKEN` is
   what publishes, and `docs/wiki/*.md` is not editable by hand.

## Risks

- The pages are the public wiki. Step 5 changes all six at once and, merged alone, makes its own
  gate fail - the banner and the regenerated pages are one commit.
- Step 4 removes a path somebody may use today; the memory of that path is only in the script's
  header. Hence the approval flag rather than a silent deletion.
- A token in a clone URL leaks through `ps` and through git's error output on a shared host; the
  helper approach in step 3 is about that, not about convenience.
- Any merge touching `docs/wiki/` fires one extra `wiki-sync` commit. Expected, not a regression.

## Test strategy

- Unit: `diffPages()` over identical / CRLF-only / changed / new / removed fixtures, no network.
- Integration: a throwaway bare repository created under `os.tmpdir()` and passed through the
  existing `PF_WIKI_REPO` override, so `--check` can be driven end to end without cloning odin.
- Manual, quoted in the PR: `--dry-run` and `--check` against `http://odin:3000` on clean `main`
  both report current, and `--check` exits 1 against a wiki clone with one page edited.
- Gate: the CI step in step 5 fails when `docs/wiki` disagrees with the templates.

## Issues this closes

None. Nothing open describes this; the twelve open requests are hardware, and `#1507` is the forge
volume.
