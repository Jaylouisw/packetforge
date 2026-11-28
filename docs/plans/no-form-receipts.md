# Plan: a `no` that changes nothing, and says otherwise

Status: forward plan, no code. Measured on `2cdb443e`, 2026-11-28, with a probe lab built on
`Topology`/`Simulator`/`CliSession`. Closes **#1685**. The queue holds one open issue and this is it.
Scope: seven `no` branches in `engine/cli.js`, one shared receipt helper, `test/no-form-receipts.test.js`,
the VRRP transcript in `docs/CLI.md`, and the sentence in `research/vrrp-no-form-scope.md` that quotes it.
No election, forwarding or printer change.

Distinct from `docs/plans/undo-granularity.md` (what a `no` line *does* - its VRRP half landed 2026-11-18
and gave `no vrrp <vrid> priority|preempt|timers advertise` their own branches). This plan is about what
those branches *say*, and about the other families that restore a default the same way.

## What exists today

**The shape done right, three times, in three different wordings.** A `no` over a value already at the
default refuses in a `%` line and says nothing moved:

| branch | evidence | when the value is already the default |
|---|---|---|
| `no switchport ...` | `_switchport()` `engine/cli.js:4175`, `:4188`, `:4196` | `% Fa0/1 already has default switchport settings (access VLAN 1)` |
| `no spanning-tree priority` | `:1891` | `% No bridge priority set: the device is using the default 32768` |
| `no ipv6 nd ra lifetime` | `:3581`, `:3598` | `% No router lifetime set on Router-d1 (it is the default, 1800s)` |

`docs/CLI.md:3665` states the rule for switchport - "refuses when the value is already the default" - and
`docs/CLI.md:3697` shows the sentence ending "nothing changed".

**The branches that write the receipt before reading the value.** Each assigns a default or deletes a key,
then returns one fixed sentence, without looking at what was there:

| command | evidence | receipt, unconditionally |
|---|---|---|
| `no vrrp <vrid> priority` | `:2911-2912` | `VRRP group 10 priority reset to 100` |
| `no vrrp <vrid> timers advertise` | `:2917-2918` | `VRRP group 10 advertises every 1 s` |
| `no vrrp <vrid> preempt` | `:2907-2908` | `VRRP group 10 preempt disabled` |
| `no ip ospf cost` | `:3873` | `OSPF cost reset on Gi0/0` |
| `no ip ospf area` | `:3880` | `OSPF area reset on Gi0/0` |
| `no speed` (calls `_speed(['auto'])`) | `:3215`, receipt `:3989` | `Speed auto-negotiation on Gi0/0` |
| `no duplex` (calls `_duplex(['auto'])`) | `:3237`, receipt `:4067` | `Duplex auto (full) on Gi0/0` |

Measured on a fresh group (`vrrp 10 ip 10.0.0.254`, nothing else set) and on a fresh `Gi0/0`:

```
(config-if)#no vrrp 10 priority            VRRP group 10 priority reset to 100
(config-if)#no vrrp 10 priority            VRRP group 10 priority reset to 100   <- again
(config-if)#no vrrp 10 timers advertise    VRRP group 10 advertises every 1 s    <- already 1 s
(config-if)#no vrrp 10 preempt             VRRP group 10 preempt disabled
(config-if)#no vrrp 10 preempt             VRRP group 10 preempt disabled        <- again
(config-if)#no ip ospf cost (unset)        OSPF cost reset on Gi0/0              <- never set
(config-if)#no ip ospf area (unset)        OSPF area reset on Gi0/0              <- never set
(config-if)#no speed                       Speed auto-negotiation on Gi0/0       <- already auto
```

Two of the seven are worse than cosmetic: `no ip ospf cost` and `no ip ospf area` are the keystroke that
asks "is this value mine or inherited?", which is the question the operator most needs a true answer to.

**The one branch that half-solved it, differently.** `no ip ospf priority` (`:3905-3909`) reads the old
value and appends `(it was already the default)` to a sentence that still says `priority reset to 1`.
Measured: `OSPF priority reset to 1 on Gi0/0 (it was already the default)`. A reader skimming sees a
change; nothing asserts this string, so it is free to converge.

