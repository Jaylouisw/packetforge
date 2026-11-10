# Contributing to PacketForge

Thanks for helping out. PacketForge is built to be easy to extend — adding a piece
of hardware is a single JSON file with **no code changes**. This guide covers the
common paths.

## Two doors, and which one is yours

The project is developed on its own forge at <https://git.jayw.uk/jaylouisw/packetforge>, which is
public to read. Accounts there are not open to the public — the maintainer is the only account — so
**contributors work through the GitHub mirror at <https://github.com/Jaylouisw/packetforge>**.

| You want to | Do it on |
|---|---|
| Read the code, browse history, download a release | Either — both carry the same commits |
| Open an issue or a device request | GitHub |
| Send a fix or a new device | Fork and open a pull request on GitHub |
| Review, run CI, merge | The forge (maintainer only) |

Pull requests opened on GitHub are carried across to the forge by `scripts/gh-bridge.js`: the
contributor's commits are pushed as a `gh/<number>` branch, verbatim and with authorship intact, and
a pull request is opened there so CI and review happen in one place. A maintainer replies on your
GitHub thread. You never need an account on the forge, and the forge never needs one of your keys.
**How automatic is it?** The script is written and idempotent, but nothing schedules it — there is no
job in `.forgejo/workflows/` that invokes it, so a GitHub pull request waits until a maintainer runs
the bridge. If yours has been sitting for a few days, say so on the thread.

The direction of travel is **forge → GitHub for code, GitHub → forge for contributions**. The mirror
pushes automatically on every commit; the bridge pulls contributions in. Neither side is a fork of
the other in spirit: the forge is the workshop, GitHub is the shopfront.

## Ways to contribute

- **Add a hardware model** — the most common contribution (see below).
- **Fix a bug** in the engine, CLI, server, or web UI.
- **Improve documentation** — and if you change a count or a capability claim, run
  `node scripts/build-wiki.js` afterwards: `docs/wiki/` is generated from templates inside that
  script, and nothing in CI checks it, so it drifts silently when a fact moves. Publishing those
  pages to the Forgejo wiki is a separate manual step, `npm run wiki:publish`
  (`node scripts/publish-wiki.js --dry-run` prints the pages that differ without writing anything) —
  it clones `packetforge.wiki.git` and pushes. Two things to know before you try it:

  - **On Windows the dry run always claims every page is out of date.** The script compares the
    clone to `docs/wiki/` as raw strings, and with `core.autocrlf=true` the checkout is CRLF while
    the repository stores LF. Check after normalising line endings, or from Linux.
  - **Use the SSH URL if there is no tty.** The default HTTPS URL prompts for a username and fails
    with `could not read Username for 'https://git.jayw.uk'` in a script or an automated run:

    ```bash
    PF_WIKI_REPO=ssh://forgejo/jaylouisw/packetforge.wiki.git node scripts/publish-wiki.js
    ```

    On a fresh instance the wiki repository does not exist until somebody saves one page through the
    web UI, and until then the clone answers "Repository not found" — which looks like a credentials
    problem and is not one. On this instance the repository is already seeded, so SSH works.
  - **When there is nothing to publish, it crashes rather than saying so** — a raw
    `Error: Command failed: git … commit` stack trace. That is `core.autocrlf` making the copied pages
    identical to the index again, not a failure; check the command named in the error. The run can
    also leave its working copy in `%TEMP%\packetforge-wiki-<pid>` — remove it when you are done.
  - **It can hang instead of crashing.** Measured on this host: the run printed the six `updated`
    lines and then produced nothing for five minutes, because `core.autocrlf` had already made the
    copy identical and git had nothing to push. If that happens, kill it — the pages are already
    correct — and publish by hand, which is three commands and always works:

    ```bash
    git clone ssh://forgejo/jaylouisw/packetforge.wiki.git /tmp/wiki && \
      cp docs/wiki/*.md /tmp/wiki/ && cd /tmp/wiki && \
      git commit -am "Publish wiki from docs/wiki" && git push origin HEAD
    ```

    That is exactly how the pages reach the wiki when the script misbehaves; `git log` on the wiki
    repository is the check that they did.
- **Report a bug or request a device** via an issue.

## Ground rules

