# Public access to this instance

The repository is readable by anyone at <https://git.jayw.uk/jaylouisw/packetforge>, and the whole
instance is readable at <https://git.jayw.uk>. No account, no passkey, no invite.

Writes are unchanged: opening an issue, pushing a branch, or changing settings still requires a
Forgejo account with the right permission on the repository. **Forgejo is the gate, not Cloudflare.**

An account is free and self-service: <https://git.jayw.uk/user/sign_up> is open to anyone, protected
by a built-in captcha, and a new account can open issues immediately. See [ACCOUNTS.md](ACCOUNTS.md)
for the settings behind that and for what a new account may not do.

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
- `POST` to a repository's issue collection without a session is refused; `/settings` redirects to
  the login form.
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

## On the Global API Key

It authenticates as the account, so it can reach DNS, R2, billing and every Access application. It
was needed once, because a token with `Access: Apps and Policies: Edit` did not exist. It should not
be the standing arrangement:

1. Rotate it (My Profile → API Tokens → Global API Key → Change) once the bypass is in place.
2. Prefer a scoped token next time — the script accepts either, and `credential()` sends a token in a
   `Bearer` header and a global key as `X-Auth-Email` + `X-Auth-Key`. Getting that wrong returns
   `9103 Unknown X-Auth-Key or X-Auth-Email`, which looks like a bad key when it is a bad header.
   `test/cf-access-bypass-auth.test.js` pins the mapping.
