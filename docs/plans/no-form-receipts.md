# Plan: a `no` that changes nothing, and says otherwise

Status: partly landed. The three VRRP words shipped in `8903de01` (#1688); the four other branches still
write their receipt before reading the value. Re-measured on `beb298af`, 2026-11-28, with a probe lab built
on `Topology`/`Simulator`/`CliSession`. **#1685** is closed (2026-11-28T03:43:54Z). Scope: seven `no` branches
in `engine/cli.js`, one shared receipt helper, `test/no-form-receipts.test.js` - the VRRP transcript in
`docs/CLI.md` and the sentence in `research/vrrp-no-form-scope.md` that quoted it were corrected with the
VRRP half. No election, forwarding or printer change.

Distinct from `docs/plans/undo-granularity.md` (what a `no` line *does* - its VRRP half landed 2026-11-18
and gave `no vrrp <vrid> priority|preempt|timers advertise` their own branches). This plan is about what
those branches *say*, and about the other families that restore a default the same way.

## What exists today

**The shape done right, four times, in four different wordings.** A `no` over a value already at the
default refuses - or, in the VRRP family, states - and says nothing moved:

| branch | evidence | when the value is already the default |
|---|---|---|
| `no switchport ...` | `_switchport()` `engine/cli.js:4152`, refusal `:4243` | `% Fa0/1 already has default switchport settings (access VLAN 1)` |
| `no spanning-tree priority` | `:1891` | `% No bridge priority set: the device is using the default 32768` |
| `no ipv6 nd ra lifetime` | `:3619`, `:3636` | `% No router lifetime set on Router-d1 (it is the default, 1800s)` |
| `no vrrp <vrid> priority\|preempt\|timers advertise` | `:2934-2956` | `VRRP group 10 priority is already 100 (the default), nothing changed` |

`docs/CLI.md:3665` states the rule for switchport - "refuses when the value is already the default" - and
`docs/CLI.md:3697` shows the sentence ending "nothing changed". The VRRP row carries no `%`, because no other
VRRP receipt does: that family answers in plain sentences, and its no-op sentence is plain too.

**The branches that still write the receipt before reading the value.** Each assigns a default or deletes a
key, then returns one fixed sentence, without looking at what was there:

| command | evidence | receipt, unconditionally |
|---|---|---|
| `no ip ospf cost` | `:3941` | `OSPF cost reset on Gi0/0` |
| `no ip ospf area` | `:3948` | `OSPF area reset on Gi0/0` |
| `no speed` (calls `_speed(['auto'])`, `:4003`) | dispatch `:3247`, receipt `:4057` | `Speed auto-negotiation on Gi0/0` |
| `no duplex` (calls `_duplex(['auto'])`, `:4103`) | dispatch `:3258`, receipt `:4135` | `Duplex auto (full) on Gi0/0` |

**The VRRP three, fixed.** `8903de01` (#1688) made each of the three read the value before it writes the
receipt: over a default it reports the state and `nothing changed`, and a `no` that really does restore a
non-default value keeps the sentence it has always had. Probed on a fresh group (`vrrp 10 ip 10.0.0.254`,
nothing else set, `Gi0/0`):

```
r1(config-if)#no vrrp 10 priority            VRRP group 10 priority is already 100 (the default), nothing changed
r1(config-if)#no vrrp 10 preempt             VRRP group 10 preempt disabled
r1(config-if)#no vrrp 10 preempt             VRRP group 10 preemption is already disabled, nothing changed
r1(config-if)#no vrrp 10 timers advertise    VRRP group 10 already advertises every 1 s, nothing changed
```

The first line is the keystroke an operator types to ask whether a setting came from a template, and it now
answers the question instead of claiming a reset. `test/vrrp-no-form-reports-state.test.js` pins both halves;
`test/vrrp-no-form.test.js` and `test/vrrp-timers-advertise.test.js` keep the change sentences, because every
one of their cases moves the value off the default first.

Measured for the four that remain, same lab - `ospf router-id 1.1.1.1` so the OSPF gate is open, a fresh
`Gi0/0`:

```
r1(config-if)#no ip ospf cost               OSPF cost reset on Gi0/0              <- never set
r1(config-if)#no ip ospf cost               OSPF cost reset on Gi0/0              <- again
r1(config-if)#no ip ospf area               OSPF area reset on Gi0/0              <- never set
r1(config-if)#no speed                      Speed auto-negotiation on Gi0/0       <- already auto
r1(config-if)#no duplex                     Duplex auto (full) on Gi0/0           <- already auto
```

Two of the four are worse than cosmetic: `no ip ospf cost` and `no ip ospf area` are the keystroke that
asks "is this value mine or inherited?", which is the question the operator most needs a true answer to.

**The one branch that half-solved it, differently.** `no ip ospf priority` (`:3973-3979`) reads the old
value and appends `(it was already the default)` to a sentence that still says `priority reset to 1`.
Measured: `OSPF priority reset to 1 on Gi0/0 (it was already the default)`. A reader skimming sees a
change; nothing asserts this string, so it is free to converge.

**The docs no longer reproduce the lie.** `docs/CLI.md:4205-4219` sets `vrrp 10 priority 150` and
`vrrp 10 timers advertise 3` before the three `no`s, so each one moves a value, and a second block at
`:4222-4235` records the three no-op answers; `research/vrrp-no-form-scope.md` says the same. When this plan
was written the transcript was taken over a freshly created group, where all three lines were no-ops and all
three claimed a change - #1688 rewrote both pages with the VRRP half.

## What is missing or weak, ranked

1. **A receipt that reports a change that did not happen (#1685).** Four branches remain, one defect: the
   sentence is written before the old value is read. It costs the operator the one signal a simulator is
   supposed to give - whether a line moved the box. Three of the original seven are done.
2. **No shared shape.** The three refusals in the first table word the same fact three ways, the VRRP half
   arrived at a fourth (unprefixed, with the default in brackets), and the OSPF-priority branch invented a
   fifth (a parenthetical hung on a change sentence). A per-branch fix would make six.
3. **Closed by #1688: the docs taught the wrong transcript.** That item is no longer ranked.

## Ordered steps

1. **One receipt helper (S).** A small `_nothingChanged(text)` next to `_capabilityRefusal()`
   (`engine/cli.js:1599`), returning `'% ' + text + ' - nothing changed'`, so the family borrows the
   switchport / `ra lifetime` phrasing instead of inventing a sixth. Pure addition, no call site yet.
2. **VRRP's three words - done** (`8903de01`, #1688, closes #1685). The branch is `:2934-2956`; it reads
   `preempt` against `false`, `priority` against `VRRP_DEFAULT_PRIORITY` and `timers advertise` against
   `VRRP_DEFAULT_ADVERT_SEC`, and the three change sentences are byte-identical to before. It did *not* take
   the shape proposed here (`% VRRP group 10 priority is already the default (100) - nothing changed`): no
   VRRP receipt is prefixed, so the answer is `VRRP group 10 priority is already 100 (the default), nothing
   changed`. `test/no-form-receipts.test.js` in step 6 should pin that wording, not this plan's.
3. **OSPF cost and area (S).** `:3941` / `:3948`: test `ov.cost == null` and `ov.area == null` before
   deleting. The no-op sentence names what the box uses instead - the link-rate cost (`costForSpeed`,
   `engine/ospf.js:137`) and the router-level area - because "reset" with no number is what misled. Fold
   `:3973`'s parenthetical into the same helper so the three OSPF words agree.
4. **`no speed` / `no duplex` (S).** Guard inside `_speed()` `:4003` and `_duplex()` `:4103`, where the old
   `speedMbps` / `duplexMode` is in hand, rather than in the dispatch at `:3247` / `:3258`: one guard then
   also covers a bare `speed auto`, and the dispatch keeps its trailing-word refusals untouched.
5. **The docs - done** (`8903de01`): `docs/CLI.md:4205-4219` shows one real change and one no-op per setting,
   with the no-op block at `:4222-4235`, and `research/vrrp-no-form-scope.md` quotes the shipped sentences.
6. **One table-driven suite (S).** `test/no-form-receipts.test.js`: rows of (setup, command, expected
   receipt, expected stored value) over all seven branches - the four above are the work, the three VRRP rows
   guard what #1688 already fixed - each twice, moved off the default and already at it, plus the
   typed-twice cases from the issue.

## Tests and risks

- **Assertion collision.** Two suites assert these strings - `test/vrrp-no-form.test.js:65,73,78` and
  `test/vrrp-timers-advertise.test.js:78,165` - and every one of those cases configures the value away from
  the default first (checked line by line), so steps 3-4 must leave the change sentence alone; the step-6
  table pins both halves.
- **Round trip.** No printed line is affected: the printer emits `no vrrp <vrid> preempt` only when
  `preempt === false` (`:8901`), `ip ospf cost` only when `ov.cost != null` (`:8873`), and `speed` /
  `duplex` only when forced (`:8787-8791`). A `no` line the printer writes is never the no-op case, so
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
