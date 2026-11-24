# Plan: the NAT table is built once and never rebuilt, so a rule the console removed keeps translating

Status: forward plan; step 1 has landed (see the change note at the end of this file). Measured on `b9ecb8c6`,
2026-11-23; opened as #2465. Every step below repairs a surface that
already exists; nothing here adds a translation type. Scope: `engine/simulator.js` (one method), `engine/nat.js`
(the rule shape and one rewrite), `engine/cli.js` (`_natConfig`, `_help()`, one new EXEC word), `docs/CLI.md`,
`docs/SIMULATION.md`, three new suites.

Distinct from `docs/plans/counter-reset.md` (which proposes the `clear` EXEC word this plan's step 5 needs) and
from `docs/plans/acl-binding-path.md` (a binding nothing evaluates - here the binding *is* evaluated, against a
copy taken before the operator edited it).

## What exists today

**The model is real, and it is in the data path.** `engine/nat.js` (908 lines) does static, dynamic and PAT in
both directions; `translateOutbound()` (`:724`) and `translateInbound()` (`:758`) are called from the forwarding
loop at `engine/simulator.js:4746` / `:4780`. Seven suites, 1,490 lines, pin it.

**The table is created once, from the config, and then frozen.** `_natTableOf()` (`engine/simulator.js:4666`)
returns early when `dev.natTable` already exists (`:4667`); the rule set is copied in exactly once:

```js
if (!dev.natTable) { ... table.rules = ((cfg.rules || ...) || []).slice(); ... dev.natTable = table; }
```

Nothing else assigns `table.rules` (`grep -rn "table.rules" engine/` has three hits: this one and the two
readers). So the snapshot is taken at the first packet that needs translating and never refreshed.

**The console edits the config, and reports success.** `_natConfig()` (`engine/cli.js:6123`) validates every rule
with `natLib.validateRule()` and writes `config.nat.rules` / `config.nat.pools`; `no ip nat inside source`
(`:1640-1646`) removes the last rule and prints `NAT rule removed: ip nat inside source ...`.

**Reading is honest, and reads the frozen table.** `show ip nat translations | rules | statistics`
(`engine/cli.js:6580-6668`) print from `dev.natTable` via `_natTableAt()` (`:1259`). `show running-config`
prints pools then rules (`:7875-7882`); a board copies `config.nat` verbatim (`engine/device.js:1694-1695`) and
restores it (`:1752-1754`).

**The timeouts are a live input with no writer.** `expireTranslations(dev.natTable, cfg.timeouts, ...)` runs on
every lookup (`engine/simulator.js:4679`) and `show ip nat statistics` prints the five values from
`natCfg.timeouts` (`engine/cli.js:6655-6663`). No command writes `config.nat.timeouts`; the three ageing tests
set it by hand on the device object (`test/nat-ageing.test.js:129`,
`test/nat-dns-translation-timeout.test.js:155`, `test/nat-translations-total.test.js:89`).

**A static port forward carries one port, used on both sides.** The rule shape holds one `port`
(`engine/nat.js:296`); `recordStatic()` writes `localPort: pin, globalPort: pin` (`:584-585`); the inbound rewrite
is `p.dstPort = rule.port` (`:767`).

## What is missing or weak, ranked

1. **A rule edited after the first translation has no effect.** Add `ip nat inside source` to a box that has
   already translated once and it never fires; remove it and the box keeps translating, while the console prints
   `NAT rule removed`. The data path and the console disagree, and the console is the one that is wrong.
2. **The override the docs promise has no door.** `docs/SIMULATION.md:351` says the timeouts are "overridable in
   `config.nat.timeouts`". Only a hand-edited board file can do that, `show running-config` never prints it, and
   a save/replay therefore resets it - the one knob a lab needs to watch ageing inside a session.
3. **A port forward cannot move a port.** `tcp 8080` means 8080 outside *and* 8080 inside, so the common
   `203.0.113.5:8080 -> 10.0.0.5:80` lab is inexpressible. The printed spelling `static <local> <global> tcp
   <port>` (`engine/nat.js:formatRuleLine`) is not a vendor form either: IOS writes
   `static tcp <local> <lport> <global> <gport>`, and `docs/CLI.md:240` documents the non-vendor one.
4. **Nothing can empty the table.** There is no `clear` word at all: `EXEC_WORDS` (`engine/cli.js:185-198`) is
   enable/configure/converge/show/ping/link/links/traceroute/exit/logout/quit/help. The only reset is replacing
   the board.
5. **Counters are kept and never read.** `touch()` increments `entry.hits` (`engine/nat.js:407`), and the
   simulator counts expired entries into `this._natExpired` (`:4680`); neither is printed anywhere. Pool
   utilisation (addresses in use) is absent from `show ip nat statistics`.
6. **The help index has no NAT line, config or views**, and the guard cannot see it: `_help()`
   (`engine/cli.js:8312`) names `show ip dhcp`, `show ip dns`, `show vrrp`, `show ip ospf`, `show ip bgp` and
   nothing for NAT; `test/help-completeness.test.js:72-79` derives its vocabulary from `head === '<word>'`, and
   NAT lives under `head === 'ip'` (`:1461`, `:1468`), so a whole feature can be missing with that suite green.

## Ordered steps

**1. Rebuild the rule set on every lookup (S).** In `_natTableOf()`, assign `table.rules` from
`cfg.rules`/`cfg.portForwards` on every call, before ageing - a shallow copy of the config's own rule objects, so
nothing in `nat.js` can mutate config. Keep `table.translations` untouched: a removed rule stops translating new
packets, and the entries it made stay until they age out or are cleared (step 5), which is what a box does.
New `test/nat-rule-reload.test.js`: add-after-traffic fires, remove-after-traffic stops, the reverse direction
stops too, an existing static entry survives the removal, and the no-traffic case still creates no table.

**2. Console: `ip nat translation timeout <seconds>`, and the four per-protocol forms (S).** `timeout`,
`tcp-timeout`, `udp-timeout`, `icmp-timeout`, `dns-timeout` in `_natConfig` beside the pool form (`:6143`);
`no` forms in the table at `:995-996`; `show running-config` prints the non-default lines before the rules
(`:7875`), so a replay reproduces them. `show ip nat statistics` already reads the field - no change there, and
its existing test (`test/nat-ageing.test.js:162`) becomes reachable from a console. New
`test/nat-timeouts-cli.test.js`: a set timeout changes when an entry disappears, `no` restores the published
default, and the round trip through the device document (`test/nat-cli.test.js:160-175` pattern) keeps it.

**3. Help index and the guard's blind spot (S).** Two lines in `_help()` - the `ip nat pool` / `ip nat inside
source` family and `show ip nat (rules | translations | statistics)` - plus the same row in the `show` table of
`docs/CLI.md`. Then add a sub-verb list to `test/help-completeness.test.js` (a hand-written list of the
`<head> <sub>` pairs that are mechanisms: `ip nat`, `ip dhcp pool`, `ip dns zone`, ...) and require each to be
named, so the next feature cannot hide under `head === 'ip'`.

**4. Static port remap in the vendor grammar (M).** Rule shape gains `globalPort` (`engine/nat.js:296`);
`recordStatic()` keeps the two distinct (`:584-585`); `findStaticInbound()` matches on `globalPort` (`:549`) and
`translateInbound()` rewrites to `localPort` (`:767`). CLI takes `static tcp <local> <lport> <global> <gport>`
and keeps the old one-port form as an alias that sets both; `formatRuleLine()` prints the vendor form, which
changes `show running-config`, `show ip nat rules` and the `no` receipt together. Boards carrying a rule with
only `port` must load: `normalizeRule()` treats a missing `globalPort` as equal to `port`. Docs in the same PR:
`docs/CLI.md:240` and the `docs/SIMULATION.md:346` "Port forwarding" row.

**5. `clear ip nat translation [* | <inside-local> | <inside-global>]` (S) - depends on step 2 of
`counter-reset.md`.** That plan lands the `clear` word in `EXEC_WORDS`; whichever PR is second rebases. One
library function `clearTranslations(table, match)` in `engine/nat.js`, one arm in the exec chain beside `ping`,
and the receipt counts what went. Whether the box asks `[confirm]` is the same open question counter-reset
already carries (`research/clear-counters-wording.md`); do not guess it a second time.

**6. Print the counters that are already kept (M).** `Expired translations: <n>` from `sim._natExpired`, pool
utilisation as `used/total` per pool from the live entries, and lifetime `Hits`/`Misses` on the table (a counter
on `natTable`, incremented in `translateOutbound`'s `translate`/`pass` returns). Do **not** add a hits column to
`show ip nat translations`: the five columns are research-pinned (`research/show-ip-nat-translations-columns.md`)
and the `verbose` refusal at `engine/cli.js:6597` is deliberate.

## Risks

- **Step 1 changes the data path for every lab with a live table.** That is the fix, but any suite that relies on
  the frozen snapshot will flip. Run all seven NAT suites plus `test/counters-agreement.test.js` before pushing.
- **Rules re-read per packet.** A shallow copy per forwarding decision is cheap at lab sizes, but it must not
  deep-clone (pools of 1,024 addresses are allowed) and must not mutate the rule objects `nat.js` receives.
- **Step 4 rewrites a line three views print.** `formatRuleLine()` feeds running-config, `show ip nat rules` and
  the removal receipt; `test/nat-cli.test.js:147` and `:151` quote the old spelling, so they change in that PR
  with the docs. The back-compat path (no `globalPort`) is the thing to test first.
- **The timeout range is not sourced yet.** The IE9300 page shows `ip nat translation 300` but not the keyword
  ranges. If the Cisco command reference cannot be read in the same sitting, step 2 lands with a research note
  under `research/` and a range of 1-86400 proved by the two defaults, rather than an invented bound.
- **Two workers, one line of `EXEC_WORDS`.** Step 5 and counter-reset step 2 both add `clear`. Sequence them; do
  not let the second PR renumber the first.
- **A removed rule leaves entries behind.** Chosen deliberately in step 1; if a reader expects `no ip nat inside
  source` to also drop the table, the docs must say otherwise, and the test names which way it goes.

## Test strategy

- New: `test/nat-rule-reload.test.js` (step 1), `test/nat-timeouts-cli.test.js` (step 2),
  `test/nat-port-remap.test.js` (step 4 - `203.0.113.5:8080` reaching an inside server on `:80`, and the reply
  rewritten back).
- Extended: `test/nat-cli.test.js` (clear receipt, running-config round trip), `test/nat-ageing.test.js`
  (timeouts now set through the console, not the object), `test/help-completeness.test.js` (sub-verb list).
- Library-level cases go in `test/nat.test.js`; every console case uses the two-device probe lab the NAT suites
  already build (`test/nat-cli.test.js:100-118`).
- The gate is the seven existing suites plus `counters-agreement`, unchanged.

## Issues this would close

None. The queue is empty of issues; the only open item is PR #2452 (Teltonika PoE data), which is unrelated.
#130 and #803 are closed.

## Deliberately left out

- `ip nat outside source`, `ip nat inside destination`, rotary pools, twice-NAT, hairpinning, ALGs - new
  translation directions, listed **Absent** at `docs/SIMULATION.md:352`. They need Jay's approval and a research
  note before a step exists.
- `show ip nat translations verbose` - the refusal at `engine/cli.js:6597` is research-pinned and stays.
- A hits column in the translation table (breaks the five-column evidence).
- An HTTP endpoint to read or clear NAT state from the browser; the console is the only client today.

## Change note

- 2026-11-23, step 1 (#2465). `_natTableOf()` re-reads `table.rules` from `config.nat` on every lookup, and
  `natLib.pruneStaticTranslations()` drops a static entry whose rule has gone. The prune was not in the plan and
  the plan's own "keep `table.translations` untouched" could not hold for static rules: `expireTranslations()`
  never ages a static entry out (the rule is what keeps it alive), so a removed port forward went on reversing
  outside packets to a host whose replies now left unreaddressed - half a translation per flow, which is the
  half-config the issue is about. Dynamic and PAT entries, which are state, still serve out their timeout.
  `test/nat-rule-reload.test.js`, 25 assertions. Steps 2-6 are untouched.