- Behave per the [Code of Conduct](CODE_OF_CONDUCT.md).
- One logical change per pull request.
- Keep the project **zero-dependency** — do not add npm packages without a strong
  reason and a discussion in the issue first.
- All checks must pass before merge (CI runs them automatically — what each one
  does, and what a red one means, is in [docs/CI.md](docs/CI.md)).

## Development setup

There is no install step and no build step:

```bash
git clone https://git.jayw.uk/jaylouisw/packetforge.git
cd packetforge
node server/index.js        # UI + JSON API on http://localhost:8000
```

Run the checks locally before submitting:

```bash
npm run syntax                    # syntax-check every JS file
npm run test:engine               # engine tests
npm run test:cli                  # CLI tests
npm run examples                  # rebuild + verify the example labs
# or simply:
npm test
```

### Re-measuring the numbers in these docs

Every figure in this repository's documentation was produced by a command, and each one moves when the
catalogue grows. These are the commands, run against the tree as it stands — copy the one whose number
you are about to change, rather than editing the doc to match the doc.

```bash
# 1,628 models / 246 vendors / 16,746 ports
node -e "const{loadCatalog}=require('./devices/registry');const{Topology}=require('./engine');const c=loadCatalog(require('path').resolve('devices')).filter(d=>!d.error);let p=0;for(const d of c){p+=new Topology().addDevice(d).interfaces.size}console.log(c.length,'models /',new Set(c.map(d=>d.vendor)).size,'vendors /',p,'ports')"

# 89 media / 9 families / 26 cages
node -e "const m=require('./engine/media.js');console.log(Object.keys(m.MEDIA).length,'media /',new Set(Object.values(m.MEDIA).map(x=>x.family)).size,'families /',Object.keys(m.CAGES).length,'cages')"

# 25 distinct device categories
node -e "const{loadCatalog}=require('./devices/registry');console.log(new Set(loadCatalog(require('path').resolve('devices')).filter(d=>!d.error).map(d=>d.category)).size,'categories')"

# 147 refusal codes
grep -ho "'E_[A-Z0-9_]*'" engine/*.js | sort -u | wc -l

# how many suites, and whether they are green
ls test/*.test.js | wc -l
node scripts/run-tests.js | tail -6
```

**Pass `loadCatalog()` an absolute path.** Hand it the relative string `'devices'` and it returns 1,628
entries that are all `{ vendor: 'error', model: '<file>', error: … }` — not one real spec, and no
exception to warn you. The cause is line 19 of `devices/registry.js`: it `require()`s `path.join(dir,
…)`, and a path with no leading `./` is read as a **module specifier**, so every file fails to resolve
and becomes an error entry by design (the `catch` that exists to survive one broken spec swallows the
whole directory). `path.resolve('devices')` — or `__dirname` from inside the module — is the fix, and
it is why every call site in `engine/` and `scripts/` passes an absolute path. Filter `d => !d.error`
anyway: with a correct path there are none on this tree, but an import that lands a malformed spec will
produce one, and that is the difference between a count of 1,628 and a count that quietly includes a
`{ "vendor": "error" }` row.


**`loadCatalog()` can hand back entries that carry an `error` key instead of a spec** — an unreadable or
malformed file becomes one of those rather than throwing. Filter `d => !d.error` before you count
anything, or a broken file inflates the model total by one and crashes the port sum. (There are none on
this tree; the filter is what makes the one-liners safe to paste after an import.)

### What every script in `scripts/` is for

Twenty-five programs, and the flags below are the ones that change what they touch. The read-only
checks exit non-zero on a finding so CI can use them. The catalogue editors are dry by default —
`apply-research`, `apply-port-fixes`, `apply-port-layouts`, `fix-optics`, `fix-optics-claims` and
`import-devices` all print what they would change and need `--apply`/`--write` before anything is
touched — **with one exception: `merge-research.js` has no guard and writes as soon as it runs.** It
is the original one-shot merge of the first homelab batch, kept for the record; there is no `--apply`
in it to pass, so do not run it to see what it does.

