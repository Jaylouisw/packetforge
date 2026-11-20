# Plan: a VLAN list at the `vlan` door

Status: forward plan, no code. Measured on `d1e1c3d6`, 2026-11-20, with a probe lab built on
`Topology`/`Simulator`/`CliSession` against a `generic-switch`. Steps 1-5 extend what exists; only
step 6 adds a command word and is marked for Jay. Closes **#2269**. The grammar's evidence is already
in the repo (`research/vlan-range-order.md`), so no new research is needed to start.

## What exists today

| fact | evidence |
|---|---|
| the `vlan` door reads **one** token as an id | `engine/cli.js:1354-1356`; `_vlanIdRefusal()` `:1129-1150`, whose gate is `/^[0-9]+$/` at `:1137` |
| every token after the id is the name, `name` keyword optional | `:1358-1364`; documented as `vlan <id> [name] <text>` (`docs/CLI.md:223`, `:306`, `:4068`) |
| `no vlan` reads one token the same way | `engine/cli.js:1491-1493`, then the per-id body `:1494-1608` (default VLAN, media defaults, missing VLAN, trunk carrier, staged port) |
| a real vlan-list parser already exists | `parseVlanList()` `engine/vlan.js:129` — commas *and* whitespace, ranges, `all`, backwards-range refusal, duplicates, reserved block; `formatVlanList()` `:327`; `vlanListIncludes()` `:304` |
| it is wired to exactly one door | `engine/cli.js:3469` — `switchport trunk allowed vlan {<list>\|add\|remove\|except}` |
| running-config prints one line per VLAN | `engine/cli.js:7258-7261`, `vlan <id> [<name>]`, numeric order |
| `show vlan` takes no tail at all | `engine/cli.js:6499-6506` via `showNoTail()` |

Measured:

```
sw1(config)# vlan 10-12        % Invalid VLAN id "10-12": a VLAN id is a whole number from 1 to 4094
sw1(config)# vlan 10,20-22     % Invalid VLAN id "10,20-22": a VLAN id is a whole number from 1 to 4094
sw1(config)# no vlan 10-12     % Invalid VLAN id "10-12": a VLAN id is a whole number from 1 to 4094
sw1(config)# vlan 20-10        % Invalid VLAN id "20-10": a VLAN id is a whole number from 1 to 4094
sw1(config)# vlan 50 60        VLAN 50 created (name: 60)          <- second token is the name, by design
sw1(config)# no vlan 41 name lab   VLAN 41 removed                 <- trailing words ignored
sw1#         show vlan 10-12   % show vlan does not take "10-12": every VLAN is listed - the Id column is the VLAN number
```

The row that matters is the first: the sentence is a false claim about IOS. The Catalyst 2960 command
reference says the `vlan` argument is "a single VLAN ID, a series of VLAN IDs separated by commas, or a
range of VLAN IDs separated by hyphens", and the refusal wording for a transposed range is already settled
(`research/vlan-range-order.md`, which quotes that reference; `engine/vlan.js:205-206` is the sentence).

## What is missing or weak, ranked

