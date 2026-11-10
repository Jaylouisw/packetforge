# Public access to this instance

The repository is readable by anyone at <https://git.jayw.uk/jaylouisw/packetforge>, and the whole
instance is readable at <https://git.jayw.uk>. No account, no passkey, no invite.

Writes are unchanged: opening an issue, pushing a branch, or changing settings still requires a
Forgejo account with the right permission on the repository. **Forgejo is the gate, not Cloudflare.**

Measured from a shell with no cookie and no token:

| Request | Answer |
|---|---|
| `GET https://git.jayw.uk/jaylouisw/packetforge` | `200` |
| `git ls-remote https://git.jayw.uk/jaylouisw/packetforge refs/heads/main` | the SHA — so anonymous `git clone` works, which is the thing the path-scoped policy broke |
| `POST …/api/v1/repos/jaylouisw/packetforge/issues` | `401` |
| `GET …/jaylouisw/packetforge/settings` | `303` → `/user/login` |

## How it is arranged

The hostname `git.jayw.uk` sits behind Cloudflare Access, and there is a wildcard Access application
covering `*.jayw.uk` — the default posture for everything on this domain. Two applications now
mention this host:

| Application | Domain | Policy | Why |
|---|---|---|---|
| `git.jayw.uk (Forgejo - own login is the gate, no interactive passkey)` | `git.jayw.uk` | **bypass / everyone** | Forgejo authenticates its own users. Access in front of it only blocks the anonymous read that makes a public repository public. |
| `jayw.uk portals (passkey gate)` | `*.jayw.uk` | allow / passkey | Still applies to every other host on the domain. |

The host application takes precedence over the wildcard for this one hostname, which is the same
mechanism that lets `ha.jayw.uk`, `id.jayw.uk` and `plex.jayw.uk` serve logged-out pages — each is
listed because it does its own authentication.

A path-scoped variant (`git.jayw.uk/jaylouisw/packetforge`) was tried first and removed: it made the
repository browsable but left `git clone` dead, because Forgejo clones through
`/jaylouisw/packetforge.git` — a different path prefix. A host wide bypass has no such seams.

## Why it is not a hole

- Anonymous users get exactly what a logged-out visitor to any public forge gets: read.
- `POST` to a repository's issue collection without a session is refused — measured **`401`** against
  `POST /api/v1/repos/jaylouisw/packetforge/issues` with a body and no cookie.
- The write paths answer **`303` → `/user/login`**: measured on `/user/settings`,
  `/jaylouisw/packetforge/settings` and `/repo/create`. Note the path that does *not*: a bare
  `/settings` returns **`404`**, because there is no such route — Forgejo's settings live under a
  user or a repository, so "the settings page redirects" is only true of the real ones. Nothing about
  the bypass made that 404; it would be the same on an instance behind a passkey.
- Access was never the thing protecting writes. Removing it from read paths does not widen the write
  path by a single route.

## Re-applying it from scratch

Credentials are either a scoped token or the account Global API Key:

```
CF_API_TOKEN=<token with Account > Access: Apps and Policies: Edit>
   or
CF_GLOBAL_KEY=<37 character global key>   CF_EMAIL=<account email>
CF_ACCOUNT_ID=<optional; discovered from GET /accounts when absent>
```

```sh
node scripts/cf-access-bypass.js            # dry run: shows the app it would create
node scripts/cf-access-bypass.js --apply    # creates it, then re-checks the edge anonymously
node scripts/cf-access-bypass.js --check    # only asks the edge: is it public? exit 1 if not
```

The script verifies the only thing that matters — an anonymous request returning `200` — twice, four
seconds apart, because an Access change is not instant at every edge location.

Two things about invoking it are worth knowing before you do. It reads **only** `--apply` and
`--check` (`argv.indexOf(...) !== -1`), so **`--help` is not a flag**: it is ignored, and the script
runs its check against the live edge and prints a real verdict. And with no flags at all it still
makes a network request — with the bypass already in place the output is:

```
$ node scripts/cf-access-bypass.js
Anonymous access to https://git.jayw.uk/jaylouisw/packetforge
  HTTP 200
  PUBLIC — a stranger can read this repository

Nothing to do.
```

So "dry run" here means *no writes to Cloudflare*, not *no I/O*: it tells you the current posture
before deciding there is nothing to change.

## On the Global API Key

It authenticates as the account, so it can reach DNS, R2, billing and every Access application. It
was needed once, because a token with `Access: Apps and Policies: Edit` did not exist. It should not
be the standing arrangement:

1. Rotate it (My Profile → API Tokens → Global API Key → Change) once the bypass is in place.
2. Prefer a scoped token next time — the script accepts either, and `credential()` sends a token in a
   `Bearer` header and a global key as `X-Auth-Email` + `X-Auth-Key`. Getting that wrong returns
   `9103 Unknown X-Auth-Key or X-Auth-Email`, which looks like a bad key when it is a bad header.
   `test/cf-access-bypass-auth.test.js` pins the mapping.