| Script | What it does | Touches |
|---|---|---|
| `syntax-check.js` | recursively syntax-check every JS file (`--check`) | reads only |
| `check-control-bytes.js` | refuse control bytes smuggled in by scripted edits (`--check`) | reads only |
| `check-node-surface.js` | flag anything newer than Node 18 (`--list`) | reads only |
| `check-canonical-urls.js` | every URL points at the forge, not the old GitHub home | reads only |
| `canonical.js` | the constants the URL check uses — where the project actually lives | reads only |
| `check-dockerfile.js` | pinned base image, non-root, `HEALTHCHECK`, every `COPY` source exists | reads only |
| `run-tests.js` | the suite runner: `--list`, `--filter <name>`, `--bail`, `--verbose` | reads only |
| `smoke-http.js` | spawn a server on a free port, drive every route the UI uses, kill it | a temp `PF_DATA` it deletes |
| `audit-devices.js` | accuracy audit over the whole catalogue (`--json`) | reads only |
| `audit-port-types.js` | connector/port-type coherence (`--json`, `--out`, `--quiet`) | writes a report |
| `missing-devices.js` | compare the catalogue with research and issue queue (`--json`, `--strict`, `--stubs`, `--no-issues`, `--help`) | `--apply` writes specs |
| `apply-research.js` | validated path for correcting an existing spec (`--dry-run`, `--force`) | writes specs |
| `apply-port-fixes.js` / `apply-port-layouts.js` | apply researched port corrections / layouts (`--apply`) | write specs |
| `import-devices.js` | validate and merge swarm-researched specs (`--apply`, `--write`, `--upgrade`, `--json`, `--all`; dry by default) | writes specs |
| `merge-research.js` | the original one-shot merge of homelab research into the registry | writes specs |
| `fix-optics.js` / `fix-optics-claims.js` | one-off repairs for #9-class optics defects (`--apply`) | write specs |
| `request-queue.js` | the triage queue for hardware requests (`--json`, `--skeleton`) | reads the tracker |
| `sweep-device-requests.js` | find requests whose device the catalogue already has (`--limit`, `--close`) | reads, and comments on issues with `--close` |
| `forgejo-api.js` | the tracker client the two above use — not `gh`, which does not exist here | reads only |
| `gh-bridge.js` | mirror inbound GitHub contributions onto the forge (`--dry-run`, `--all`, `--prs`, `--issues`, `--limit`, `--force`, `--report`) | the tracker |
| `cf-access-bypass.js` | Cloudflare Access bypass for one public path (`--check`, `--apply`) | the Cloudflare zone |
| `build-wiki.js` | regenerate `docs/wiki/*.md` from the templates inside it | `docs/wiki/` |
| `publish-wiki.js` | push those pages to the wiki repo (`--dry-run`, `--quiet`) | the wiki repository |

**Almost every one of these scripts ignores a flag it does not know.** Exactly one validates:
`missing-devices.js`, which holds a `known` set and prints `Unknown flag: --bogus` with the usage line
before exiting **2** — `grep -rln "Unknown flag" scripts/` returns that file alone. Everything else
reads `process.argv` with
`indexOf(...)` and simply do not match, so a typo quietly does the *default* thing — measured:
`audit-devices.js --bogus`, `audit-port-types.js --bogus` and `check-node-surface.js --bogus` all run
their normal job and exit **0**,
and `import-devices.js --stubs` (a flag that belongs to `missing-devices.js`) performs a normal import
(`Scanned 49 file(s), 670 spec(s)`) instead of writing skeletons. Check the flag against the table
above before relying on it, and run the catalogue editors with no flags first for exactly this reason.

Two things worth knowing before you reach for one: `sweep-device-requests.js` and
`request-queue.js` talk to the tracker over the **network** (the sweep hard-codes a LAN API address
and scrapes a token from the git remote — see [TRIAGE.md](docs/TRIAGE.md)), and the four `apply-*` /
`import-*` / `merge-*` scripts are the only ones that rewrite catalogue JSON, so run them without
flags first and read the diff they offer.

## Adding a hardware model

The catalog is pure JSON. Adding a model = adding one file:

1. Create `devices/<vendor>/<model>.json`.
2. Fill in the fields (schema in [docs/DEVICE_REGISTRY.md](docs/DEVICE_REGISTRY.md)).
3. Run `npm test` and `npm run syntax`.
4. Open a pull request.

Minimal example:

```json
{
  "vendor": "acme",
  "model": "AC-R9000",
  "label": "ACME Router 9000",
  "category": "router",
  "description": "Fictional 8-port gigabit router.",
  "capabilities": ["l3-forward", "cli", "nat", "dhcp-server"],
  "interfaces": [
    { "name": "eth0", "type": "ethernet", "speed": "1G" },
    { "name": "eth1", "type": "ethernet", "speed": "1G" }
  ],
  "icon": "router",
  "color": "#ff6600"
}
```

