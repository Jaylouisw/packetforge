# Plan: a member whose VLAN stops matching the bundle still reads `(P)`, and still takes frames

Status: forward plan, no code. Measured on `3cb22f44`, 2026-11-24, with a two-switch probe lab
(`generic-switch` pair, two cables between `Fa0/2`-`Fa0/2` and `Fa0/3`-`Fa0/3`, `channel-group 1 mode active`
at both ends, one `generic-pc` behind each switch). Closes **no** open issue: the tracker holds one, #2571
`main is red` at this head, which is a CI fault and not about LAGs. Scope: `engine/lag.ts` (one predicate),
`engine/simulator.js:3708` and `engine/segment.ts:165` (the two callers that decide where a frame goes),
`engine/cli.js` (`_lagMemberStates()`, the summary note, `show interfaces`), `docs/CLI.md:32`,
`docs/SIMULATION.md:153-157` and `:647`, one new suite. No device spec, no workflow.

## What exists today

**The rule is written, and it is the validator's.** `validateLag()` reports `E_LAG_VLAN_MISMATCH` when any
member's port record says `vlanCompatible === false` (`engine/lag.ts:649-657`), and the records come from
`_lagMemberPorts()` (`engine/cli.js:4417-4438`), which asks `vlanLib.framesCompatible()` against the first
member - the same predicate `mismatchReason()` (`engine/vlan.js:758`) already turns into a sentence for the
cable inspector (`engine/validation.js:960`) and for a frame dropped by a mismatched cable
(`engine/simulator.js:3840`).

**It is asked exactly once, at the moment the port joins.** `_lagWarnings()` (`engine/cli.js:4393`) is the
only caller. Measured, joining a member that is already on another VLAN:

```
s1(config-if)# channel-group 1 mode active
Interface Fa0/3 added to channel group 1 (mode active)
% Warning: LAG 1: member(s) Fa0/3 are not VLAN-compatible; every member must be in the same VLAN set.
```

**And never again.** The same member, already bundled and healthy, then moved to another VLAN:

```
s1(config-if)# switchport access vlan 30
% Access VLAN does not exist. Creating vlan 30
Access VLAN 30 on Fa0/3

s1# show etherchannel summary
1      Po1(SU)         LACP      Fa0/2(P) Fa0/3(P)
```

No warning, no `%EC-5-CANNOT_BUNDLE2`-shaped sentence, and the member is still counted bundled. Moving it
back to VLAN 1 prints nothing either: the group is never re-evaluated, in either direction.

**The frame path still hashes onto it.** `engine/simulator.js:3708` removes a member from the egress pool only
when `lagLib.memberSuspension()` answers - and that function (`engine/lag.ts:521`) asks about *negotiation*
(`negotiationVerdict()`, both ends passive, a far port in no group), never about port configuration.
`selectMember()` (`:407`) then hashes over `eligibleMembers()` (`:457`), which the mismatched member is still
in. Measured on the same lab, `ping 10.0.0.20` from host to host:

| bundle | result | frames `s1` put on the wire |
|---|---|---|
| healthy | `100 percent (5/5)` | `{"Fa0/2":2,"Fa0/3":6,"Fa0/1":7}` |
| `Fa0/3` moved to VLAN 30 | `0 percent (0/5)`, `% Echoes lost: 5 drops (no ARP reply from 10.0.0.20 x5)` | `{"Fa0/2":6,"Fa0/3":6,"Fa0/1":1}` |

Half the frames leave a member that files them in a VLAN the far end cannot answer in, and the box that says
so is nowhere: not the summary, not the port's own block, not the log.

**The letter for this state is already printed in the key and cannot be produced.** `ETHERCHANNEL_FLAGS`
(`engine/cli.js:536`) prints `I - stand-alone s - suspended`; `_lagMemberStates()` (`:6286`) computes
`suspended` from negotiation only, and `(s)` is reachable in a row solely for a ninth member of a static group
(`:7717`). `docs/CLI.md:32` therefore describes `(P)`, `(I)` and `(D)` and not the fourth state.

**A member's own block never mentions its bundle.** `show interfaces Fa0/3` on the mismatched member prints
`switchport: access VLAN 30` and no channel-group line at all, before or after the change.

## What is missing, ranked

1. **Nothing re-asks the rule after the join.** The one moment a mismatch is reported is the one moment it
   cannot yet exist by accident; every later edit is silent.
2. **The summary reports a member as bundled when its frames cannot reach the far end.** `(P)` is a claim
   about carrying traffic, and this is the case where it is false.
3. **The frame path keeps the member in the hash pool**, so the loss is partial and hash-dependent - the same
   "the lab is flaky" signature #1263 removed for a cable that is out.
4. **A member's own block is silent**, so the port an operator is looking at is the one place that says
   nothing about why nothing arrives.
5. **`(s)` has no producer for this cause** while the key promises it and `docs/CLI.md:32` omits it.

## Ordered steps

Each is one PR by one worker. Sizes are S/M/L.

1. **S - one predicate, the validator's own.** `memberConfigMismatch(dev, ifaceName, group, topo)` in
   `engine/lag.ts` beside `memberSuspension()` (`:521`): resolve the bundle's reference member (the first
   member that has an `i.vlan`), and return `{ why }` from `vlanLib.mismatchReason(ref.vlan, iface.vlan)`
   when it answers non-null. `_lagMemberPorts()`'s `vlanCompatible` (`engine/cli.js:4434`) is then this
   predicate's answer rather than a second copy of the comparison, so the join-time warning and the new
   states cannot disagree. No caller changes behaviour in this step.
