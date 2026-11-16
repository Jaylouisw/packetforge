# Plan: the roadmap is an invitation to build what is already built

Status: forward plan, no code. Closes no open issue; it removes the contradiction already
catalogued at `docs/SIMULATION.md:634`. Scope: `docs/ROADMAP.md`, one row of
`docs/SIMULATION.md`. Nothing here changes an engine rule, a test, or a workflow.

Measured on `e4d0cde2`, 2026-11-16. `docs/ROADMAP.md` has been touched twice in its life -
the initial commit and the NAT line (`a9b3392a`) - and `README.md:204` and
`docs/CLI.md:1765` both send readers to it.

## What exists today

The page is 45 lines with four checkbox lists and one instruction, `:43`: *"Pick any
checkbox."* A reader who takes that advice picks **STP** (`:11`) and finds `engine/stp.js`,
324 lines, with `test/stp.test.js:127` asserting a triangle blocks exactly one port.

| ROADMAP row | Says | The tree says |
|---|---|---|
| `:8` DHCP | unchecked | `engine/dhcp.js` (843 lines), `docs/SIMULATION.md:277` *"in the data path (since #1051)"*, `test/dhcp-in-path.test.js` |
| `:9` DNS | unchecked | `engine/dns.js` (631), `docs/SIMULATION.md:399` §5.7, `test/dns-wire.test.js` |
| `:10` VLANs / 802.1Q | unchecked | `engine/vlan.js` (619), `:105` §2.2, `test/vlan.test.js` |
| `:11` Spanning Tree | unchecked | `engine/stp.js` (324), `:134` §2.4, `test/stp.test.js` |
| `:12` OSPF / RIP | unchecked, one row | OSPF is real: `engine/ospf.js` (732), `:365` §5.5, `test/ospf-wire.test.js`. RIP has no file and no reference in `engine/` - the row is half true and cannot be flipped either way |
| `:14` ACLs / firewall | unchecked | `engine/acl.js` (483), `:319` §5.3, `test/acl-data.test.js`. `firewall` is still an unread capability token (`engine/device.js:115`) |
| `:31` Persistent storage (SQLite / file) | unchecked | `server/index.js:147` `saveTopologyNow()` writes each board to `TOPO_DIR` via temp-file-and-rename, `:183` saves on every edit, and `loadSavedTopologies()` reloads them at boot |
| `:33` Embeddable build and hosted demo | unchecked | the demo is deployed (host-side `deploy.sh`, `Dockerfile`); the single-file `dist/` is genuinely absent - `package.json` has no build script and there is no `dist/` |
| `:39` CI | unchecked | five workflows: `.forgejo/workflows/{ci,auto-rebase,pr-rebase,closed-audit,wiki-sync}.yml` |
| `:43-45` "the test suite is `node test/engine.test.js`" | stated | `test/engine.test.js` is one suite of **290**; `package.json`'s `test` is `scripts/run-tests.js`, whose header records why the `&&` chain was abandoned |

The page is also missing six subsystems that exist and are documented: VRRP
(`engine/vrrp.js`, `:350`), BGP (`engine/bgp.js`, `:378`), IPv6 ND and SLAAC (`:242-264`),
LAG (`:122`), LLDP (`:419`), SCION (`:409`).

Rows that are **correct**: `:15` wireless association (the `wireless` capability is
documented-but-unread at `engine/device.js:115`), `:28` per-vendor translators
(`docs/CLI.md:1763-1765` calls them "a future release"), `:30` auth and per-user boards, `:32`
pcap export - the string `pcap` occurs nowhere but this page. Most of `:19-24` is right too:
`web/app.js:689` mentions undo only in a comment, there is no `toDataURL` anywhere in
`web/`, and the "tabs" at `web/index.html:105-118` are the Inspect/Console/Simulate
inspector, not multiple boards.

So the page is wrong in both directions: it advertises as absent at least seven things that
ship, and it hides six that ship unmentioned.

## What is missing or weak, ranked

1. **Nine unchecked rows are false** (`:8-12`, `:14`, `:31`, `:33`, `:39`). This is the
   onboarding path: README and CLI.md both route here.
