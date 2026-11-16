# Security Policy

## Supported versions

Only the latest release on `main` receives security updates.

| Version   | Supported |
| --------- | --------- |
| latest    | ✅        |
| older     | ❌        |

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues.**

Report them privately. The project lives on Forgejo, which supports **confidential issues** — open
one and it is visible only to the maintainers:

- Go to **Security → Advisories → Report a vulnerability**
  (https://git.jayw.uk/jaylouisw/packetforge/security/advisories/new)

What to include:

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

- The server listens on `127.0.0.1` by default, so only this machine can reach
  it. `PF_HOST=0.0.0.0` puts it on every interface (the container image sets
  that, which is what makes `docker run -p 8000:8000` work); everything this
  server serves is unauthenticated, so do that only on a network you trust, and
  never directly on the internet.
- Topologies are kept in memory and are not authenticated; do not expose the
  server directly to the internet.
- The WebSocket upgrade refuses a page served from another origin: its `Origin`
  must name the same host and port as `Host`, unless it is listed in
  `PF_ALLOWED_ORIGINS`. The REST API still answers with a wildcard
  `Access-Control-Allow-Origin`, so a page can still *read* a board over HTTP;
  that is the next change, not a claim this posture makes.