1. **`vlan <list>` is refused, and told it is not a number.** One token of the parser that already backs
   the trunk door would accept it. (#2269)
2. **`no vlan <list>` is refused the same way**, although the branch's own comment at `engine/cli.js:1522-1525`
   reasons about a range ("`no vlan 2-1024` yields 1002, 1003, 1004, 1005 ... which is what per-id commands
   here produce anyway") and `research/default-vlan-refusal-wording.md:23` records that transcript — the
   code describes a behaviour it cannot reach.
3. **A named list has no answer.** `vlan 10-12 name lab` never parses today; once it does, whether one name
   lands on three VLANs is a modelling decision (the vendor's `name` lives in config-vlan sub-mode, which
   `docs/CLI.md:3767` says this console does not have).
4. **`no vlan 41 name lab` acts on the id and ignores the tail** — the same family as #1694, with a word
   instead of the `?`.
5. **`show vlan id <list>` does not exist** as a form (`show vlan 10` is refused, `:6500`), so a lab cannot
   ask about one VLAN without reading the whole table. New surface.
6. **running-config never folds a range.** `show vlan` prints `10-12` (`formatVlanList()`), the config prints
   three lines. Left alone deliberately: no capture found shows how a box folds `vlan` lines, and a wrong
   fold breaks `config-roundtrip`.

## Ordered steps

1. **`vlan <list>` accepts commas and ranges** (M). In the `vlan` branch (`engine/cli.js:1354-1411`) replace
   the `_vlanIdRefusal(tokens[1], …)` gate with `parseVlanList(tokens[1])` and act per id: VLAN 1 keeps its
   existing "already exists" line, each media default keeps `% VLAN id 1002 is reserved: …`, each ordinary id
   gets its own `VLAN <n> created (name: VLANNNNN)` line. Two refusals stay single and fatal: a backwards
   range (`% VLAN range 20-10 runs backwards: give the lower id first (10-20)`, already written at
   `engine/vlan.js:205`) and `all`. A list is one token, so the optional-name form at `:1361` is untouched —
   whitespace is *not* a separator here, or `vlan 50 60` stops being a name. Closes #2269.
2. **`vlan <list> name <text>`** (S, **needs Jay's approval**). One name onto every id in the list, or a
   refusal naming the per-id form. Recommendation: apply to all, because the vendor's submode covers the
   whole list and the console has no submode; but it is a form no capture shows in one line, so it is Jay's
   call. Whichever way, the 32-character limit (`engine/cli.js:1398-1405`) and the `?` refusal (`:1396`) must
   hold for every id, with nothing created on a refusal.
3. **`no vlan <list>`** (M). Extract the body at `engine/cli.js:1494-1608` into `_removeVlan(id)` returning
   lines, then loop the parsed list. Decision for the step: **validate every id first and act only if all
   pass** — an atomic line, because a half-deleted range with a trunk-carrier refusal in the middle is a
   config no operator can see. Print one line per id on success, in ascending order.
4. **`no vlan <id> <extra words>` is refused** (S). Shape: ``% `no vlan 41 name lab` removes only the VLAN:
   a `no vlan` line takes the id alone``, in the voice of `_noHelpKeyRefusal()` (`engine/cli.js:1166`).
   Nothing is removed.
5. **Docs and CHANGELOG** (S). `docs/CLI.md:223` (`vlan <id> [name] <text>` becomes `<list>`), `:306`,
   `:446`, `:4068`, and the `:154` sentence about `show vlan <id>`; a line in the existing Unreleased
   section, not a new one (#1980).
6. **`show vlan id <list>`** (S, **needs Jay's approval** — new form). `id` is a keyword, the argument a
   list; the rows are the subset of the existing table, `show vlan id 9999` answers `% VLAN 9999 does not
   exist`. Adding the form bumps the counts PR #2268 is rewriting (`test/docs-show-commands.test.js:11`), so
   it lands after that merges.

**Deliberately left out:** running-config folding (no capture); `switchport access vlan` / `native vlan` /
`voice vlan` staying single-id, which is what a port command takes; VTP and the extended-range creation rule
(`research/extended-vlan-creation-vtp.md` — a feature decision, not a fidelity fix); whitespace-separated
lists; a `vlan` sub-mode.

## Risks

* **A list is not a keypress.** `vlan ?` must keep refusing as a value (`engine/cli.js:1141`) and `vlan` with
  no argument must keep its `% Incomplete command`; the `docs-show-commands` sweep and
  `test/help-key-is-not-a-value.test.js` both read that.
* **`test/stated-range-is-the-enforced-range.test.js` probes `vlan <id>` at 0, 1, 4094, 4095.** Those four
  answers must not move: `0`/`4095` still refuse with the range quoted, `1` still refuses as default.
* **Partial application.** Steps 1 and 3 must leave the device unchanged when any id in the list is refused,
  or a typo in a range half-configures a switch.
* **PR #2268 is open on the same file.** It rewrites the form counts in `docs/CLI.md` and
  `test/docs-show-commands.test.js:11`; step 5 touches prose nearby, and step 6 must rebase after it.
* **`config-roundtrip`** replays the running-config, and a list creates N VLANs from one line — the round trip
  is per-id lines out, list in, which is stable only if step 1 is idempotent for ids that already exist.

## Test strategy

New: `test/vlan-list-argument.test.js` (comma list, range, mixed, `1` inside a list, a media default inside a
list, backwards range, `all`, idempotent re-type, name form still single-token). Extend
`test/vlan-id-argument.test.js` (#1409's guard) with the list shapes. Existing suites that must stay green:
`test/vlan.test.js`, `test/stated-range-is-the-enforced-range.test.js`, `test/config-roundtrip.test.js`,
`test/config-completeness.test.js`, `test/config-undo.test.js`, `test/help-key-is-not-a-value.test.js`,
`test/docs-cli-transcript.test.js`, `test/help-completeness.test.js`, the `trunk-allowed*` suites, and
`test/docs-show-commands.test.js` for step 6. `node test/vlan.test.js` + `node test/cli.test.js` before every
push.

## Issues this would close

**#2269** (step 1). #2268 is the open count PR that step 6 collides with, not a close. #2270 and the two
device requests are catalogue work and untouched.
