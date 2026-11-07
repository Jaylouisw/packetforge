# Security Policy

## Supported versions

Only the latest release on `main` receives security updates.

| Version   | Supported |
| --------- | --------- |
| latest    | ✅        |
| older     | ❌        |

## Reporting a vulnerability

**Please do not report security vulnerabilities in public GitHub issues.**

Report them privately via GitHub's private vulnerability reporting:

- Go to **Security → Advisories → Report a vulnerability**
  (https://github.com/Jaylouisw/packetforge/security/advisories/new)

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

- The server is a local tool and binds to `0.0.0.0` by default — bind it to a
  trusted network or localhost if you expose it beyond your machine.
- Topologies are kept in memory and are not authenticated; do not expose the
  server directly to the internet.
