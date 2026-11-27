# Issue tracker

Where this repo's issues live, and the exact way an agent reads and writes them.

## Where

- Tracker: **GitHub**, `jaylouisw/packetforge` — <https://github.com/jaylouisw/packetforge/issues>.
- Client: the **`gh` CLI**, already authenticated on this machine as `Jaylouisw`. There is no token
  file to read and no API URL to build: `gh` resolves the repository from the checkout, and the
  repository's credential helper (`!gh auth git-credential`) is what makes a plain `git push` work.
- The Forgejo instance at `git.jayw.uk` is a **retained read-only archive**. Do not file, comment,
  or open pull requests there; nothing new is merged into it (`docs/MIRRORING.md`).

Check the client before blaming the tracker:

```sh
gh auth status                       # who it is authenticated as, and with which scopes
gh repo view --json nameWithOwner    # the repository this checkout resolves to
```

## Read

```sh
gh issue list --state open --limit 100
gh issue view 130                    # body, labels, state
gh issue view 130 --comments         # the whole thread
gh issue list --label device-request --state open --json number,title,labels
```

The comments are the record: a request that has been assessed carries the exact field the vendor
does not publish. Read them before re-walking a dead end. `--json` is the form to script against -
the human layout is for reading, and it has changed between `gh` releases.

Issue numbers are shared with pull requests, as they were on the archive: `gh issue view` will
happily render a pull request if you give it one's number. `gh issue list` is the queue;
`gh pr list` is not.

## Write

```sh
# open an issue
gh issue create --title "[Device]: Aruba 6000 48G" --body "..." --label device-request

# comment
gh issue comment 130 --body "..."

# close, with the reason on the record
gh issue close 130 --comment "Shipped in #2601."

# labels
gh issue edit 130 --add-label blocked-on-build --remove-label needs-info

# open a PR from the current branch, closing its issue on merge
gh pr create --base main --head <branch> --title "..." --body "Fixes #130"
```

Inside a checkout of this repository `gh pr create` needs no `--repo`; anywhere else, add
`--repo jaylouisw/packetforge`.

## Conventions

- **One issue, one branch, one PR.** A PR that closes an issue opens its body with
  `Fixes #N`; a PR that does not closes nothing and says `Refs #N`. GitHub closes the issue when
  the PR merges into the default branch, which is the only close-out that survives review.
- **PRs as a request surface: off.** External PRs are not a triage input; issues are.
- Keep the close keyword and the number adjacent, and away from sentences that disclaim them:
  GitHub reads `Fixes #N` anywhere in the body — headings, tables, quoted comments — and does not
  read the sentence around it. `CONTRIBUTING.md` records the two shapes that closed the wrong
  issues.
- Push with `git push`, or `git -c credential.helper= push` when you want to be explicit: the
  repository's helper is `!gh auth git-credential`, so neither should prompt.
- Labels are part of the record — `device-request` and `blocked-on-build`, both defined in
  `triage-labels.md`.