2. **M - the frame path asks it.** `engine/simulator.js:3708` and `engine/segment.ts:165` add the predicate
   to the branch that already drops a member for `memberSuspension()`. A suspended member is *not* a
   stand-alone one: it does not fall back to carrying traffic as a single link, it carries nothing, so it
   must leave the pool rather than become its own egress. This is the step that changes answers, and it is
   the point of the plan.
3. **S - the summary prints `(s)`.** In `_lagMemberStates()` (`engine/cli.js:6286`) collect mismatched
   members into the existing `suspended` map with their reason, and in the table (`:7713-7717`) print
   `(s)` for them ahead of `(P)`/`(H)`/`(D)`. Under the row, one sentence in the shape the stand-alone note
   already uses (`:7738`): `Fa0/3 is suspended (access VLAN 1 against access VLAN 30) - it carries nothing`.
   The bundle's own `S`/`U` flag and the `bundle N is down` sentences must then count only `live` members,
   which they already do - verify, do not assume.
4. **S - the port's block names its bundle and its state.** `show interfaces <port>` gains one line for a
   member: `channel group 1 (Po1), suspended: access VLAN 1 against access VLAN 30`, and
   `channel group 1 (Po1), bundled` otherwise. Touch the block builder around `engine/cli.js:8089` and
   `docs/CLI.md`'s `show interfaces <port>` row.
5. **S - report it when it happens.** The `switchport access vlan`, `switchport mode` and
   `switchport trunk allowed vlan` doors re-run `_lagWarnings()` for every group the port is a member of, so
   a post-join mismatch is reported at the line that caused it, in the words the join-time warning already
   uses, and a repair says the member is bundled again. The `%` prefix and one-line limit are the existing
   convention (`engine/cli.js:4405-4406`).
6. **M - the suite.** `test/lag-member-suspension.test.js`: the three-lab measurement above as assertions -
   healthy bundle 5/5 and both members used; mismatch 0/5 with `Fa0/3` absent from the egress tally and
   `(s)` in the summary; repair returns to `(P)` and 5/5; a static (`mode on`) group is suspended the same
   way; a two-port bundle of mismatched members reports `bundle N is down ... (traffic is dropped)` rather
   than the stand-alone wording.
7. **S - docs.** `docs/SIMULATION.md:157` (the LAG row) gains the suspension sentence and `:647` (the mode
   row) names the new predicate beside `memberSuspension()`; `docs/CLI.md:32` gains `(s)` and the note line.

Steps 1, 3, 4, 5 and 7 change no forwarding answer. Step 2 is the only behaviour change, and step 6 pins it.

## Risks and test strategy

* **Two copies of a rule is how this repo's defects start.** Step 1 exists so `E_LAG_VLAN_MISMATCH` and the
  running box answer from one function; if `_lagMemberPorts()` keeps its own comparison, a later edit to
  `framesCompatible()` reintroduces the split.
* **The undefined default.** `_lagMemberPorts()` only sets `vlanCompatible` for a port that has `i.vlan`
  (`engine/cli.js:4432-4435`), so a member with no switchport config reports no opinion. Decide it out loud
  in step 1 (a port with no VLAN files frames in VLAN 1, per `portPvid()`, `engine/simulator.js:167`) and pin it, or the suspended
  state will depend on how a lab was built.
* **`mode on` differs on the wire.** The 12.2(35)SE rule puts an *incompatible* port independent, and the
  independent behaviour this console already models came from the negotiation case
  (`research/lacp-one-sided-group.md`). Keep suspension for both modes - a mismatched static bundle on a box
  still suspends the odd member - and say so in step 7, because the plan's own lab is `active`.
* **Answers change in step 2.** `test/lag.test.js`, `test/lacp-one-sided-group.test.js`,
  `test/etherchannel-summary-layout.test.js` and `test/brief-port-channel-row.test.js` pin today's letters;
  the regression set is those four plus the full `npm test`, run once in step 2 and again in step 6.
* **Determinism.** `{"Fa0/2":6,"Fa0/3":6}` above is a hash tally, not a promise; step 6 asserts the *set* of
  egress ports (the suspended member absent), never a count.
* **Do not widen `memberSuspension()`.** The `(I)` letter and the "still carries traffic as a single link"
  sentence are correct for negotiation failure and are what four suites read; the third state is added
   beside it, not by changing what it means.

## Issues

Closes none. #2571 is `main` red at this head and belongs to the CI stream; nothing in the tracker and no other
file under `docs/plans/` covers EtherChannel member state - `docs/plans/lag-min-links.md` is about
`minLinks` and leaves `(s)` to the letter that "the key already promises".

Deliberately not proposed: LACP/PAgP **PDU** exchange and `show lacp neighbour` (a protocol, and the five
other `show etherchannel` views refused by name at `engine/cli.js:588-596`); the speed and duplex halves of
the same one-shot check (`E_LAG_SPEED_MISMATCH`, `E_LAG_DUPLEX_MISMATCH` - the same hole, and folding three
rules into one PR makes step 2 unreviewable); `minLinks` verdicts (`lag-min-links.md` owns them); and any
change to `eligibleMembers()`'s port-order tie-break, which the hot-standby behaviour depends on.
