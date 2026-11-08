# Forgejo and GitHub: one source of truth, two front doors

Development, CI and CD live on **Forgejo**. GitHub is kept as a mirror so that people who already
have a GitHub account can read the code, clone it, and contribute without first creating an account
somewhere unfamiliar. This document describes what can be synchronised, what cannot, and the rule
that keeps the two from fighting.

The short version:

| Thing | Syncable? | How |
|---|---|---|
| Commits, branches, tags | **Yes, fully, one way** | Forgejo → GitHub push mirror |
| Pull requests | **No — bridge instead** | A job mirrors GitHub PR heads into Forgejo PRs |
| Issues and comments | **No — pick one tracker** | Forgejo is the tracker; GitHub issues point at it |
| CI / CD | **Forgejo only, authoritative** | GitHub gets a courtesy subset at most |
| Wiki | Follows the code | Regenerate on Forgejo; mirrors with the repo |

## The rule: one writer, one reader

Every failure mode in this area comes from symmetric sync. If both sides can write `main`, then two
force-pushes race, the loser's history is orphaned, and neither platform can be trusted about what
"the code" is. So:

- **Forgejo writes.** All merges, all tags, all releases.
- **GitHub reads.** It receives every commit and serves it to the public.
- **Contributions from GitHub flow in as branches that Forgejo merges.** They never arrive by
  pushing to the mirror directly.

## 1. Git: Forgejo → GitHub push mirror

Forgejo repo → **Settings → Repository → Push mirrors → Add push mirror**:

- Remote: `https://github.com/Jaylouisw/packetforge.git`
- Auth: a **fine-grained GitHub token**, repository `Jaylouisw/packetforge`, permission
  *Contents: read and write*. Nothing else. Store it in Forgejo's mirror config, not in the repo.
- Sync on commit: **on**, plus the scheduled interval as a backstop.

This copies every branch and tag. What it does *not* copy: issues, PRs, discussions, releases, wiki,
labels, milestones. Those are not git.

Verify:

```bash
git ls-remote https://github.com/Jaylouisw/packetforge refs/heads/main
git ls-remote origin refs/heads/main        # same SHA, or the mirror is behind
```

**Never add the reverse direction.** A GitHub→Forgejo mirror plus a Forgejo→GitHub mirror is a loop;
whichever syncs second wins, and on a force-push they can ping-pong indefinitely.

## 2. Pull requests: bridged, not mirrored

Neither platform mirrors PRs, and there is no setting that makes it happen. A bot does it:

1. Poll GitHub for open PRs (`GET /repos/:owner/:repo/pulls?state=open`).
2. For each, fetch the head: `git fetch https://github.com/... refs/pull/<n>/head:gh-pr/<n>`.
   This works for fork PRs on a public repo.
3. Push `gh-pr/<n>` to Forgejo and open (or update) a PR titled `[gh#<n>] <title>`, body linking the
   original and crediting the author.
4. **Forgejo CI runs and is the gate.** Review happens on the Forgejo PR.
5. On merge, the push mirror updates GitHub, and the bot comments the outcome on the GitHub PR and
   closes it: `Landed as <forgejo PR url>`.

Keyed on the **head SHA**, so it is idempotent: a contributor pushing twice updates one Forgejo PR
rather than opening a second. Closing the GitHub PR closes the Forgejo one; a force-push updates it.

What the GitHub contributor sees: they open a PR the way they always do, a bot replies within a few
minutes with a link to where the discussion is, and their commits are already there.

What they cannot do: press "Merge" on GitHub. That button is meaningless on a mirror — the mirror is
a copy, and merging there creates a commit that the next mirror sync will not contain.

> **Status: not built yet.** `docs/MIRRORING.md` describes the contract; the bridge script and the
> Forgejo job that runs it are the next piece of work. Until it exists, a GitHub PR is invisible to
> this project, which is exactly the problem it is meant to solve.

## 3. Issues: one tracker, not two

Two-way issue sync needs a stateful bot holding an ID map, and it duplicates on every edit, delete
and label change. It is not worth the machinery, and half-working it is worse than not doing it.

**Forgejo is the tracker.** For GitHub:

- Migrate the open issues once (title, body, labels, author, created date). The API can do this;
  Forgejo's `POST /repos/:owner/:repo/issues` preserves the body and labels, and the original author
  and date are recorded in a header line of the body, since neither platform will backdate.
- Then a small GitHub Actions workflow on the mirror comments on each new issue:
  *"This project tracks issues on Forgejo: <link>. Please reopen there — this one will be closed."*
  and closes it. It must run **on GitHub**, because GitHub is where the issue is.

An alternative that some projects choose: keep GitHub issues open as a **read-only archive** and
disable new ones (Settings → Features → uncheck Issues). Blunter, but it cannot be misunderstood.

## 4. CI and CD: Forgejo only

The workflows in `.github/workflows/` are currently gated with
`if: github.server_url == 'https://github.com'`, which means they **do** run on GitHub — a second,
competing CI whose results gate nothing. For a mirror that is backwards.

- `.forgejo/workflows/` is the authoritative pipeline: tests, syntax, examples, server smoke, the
  invariants.
- On GitHub, keep at most a **courtesy subset** (`npm test` + syntax) so a GitHub contributor sees
  red or green before the bridge picks their PR up. It must never be a merge gate, and the README
  says so.
- Releases and images are built on Forgejo and pushed to a registry both sides can pull from. GitHub
  Releases are not mirrored; the mirror's tags are enough.

## 5. The public door

None of this works while the canonical host is behind a login. `https://git.jayw.uk` currently
redirects anonymous visitors to Cloudflare Access, so a contributor cannot read the repo, the
issues, or a badge.

Cloudflare Zero Trust → Access → Applications → the app covering `git.jayw.uk`:

- Add a policy: **Bypass**, Include **Everyone**, scoped to path `jaylouisw/packetforge*`.
- Leave **Allow** (your IdP rule) on everything else: `/admin`, `/api`, other repos.

Check it from outside your own network — a phone on mobile data, not this machine:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://git.jayw.uk/jaylouisw/packetforge   # want 200
curl -s -o /dev/null -w '%{http_code}\n' https://git.jayw.uk/jaylouisw/packetforge/badges/workflows/ci.yml/badge.svg
```

302 to `cloudflareaccess.com` means the bypass is not matching. Also enable anonymous read on the
repository if the instance default is private (Settings → Advanced → *This repository is private*).

## 6. What this repo enforces

- `scripts/canonical.js` — the single definition of where the project lives. Change it there.
- `scripts/check-canonical-urls.js` — fails the build if any tracked file points at the old GitHub
  repository, or if the README's clone URL and CI badge do not match the canonical base. It found
  three stale links plus two scripts still calling `gh` the first time it ran.
- `scripts/forgejo-api.js` — the tracker client the triage scripts use instead of `gh`. A missing
  token is reported as *"cannot look"* and exits 2, never as *"no open requests"*.
- `test/canonical-urls.test.js` — proves the checker can fail, so it is not a test that passes
  because it checks nothing.

## Order of operations

1. Publish Forgejo (§5) — without this nothing else reaches a stranger.
2. Add the push mirror (§1) and confirm `main` matches on both.
3. Set up the PR bridge (§2) and watch the first GitHub PR land.
4. Migrate the issues, then close the GitHub tracker (§3).
5. Reduce GitHub CI to the courtesy subset (§4).