2. **Six shipped subsystems have no row at all** - VRRP, BGP, IPv6/SLAAC, LAG, LLDP, SCION.
3. **The OSPF/RIP row cannot be answered** as written; it needs splitting, not ticking.
4. **`docs/SIMULATION.md:634`** carries a hand-written apology for exactly this, which
   becomes false the moment the page is fixed - and a stale apology is its own trap.
5. **No maintenance rule.** Nothing says a capability must flip its row in the PR that lands
   it, which is how the page got four weeks behind; `docs/SIMULATION.md` §6 already
   demonstrates that a hand-maintained claims table drifts.
6. **`:43-45` names the wrong test command**, so a new contributor's first instruction fails
   to run the suite.

## Ordered steps

Each is one PR, docs-only unless stated.

1. **Engine section** (`:5-15`). Rewrite as three states - *Modelled*, *Partial*, *Absent* -
   one line each, every line citing the file or the `docs/SIMULATION.md` section. Split
   `:12` into OSPF (Modelled) and RIP (Absent). Add VRRP, BGP, IPv6/SLAAC, LAG, LLDP, SCION.
   Keep NAT's existing prose. **S.**
2. **Platform and Project** (`:26-39`). Mark persistence Modelled citing
   `server/index.js:147`; split the build row into *demo deployed* / *single-file dist
   absent*; CI names its five workflows; "more device models" states the catalogue as the
   README generator counts it rather than a bare checkbox. Split "unit tests for edge cases"
   into the loop/TTL coverage that exists (`test/stp.test.js:127`) and the ARP-retry case
   that does not. **S.**
3. **UI / UX** (`:17-24`). Say what is there - single-board canvas with a
   selected-device inspector (`web/app.js:278`), faceplate tooltips - then keep undo/redo,
   PNG export and theme as Absent. This is the section that is already right; the PR only
   stops it reading as "we have nothing". **S.**
4. **Footer and the rule** (`:41-45`). Replace "Pick any checkbox" with
   `npm test` / `node scripts/run-tests.js --filter=`, and add one sentence of policy: *a
   capability flips its row in the PR that lands it; ROADMAP states gaps only, and links
   into SIMULATION.md rather than restating it.* **S.**
5. **Retire the apology.** Delete the `docs/ROADMAP.md:7-19` row at
   `docs/SIMULATION.md:634` in the same PR as step 4, so the two cannot disagree. Do not
   touch its neighbours - see risks. **S.**
6. *(Optional, separate PR)* `scripts/check-roadmap.js`: every row's cited path exists and
   every Absent row names no file under `engine/`; `test/roadmap-claims.test.js` pins it.
   This needs a decision from Jay - a checker that guesses intent will fight the next
   author - so it stays out of steps 1-5. **M.**

## Risks

* **Counts rot.** 290 suites and 2,329 JSON files under `devices/` move daily. Rows cite files and section
  anchors, never totals; the totals that must exist come from the README generator (#1671).
* **Overclaiming.** "Wireless" must stay Absent - `engine/device.js:115` says the token is
  unread, whatever `devices/` declares. Any row that flips gets a test or a doc section as
  its evidence, not a file name alone.
* **A second source of truth.** SIMULATION.md §1-6 is the detail; ROADMAP is the gap list.
  Step 4's rule is what stops the two from being maintained twice.
* **Its neighbours at `:626-634` are stale too** (the README "905 specs / 199 vendors" row
  predates the 2,329/258 the generator now writes). Fixing that table is a different plan;
  touching it here would turn four S PRs into one L one.

## Test strategy

Docs-only: `node scripts/check-control-bytes.js` and `node scripts/check-doc-citations.js`
(citation drift window 40 lines, so new `file:line` refs must point where they claim), plus
a manual `git grep` that every cited path exists at the commit. Step 6 alone runs
`node scripts/run-tests.js --filter=roadmap` and the full suite.

## Issues

Closes none of the 19 open (18 are `device-request`; #1507 is the 46 GB firmware history and
needs the host, not this repo). It removes the reviewed contradiction at
`docs/SIMULATION.md:634` and unblocks the "pick a checkbox" path in `README.md:204` and
`docs/CLI.md:1765`.
