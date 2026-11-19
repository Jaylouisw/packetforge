# Plan: the trunk is edited by three verbs and printed by no table

Status: forward plan, no code. Measured on `68857a05`, 2026-11-19. Closes **no** open issue — the queue is
two device requests (#130, #803) and neither is about the console. **Step 2 is a new view and needs Jay's
approval**; steps 1, 3, 4 and 5 repair or prepare surfaces that already exist. Complements, and does not
duplicate, open PR #2056 (`research/cli`: deleting a VLAN under a restricted trunk), which names the one
transcript it could not find — `show interfaces trunk` — as the missing evidence.

Distinct from `docs/plans/show-view-seams.md` (how the `_show()` chain is partitioned — this plan adds one
method to the pattern that plan established) and from `docs/plans/doc-counts.md` (hand-counted numbers in
the docs; step 5 has to move two of them).

## What exists today

**The trunk is fully editable and only half readable.** Three verbs write the allowed list
(`switchport trunk allowed vlan <list> | add | remove | except`, `engine/cli.js:3175-3330`), two write the
native VLAN and the mode (`:3007-3099`), and the stored shape is normalised in one place
(`vlanLib.normalizePortConfig()`, `engine/vlan.js:371-425`: `mode`, `accessVlan`, `nativeVlan`,
`allowedVlans: 'all' | Int[]`, `voiceVlan`).

**What a port does with a frame is one sentence, printed per port.** `vlanLib.switchportSentence()`
(`engine/vlan.js:436-477`) renders `trunk · native 1 · allowed 10,20`, and `_switchportLine()`
(`cli.js:5040-5051`) prints it inside `show interfaces <port>` and inside every block of `show interfaces`
(called at `:6487`). Measured on the 8-port `generic-switch` with `Fa0/1` as a trunk allowing 10,20:

```
Fa0/1 (ethernet, 1G), MAC 0200.0000.0000
  status: up, protocol: up
  peer: s2/Fa0/1
  switchport: trunk · native 1 · allowed 10,20
```

That block is 10 lines; `show interfaces` on the same 8 ports is **66 lines**, so a 48-port box is ~370
lines with the trunk fact buried in each block and no way to see the eight trunks together.

**There is no table, and the console says so.** `show interfaces trunk` is answered by the keyword table:

```
% `trunk` is a view, not a port: this console has no `show interfaces trunk`. `show vlan brief` names each
  VLAN's ports, and `show interfaces <port>` prints the port's trunk settings.
```

The entry is `INTERFACES_VIEW_KEYWORDS.trunk` (`cli.js:557`), one of **13** keys (`:551-568`), rendered by
the builder at `:6405`. `test/show-interfaces-view-keywords.test.js:108` pins the `/trunk settings/` phrase,
and `docs/ARCHITECTURE.md:722`, `:738`, `:1260` and `:1290` carry the counts that go with it (thirteen
entries, twelve words, 97 checks).

**The other view that could answer is deliberately empty for trunks.** `show vlan [brief]` prints access
membership only (`cli.js:5955-5994`; `research/vlan-brief-trunk-ports.md`), so the measured table has a
`VLAN 10` row with nothing in the Ports column:

```
1    default                          active    Fa0/2, Fa0/3, ...
10   VLAN0010                         active
```

Nothing in the console therefore answers "which ports carry VLAN 10" once it is carried by a trunk.

**The engine already computes both halves of the missing distinction.** "Allowed" is
`iface.vlan.allowedVlans`; "active" is membership of the VLAN database, which `show vlan` and
`Device.inactiveVlan()` (`engine/device.js:382-395`) both rebuild by hand from `config.vlans` plus the four
media defaults. `Device.inactiveVlan()` answers the deleted-VLAN question for **access ports only**, and its
own comment (`:380-382`) says the trunk half is "left alone until the evidence for it is as good as this".

**Two states that exist today and no view distinguishes.** Measured:

* `switchport trunk allowed vlan 10,20,99` is accepted with VLAN 99 never created — the port prints
  `allowed 10,20,99`, and `show vlan brief` has no 99 row. Allowed-but-absent is reachable, invisible.
* A trunk cabled to a switch whose port is still access VLAN 1 reads `status: up, protocol: up`.
  `vlanLib.mismatchReason()` (`engine/vlan.js:738-762`) knows the sentence — "one end is a trunk port and
  the other is an access port" — but no view prints it: its only callers are `engine/validation.js:960` and
  the drop reason in `engine/simulator.js:3695`.

**The area is active.** 15 of the last 80 commits on `main` are about the trunk allowed list (#2038, #1999,
#1946, #1886, #1877, #1822, #1749, #1638, #1261), and five suites are named for it
(`test/trunk-allowed-*.test.js`); none of them can point at a table.

## What is missing or weak, ranked

1. **No table.** The command an operator types on a switch is answered with a pointer to two other commands
   (`cli.js:557`), 15 commits after the configuration side was finished.
2. **No allowed-vs-active distinction.** A VLAN can be in the list and absent from the database — measured
   above — and the difference between "removed from the list" and "deleted from the box" is exactly the
   question #2056 is stuck on.
3. **No status or peer evidence.** A trunk to a non-trunk port reads up/up; `mismatchReason()` is the right
   sentence and no view says it.
4. **No census.** `show interfaces` prints 66 lines on an 8-port box; the count of trunks, their native
   VLANs and the VLANs they carry in common cannot be asked.
5. **Counts in prose.** The 13-word table, the "twelve" and the 97 checks are written into ARCHITECTURE at
   four places; removing a word without moving them is the drift `docs/plans/doc-counts.md` documents.

## Ordered steps

| # | Step | Size | Closes |
|---|---|---|---|
| 1 | **Capture the shape, research only.** `research/show-interfaces-trunk-shape.md`: the four sections and their headers (`Port Mode Encapsulation Status Native vlan`, then the three `Port Vlans ...` blocks), the wrap width for a long VLAN list (the 9-column continuation `show vlan`'s Ports column already uses at `cli.js:365`, pinned by `test/show-vlan-ports-wrap.test.js`), **which ports appear** (configured `mode trunk`, or only those that are `trunking` — a shut trunk on a real box), the empty-table answer, and how `none` and 1002-1005 print. Sources: Cisco 4500 command reference `show1.html`, the 3850 `show interfaces trunk` sample with all four sections, plus the two captures already in the repo (`research/trunk-allowed-reserved-vlans.md:24-30`, `research/trunk-allowed-except.md:45-52`, which pin section 2 only). No code. | S | - |
| 2 | **The view: sections 1 and 2.** `_showInterfacesTrunk(dev, tokens)` beside `_showDhcp()` (`cli.js:3580`), routed ahead of the keyword table in the `interfaces` branch (`:6376-6410`) so `trunk` stops being a refused view; drop the key at `:557`. Rows from `iface.vlan.mode === 'trunk'`, status from `dev.ifaceStatus(i, this.topo)` (`:5617`), native from `nativeVlan`, encapsulation the constant this model has, section 2 from the same `formatVlanList()`/`describeAllowed()` the port sentence uses (`vlan.js:327`, `:764`). `show interfaces Fa0/1 trunk` answers with that port's row, keeping the port-first lesson of `test/show-interfaces-view-keywords.test.js:99-120`. **needs Jay's approval.** | M | - |
| 3 | **One VLAN database, then section 3.** Extract the set build inside `show vlan` (`cli.js:5955-5994`) into `vlanDatabase(dev)` — config VLANs, VLAN 1, the four reserved ids, and access membership where the caller needs it — and have `show vlan` and `Device.inactiveVlan()` (`device.js:382-395`) read it. Then `Vlans allowed and active in management domain` = allowed ∩ database, so 99 above appears in section 2 and not in section 3. Pinned by a test that also asserts the two views cannot disagree about which VLANs exist. | S | - |
| 4 | **One carrier list, shared with `no vlan`.** `no vlan 20` currently builds its refusal inline (`cli.js:1427-1466`: `% VLAN 20 is still carried by 1 port(s): Fa0/1 - move them off it first`) by walking ports and testing native/allowed/access. Return `{ port, kind }` from one helper used by both, so the refusal can say **which** ports are trunks and the table cannot count a carrier the refusal does not. No wording change unless the research in #2056 lands. | S | - |
| 5 | **Docs, help and the counts.** `docs/CLI.md`: a row in the show table after `:39`, a transcript in the trunk section, and the paragraph at `:733` that lists views this console does not have. `_help()` (`cli.js:6938-6941`), `test/help-completeness.test.js`'s hand-written list, `docs/ARCHITECTURE.md:710-724` and the counts at `:738`, `:1260`, `:1290` (13 → 12 entries, 97 checks re-measured). | S | - |

Steps 1, 3, 4 and 5 stand alone; 2 depends on 1, and 3 is only observable once 2 exists.

## Risks

- **A taught sentence is being retracted.** `trunk` is one of 13 keywords whose whole point is that a view
  word is not a port name (`ARCHITECTURE.md:710-724`). Removing one must leave the other 12 answering
  identically and the port-first form still naming a port — the 97-check suite is the guard.
- **Trunking is an operational claim this model cannot fully make.** There is no DTP: a trunk cabled to an
  access port measured `status: up, protocol: up`. Section 1's Status column must either say `not-trunking`
  from `framesCompatible()` (`vlan.js:708-736`) or print only the configured mode; printing `trunking` for a
  link that carries nothing would be a new lie in the place operators look first. Step 1 settles which, and
  step 2 needs Jay because it is a claim about state, not a rendering.
- **Row set.** If the vendor's table lists only operational trunks, a switch whose one trunk is shut prints
  an empty table — correct, and alarming. Pin it in step 1 rather than discovering it in review.
- **Reserved VLANs.** `allowedVlans: 'all'` expands to 1-4094 and the four media defaults sit inside any
  folded run (#1946, research note above). Section 2 must use `formatVlanList()` and not a second formatter,
  or `show interfaces trunk` and `switchport:` will fold the same list two ways.
- **Width drift.** `show vlan`'s columns are declared once (`VLAN_COLUMNS`, `cli.js:337-343`) because a
  hand-counted header drifted three columns. The new table needs the same treatment, not `pad()` calls.
- **Scope creep into `_show()`.** The plan is the first view added since the seam pattern
  (`_showDhcp`, `_showOspf`, `_showPowerInline`); it lands as a method, not another branch body.

## Test strategy

- `test/show-interfaces-trunk.test.js` (new, step 2): a trunk with an explicit list; a default trunk printing
  `1-4094`; a native VLAN; a port in access mode absent from the table; `show interfaces Fa0/1 trunk`; the
  empty table on a box with no trunks; a folded list long enough to wrap.
- `test/show-interfaces-view-keywords.test.js` (step 2): the `trunk` case moves from "refused with a pointer"
  to "answers", and the other 12 keep their sentences; re-count the suite.
- `test/trunk-allowed-*.test.js` (5 suites), `test/show-vlan.test.js` and `test/show-vlan-table-shape.test.js`
  (step 3): unchanged output, plus
  one new assertion that allowed-but-absent VLAN 99 is in section 2 and not in section 3.
- `test/show-interfaces-port.test.js:151-207` and `test/vlan-delete-leaves-port-inactive.test.js` (step 4):
  the refusal names the same ports the new table lists, `(native)` and trunk/access wording preserved.
- `help-completeness`, `docs-cli-transcript`, `docs-show-commands` (step 5), then `npm test` in one leg and
  `npm run check:citations` for the two docs pages.

## Out of scope

`Vlans in spanning tree forwarding state and not pruned` — `engine/stp.js:191` runs one tree over bridges
with no VLAN argument, so a per-VLAN forwarding state does not exist to print; a fourth section would have to
invent it or print one tree's answer four times. `show interfaces switchport` (a different, per-port view),
`show vlan all-ports`, `switchport nonegotiate` and `switchport trunk encapsulation` as configuration, DTP,
and any web-panel surface: the panel already renders the same sentence through
`test/switchport-agreement.test.js`, and it needs no table.
