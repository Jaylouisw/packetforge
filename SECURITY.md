# Security Policy

## Supported versions

Only the latest release on `main` receives security updates.

| Version   | Supported |
| --------- | --------- |
| latest    | ✅        |
| older     | ❌        |

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues.**

There is **no private reporting path on this instance today**, and the paragraph that used to stand
here claimed one. Measured against both hosts — <https://git.jayw.uk/jaylouisw/packetforge> and the
origin at `http://odin:3000` — while the repository page answered `200` and `/api/v1/version` answered
`{"version":"11.0.16+gitea-1.22.0"}`:

| Path | Answer |
|---|---|
| `/jaylouisw/packetforge/security` | **404** |
| `/jaylouisw/packetforge/security/advisories/new` (the link this file used to give) | **404** |
| `/api/v1/repos/jaylouisw/packetforge/security-advisories` | **404** |

The repository's own navigation carries no Security tab either, and Forgejo 11 has no confidential
issues, so "open a confidential issue" was not an instruction anyone could follow.

What exists is the **public** tracker, which is the wrong place for the details. So: open an issue that
says only that you have a security report and asks a maintainer to arrange a private channel, and put
nothing sensitive in it. Standing up a private channel is an operator action on the instance, not
something this repository can do from the inside — until that happens, this is the honest route.

What to have ready for that private channel, once one exists:

- A short description of the issue and its impact.
- Steps to reproduce, if possible.
- Affected versions/commit.

## What to expect

- You will receive an acknowledgment within a few days.
- The issue is fixed in a coordinated manner and credited in the release notes,
  unless you prefer to remain anonymous.
- Please hold disclosure until a fix is released.

## Scope

PacketForge is a simulator intended for education and lab use. The main security
considerations are:

- The server binds **every interface**: `server.listen(PORT)` is called with no host argument, and
  Node then binds `::` — measured, `server.address()` reports `{"address":"::","family":"IPv6"}`.
  That is dual-stack, so IPv4 reaches it too; treat it as `0.0.0.0` when you write a firewall rule, but
  do not expect to see that literal address. Keep the port on a network you trust.
- Topologies are **unauthenticated** — there is no login, no token and no per-board permission on any
  of the API's routes. They are also **not** memory-only: the server writes `topo-<id>.json` under
  `PF_DATA` (default `data/`), so a reachable port is a write primitive against the operator's disk as
  well as a read primitive against their lab. Do not expose the server directly to the internet.