### Datasheet accuracy is mandatory

Port counts, speeds, and capabilities must match the manufacturer's datasheet.
Enumerate the **full** physical port complement — a "24-port switch" is almost
always 24×RJ45 **plus** 2–4×SFP(+). The headline number hides the uplinks. Never
model a representative subset; the project verifies specs against the datasheet.

### Categories and capabilities

- `category` is one of: `router, switch, l3-switch, firewall, ont, host, server,
  wireless, ptp, cloud`.
- `capabilities` are one or more of the fifteen in `engine/device.js` — `CAPABILITIES`:
  `host, l2-forward, l3-forward, cli, dhcp-server, dhcp-client, nat, firewall, wireless,
  http-server, poe-pse, poe-pd, vlan, lacp, stp`. The last five were added with the features that
  needed them (PoE roles, VLAN/trunking, LAG, spanning tree), so a PoE switch should say
  `poe-pse` and a trunk port's device should say `vlan`.

Adding a **new** category is a three-file change (`devices/registry.js`,
`web/app.js`, `web/canvas.js`) — call it out in the PR rather than doing it silently.

## Code style

- CommonJS modules, `'use strict';` at the top.
- 2-space indentation, single quotes, semicolons.
- Prefer plain functions and `Map`/`Set` over clever one-liners — the engine is
  meant to be read by students.

## Commit messages

Use a plain imperative subject line, e.g.:

- `Add airFiber 5XHD radio`
- `Fix CRS326-24G port count`
- `Add PTP radio category`

No trailing period, no scope prefixes.

## Review process

1. A maintainer reviews the PR.
2. CI must be green. [docs/CI.md](docs/CI.md) names the **three jobs** a pull request has to pass —
   `test` (which the Node matrix expands into three runs: `Test (Node 18)`, `20`, `22`),
   `Server smoke test` and `Docker build` — and lists the seven **steps** inside the test job (syntax,
   control bytes, the Node 18 API floor, canonical URLs, the full suite, the example-lab build, and
   "every lab model exists"), with the local command for each.
3. For device additions, the maintainer cross-checks the datasheet.

Thank you for contributing!

## Exemptions have to be claimed

An invariant is only as strong as the classes of hardware it actually checks. Three separate bugs
in this repository came from the same sentence — a `continue` that quietly removed a group of ports
from a check because they were "special":

```js
if (isConsoleOnly(i.hardware)) continue;   // 163 console ports, each claiming a gigabit (#979)
if (!i.hardware.media.length) continue;    //  84 coax ports that could not be cabled at all (#1039)
const top = Math.max.apply(null, caps);    //  NaN for caps written "10G", so nothing was compared (#993)
```

Each was defensible on the day it was written, each had a comment explaining why, and none of them
appeared in the backlog. `test/skip-audit.test.js` now reads the test sources and requires every
skip that decides *a piece of hardware is outside a check* — by its type, its prose, its class or
its media — to carry one of:

```js
// #1234 - the issue that tracks this exemption, if it is a gap
if (isConsoleOnly(hw)) continue;

// not an exemption: this loop is looking for something that is not there
if (!spec) continue;

// A deliberate exemption: a device describing both PoE-in and PoE-out is a passthrough.
if (POE_IN.test(desc) && POE_OUT.test(desc)) continue;
```

The audit does not judge whether an exemption is *correct* — only that it is claimed, tracked and
findable. If you are adding a rule and a class of devices fails it, that is a decision about the
catalogue: either fix the devices, or open an issue and reference it.

## The Node 18 floor is real

CI runs the suite on Node 18, 20 and 22. If you develop on something newer, `npm test` can be green
locally and the Node 18 job can fail twenty minutes later, which reads like a flaky runner rather
than "you used a Node 20 API". `scripts/check-node-surface.js` closes that gap statically, so it
needs no second interpreter installed:

```
node scripts/check-node-surface.js          # fails on any post-18 API
node scripts/check-node-surface.js --list   # what is banned, and what to write instead
```

It runs in CI before the matrix jobs, so the failure is immediate and names the API.
