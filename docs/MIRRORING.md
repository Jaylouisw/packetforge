# One workshop, one archive

**GitHub is the workshop.** Development, CI, review, releases and the issue tracker are all at
<https://github.com/jaylouisw/packetforge>. The self-hosted Forgejo instance at `git.jayw.uk` is a
**retained read-only archive**: it still answers, it still holds the history of the months the
project spent there, and nothing new is merged into it.

**The move happened on 2026-11-27.** `origin` is `https://github.com/jaylouisw/packetforge.git` and
`main` is the same commit on both hosts, so the archive is a faithful copy of the moment the move
happened — not of anything after it. Any commit pushed to the archive from now on is work that
GitHub will never see, which is exactly the class of mistake this page exists to prevent.

| Thing | Where it lives now | What the archive does |
|---|---|---|
| Commits, branches, tags | **GitHub** | Frozen at the move; read-only |
| Pull requests | **GitHub** | Read-only history of the PRs merged there |
| Issues and comments | **GitHub** | Read-only history; do not file or comment |
| CI / CD | **GitHub Actions** (`.github/workflows/`) | Its own `.forgejo/workflows/` are kept for provenance and are not a pipeline to trust |
| Releases | **GitHub** | — |
| Wiki | Regenerated from `docs/wiki/` and published from GitHub | — |

## The rule: one writer

Every failure mode in this area comes from symmetric sync. If both hosts can write `main`, then two
pushes race, the loser's history is orphaned, and neither host can be trusted about what "the code"
is. So:

- **GitHub writes.** All merges, all tags, all releases.
- **The archive is read.** It is a remote you may fetch and diff against, and never push to.
- **Nothing flows out of the archive.** A change made there is invisible to the project, so there is
  no mechanism — and no plan for one — that carries it back.

The reverse arrangement is what this repository used to run: Forgejo held the pen, a push mirror
copied every commit to GitHub, and `scripts/gh-bridge.js` carried GitHub pull requests back across.
That machinery existed because the forward direction had to be one-way. With the workshop on GitHub
the direction is the same as the tool everyone already has, so the bridge is not needed for the
normal path: a pull request on GitHub is reviewable where it was opened.

## 1. Git: one live remote, one dead one

```sh
git remote -v
# origin   https://github.com/jaylouisw/packetforge.git (fetch/push)   <- the only writer
# forgejo  ssh://forgejo/jaylouisw/packetforge.git     (read-only archive)
```

The `forgejo` remote is kept on the maintainer's clone as an archive: useful for reading an old
branch, a deleted PR's head, or a commit that predates the move. Treat it as a museum. If a `git
push` ever offers you `forgejo` as a destination, it is offering you the wrong one — `origin` is the
workshop and `push.default` is `simple`, so a bare `git push` cannot reach it by accident.

Verify the two agree about the move and nothing after it:

```sh
git ls-remote origin refs/heads/main
git ls-remote forgejo refs/heads/main     # equal, or the archive is simply older
```

**Never add a GitHub → Forgejo mirror.** A second live copy is a second answer to "what is the
code", and the one that syncs second wins. The archive has no mirror configuration and should not
gain one.

## 2. Pull requests: opened, reviewed and merged on GitHub

`gh pr create --base main --head <branch> --title "..." --body "Fixes #N"`, then review on the pull
request itself. CI is `.github/workflows/ci.yml`, and a red check is a red merge button.

The bridge (`scripts/gh-bridge.js`) is still in the tree because it was what carried contributions
in while the workshop was elsewhere. It speaks to the archive's API and it is not part of the merge
path any more: do not run it, and do not add a job that does.

## 3. Issues: one tracker

`gh issue list` is the queue; `gh issue view N --comments` is the record; `gh issue close N` is the
close. Label application, the `Fixes #N` convention and the two domain labels are in
`docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`.

The archive's issue numbers are not GitHub's. A link like `#1635` in a document written before
2026-11-27 means the archive's issue 1635, not the one that number now names on GitHub — which is
why the pre-move plans in `docs/plans/` are kept as written rather than re-pointed.

## 4. CI and CD: GitHub Actions only

`.github/workflows/ci.yml` is the pipeline: tests, syntax, examples, server smoke, the invariants.
Six workflows lived in `.github/workflows/` until 2026-11-08 and were deleted in #1059, when a
Forgejo runner read `.github/` as readily as GitHub's and ran them as a second, competing CI that
failed every time (CodeQL needs github.com; the docker job wanted a docker binary the image did not
have). The `.forgejo/workflows/` that replaced them are retained for provenance only: they are not
scheduled, and a red run there says nothing about this repository.

`docs/CI.md` is the map of what each check does and what a red one means.

## 5. What this repo enforces

- `scripts/canonical.ts` — the single definition of where the project lives. Change it there. It is
  TypeScript and every `.js` caller requires it as `require('./canonical.ts')`, extension and all,
  because CommonJS resolves `.js`, `.json` and `.node` and never a bare `.ts`.
- `scripts/check-canonical-urls.js` — fails the build if any tracked file points at the archive's
  repository, if a document hands a reader a lab-network address, if a page claims the archive is
  where the work happens, or if the README's clone URL and CI badge do not match the canonical base.
  The rule is inverted from what it used to be, not deleted: it caught GitHub URLs when GitHub was
  the mirror, and it catches Forgejo URLs now.
- `test/canonical-urls.test.js` — proves the checker can fail on a Forgejo URL *and* pass a GitHub
  one, so it is not a test that passes because it checks nothing.
- `scripts/forgejo-api.js` and the triage scripts — still speak to the archive when reading its old
  issue history. A missing token is reported as *"cannot look"* and exits 2, never as *"no open
  requests"*.

## If you only remember one thing

Clone from `https://github.com/jaylouisw/packetforge.git`, file at
<https://github.com/jaylouisw/packetforge/issues>, and read CI at
<https://github.com/jaylouisw/packetforge/actions>. `git.jayw.uk/jaylouisw/packetforge` is a
snapshot: correct on the day of the move, and wrong from the day after.
