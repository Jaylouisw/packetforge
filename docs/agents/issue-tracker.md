# Issue tracker

Where this repo's issues live, and the exact way an agent reads and writes them.

## Where

- Tracker: **Forgejo**, `http://odin:3000/jaylouisw/packetforge` (public: `https://git.jayw.uk/jaylouisw/packetforge`).
- There is a GitHub mirror. It is a read-only shopfront: never open issues or PRs there.
- Auth: `Authorization: token $TOK`, where `TOK` is read from
  `C:/Users/jay/AppData/Local/hermes/secrets/forgejo.token`. Never print, echo or commit it.

## Read

```sh
curl -sS -H "Authorization: token $TOK" \
  'http://odin:3000/api/v1/repos/jaylouisw/packetforge/issues?state=open&type=issues&limit=100'
curl -sS -H "Authorization: token $TOK" \
  'http://odin:3000/api/v1/repos/jaylouisw/packetforge/issues/130/comments?limit=50'
```

The comments are the record: a request that has been assessed carries the exact field the
vendor does not publish. Read them before re-walking a dead end.

## Write

```sh
# comment
curl -sS -X POST -H "Authorization: token $TOK" -H 'Content-Type: application/json' \
  -d '{"body":"..."}' .../issues/<N>/comments

# open a PR — head MUST be owner-qualified, or Forgejo answers "bad revision"
curl -sS -X POST -H "Authorization: token $TOK" -H 'Content-Type: application/json' \
  -d '{"head":"jaylouisw:<branch>","base":"main","title":"...","body":"Fixes #<N>\n\n..."}' \
  .../pulls
```

## Conventions

- **One issue, one branch, one PR.** A PR that closes an issue opens its body with
  `Fixes #N`; a PR that does not closes nothing and says `Refs #N`.
- **PRs as a request surface: off.** External PRs are not a triage input; issues are.
- Push with `git -c credential.helper= push` — a bare push hangs on the credential helper.
- Labels are part of the record — `device-request` and `blocked-on-build`, both defined in
  `triage-labels.md`.