**The docs reproduce the lie.** `docs/CLI.md:4205-4213` is a transcript over a freshly created group: all
three VRRP lines are no-ops and all three claim a change. `research/vrrp-no-form-scope.md:42` quotes the
same sentences as if they were the console answering.

## What is missing or weak, ranked

1. **A receipt that reports a change that did not happen (#1685).** Seven branches, one defect: the
   sentence is written before the old value is read. It costs the operator the one signal a simulator is
   supposed to give - whether a line moved the box.
2. **No shared shape.** Three existing refusals word the same fact three ways, and the OSPF-priority
   branch invented a fourth (a parenthetical hung on a change sentence). A per-branch fix would make five.
3. **The docs teach the wrong transcript**, so a reader who compares the console to `docs/CLI.md` cannot
   tell a fresh group from a configured one.

## Ordered steps

1. **One receipt helper (S).** A small `_nothingChanged(text)` next to `_capabilityRefusal()`
   (`engine/cli.js:1599`), returning `'% ' + text + ' - nothing changed'`, so the family borrows the
   switchport / `ra lifetime` phrasing instead of inventing a fifth. Pure addition, no call site yet.
2. **VRRP's three words (S).** Read the value first in the `no vrrp` branch (`:2877-2929`): `priority`
   against `VRRP_DEFAULT_PRIORITY`, `timers advertise` against `VRRP_DEFAULT_ADVERT_SEC`, `preempt`
   against `true`. A real change keeps today's sentence byte for byte - the assertions at
   `test/vrrp-no-form.test.js:65`, `:73`, `:78` all come from a group moved off the default, so they must
   not move - and a no-op answers `% VRRP group 10 priority is already the default (100) - nothing
   changed`. Closes #1685.
3. **OSPF cost and area (S).** `:3873` / `:3880`: test `ov.cost == null` and `ov.area == null` before
   deleting. The no-op sentence names what the box uses instead - the link-rate cost (`costForSpeed`,
   `engine/ospf.js:129`) and the router-level area - because "reset" with no number is what misled. Fold
   `:3905`'s parenthetical into the same helper so the three OSPF words agree.
4. **`no speed` / `no duplex` (S).** Guard inside `_speed()` `:3935` and `_duplex()` `:4035`, where the old
   `speedMbps` / `duplexMode` is in hand, rather than in the dispatch at `:3215` / `:3237`: one guard then
   also covers a bare `speed auto`, and the dispatch keeps its trailing-word refusals untouched.
5. **The docs (S).** Rewrite `docs/CLI.md:4205-4213` so the transcript shows one real change and one
   no-op, state the rule once beside the switchport rule (`:3665`), and correct
   `research/vrrp-no-form-scope.md:42`.
6. **One table-driven suite (S).** `test/no-form-receipts.test.js`: rows of (setup, command, expected
   receipt, expected stored value) over all seven branches, each twice - moved off the default and already
   at it - plus the typed-twice cases from the issue.

## Tests and risks

- **Assertion collision.** Two suites assert these strings - `test/vrrp-no-form.test.js:65,73,78` and
  `test/vrrp-timers-advertise.test.js:78,165` - and every one of those cases configures the value away from
  the default first (checked line by line), so steps 2-4 must leave the change sentence alone; the step-6
  table pins both halves.
- **Round trip.** No printed line is affected: the printer emits `no vrrp <vrid> preempt` only when
  `preempt === false` (`:8833`), `ip ospf cost` only when `ov.cost != null` (`:8805`), and `speed` /
  `duplex` only when forced (`:8717-8721`). A `no` line the printer writes is never the no-op case, so
  `test/config-roundtrip.test.js` should stay green; step 6 adds a paste-back check anyway.
- **`%` is not an error channel.** `POST /config/:devId` streams the lines and derives no status from them
  (`server/index.js:1089-1108`), so a `%` receipt is text, not a failed request, and the web console
  already colours `%` lines. No API change.
- **Do not over-reach.** Bare `no vrrp <vrid>` still removes the group with its sentence, and a word the
  branch cannot unset keeps its `% Unrecognized` refusal.

**Left out deliberately:** duplicate-route work (`docs/plans/static-route-statement.md`), VRRP tracking and
failover (`docs/plans/vrrp-track.md`), `no ip name-server` and the other branches that already answer
"nothing was removed", and any change to what a `no` line does - that is the rest of
`docs/plans/undo-granularity.md`.
