# Plan: the OSPF Hello pair is a box-wide number no command can type, and the port carrying it cannot print it

Status: forward plan, no code. Measured on `ae87bec9`, 2026-11-27, with a two-router probe lab (`ISR 4331`
each end, one cable, `10.0.12.0/24`) driven through `CliSession`. Closes **no** open issue: the queue holds
#1640 (an IPv6 RA `no` form) and #30 (one upstream port on the cloud). It is the fix for a limitation
`docs/CONVERGENCE.md:60-70` already concedes - "Only **one** of the seven can be changed from the console
today [...] A fixture can set them; a technician cannot." No step needs Jay's approval: `ip ospf
hello-interval` and `ip ospf dead-interval` are commands every OSPF box has.

The engine already refuses an adjacency whose Hello intervals disagree (RFC 2328 10.5, `simulator.js:1505`),
and `show ip ospf neighbour` counts a `Dead Time` down from the interval. Both numbers arrive as
`config.ospf.helloSec` / `deadSec` - box-wide keys nothing in `engine/cli.js` writes - so the one rule that
decides whether two routers become adjacent cannot be exercised from the console at all. The suite that tests
it writes the object behind the console's back, and its comment admits the command it cannot type:

```js
r2.config.ospf.helloSec = 5;    // "`ip ospf hello-interval 5` on r2 alone" - test/ospf-timer-mismatch.test.js:80
r2.config.ospf.deadSec = 20;
```

Measured in the lab, on the port that carries the adjacency:

```
r1(config-if)# ip ospf hello-interval 5
% Usage: ip ospf cost <n> | ip ospf area <id> | ip ospf priority <0-255> | ip ospf passive
r1> show ip ospf interface
Interface   IP Address       Area  Cost  Cost from   Pri Adjacent  Passive
Gi0/0/0     10.0.12.1/24     0     1     link rate   1   yes       no
r1> show ip ospf neighbour
Neighbor ID     Pri   State           Dead Time   Address         Interface
2.2.2.2           1   FULL/DR         00:00:40    10.0.12.2       GigabitEthernet0/0/0
r1> show running-config         -> ospf router-id 1.1.1.1 / ospf area 0, and no timer line
```

## What exists today

| fact | evidence |
|---|---|
| the pair is two box-wide keys | `ospfTimers()` `engine/convergence.js:67-79`; defaults `:34-35` |
| the RFC mismatch rule is implemented on both ends, with both pairs recorded | `engine/simulator.js:1505-1520`; refusal `engine/cli.js:5967-5970` |
| `Dead Time` is that interval, counting down per neighbour | `_ospfDeadTimeCell()` `engine/cli.js:5916-5926` |
| the console refuses both words, naming the four verbs it has | `_ipOspf()` `engine/cli.js:3682`, usage `:3750` |
| `router ospf` takes a router id and an area, nothing else | `_ospfConfig()` `engine/cli.js:3632`, usage `:3679` |
| a per-port OSPF override exists and holds four fields | `engine/cli.js:3682`; printed back `:8543-8551` |
| a timer rule exists and no code path runs it on a device | `validateRouter()` `engine/ospf.js:158-181`; only caller `test/ospf.test.js:172` |
| neither the browser nor the API names these keys | zero hits for `ospf` under `web/` and `server/` (measured) |
| the gap is documented twice, and denied once | `docs/CONVERGENCE.md:60-70`; `docs/CLI.md:323`; `docs/SIMULATION.md:427` still says "no hellos, no dead timer" |

## What is missing, ranked

1. **The command.** The pair is unreachable from the surface a lab is built on; the refusal, the countdown and
   the RFC citation are all tested through a hand-written object.
2. **One number for the box, not one per port.** RFC 2328 10.5 compares the received Hello against "the values
   configured for the receiving interface". A 5 s WAN port beside 10 s LAN ports cannot be expressed, and
   `show ip ospf interface` has no per-port number to print even if it wanted one.
3. **`dead` does not follow `hello`.** IOS derives the dead interval as four times the hello when only the hello
   is set, so `ip ospf hello-interval 5` sends 5/20. Here `deadSec` defaults to 40 regardless (`:75`), so the
   same intent sends 5/40 and is refused by a peer configured from the same page - the `Dead R 40 C 60` shape
   the suite's header quotes, produced by configuration rather than by a mistake.
4. **Invisible where it matters.** No `Hello`/`Dead` column in `show ip ospf interface`, no line in
   `show running-config` for a value that is set (measured), so the operator sees the number only inside a
   refusal sentence, after the adjacency has already failed.
5. **The rule is only a test.** `deadSec` below `helloSec`, or `helloSec: 2.5`, loads silently; `validateRouter`
   says `BAD_TIMERS` and nothing calls it on a device config.

## Ordered steps

One PR each, in this order; the tree is green after each.

1. **S - the two verbs, on a port.** `ip ospf hello-interval <1-65535>` and `ip ospf dead-interval <1-65535>`
   under `interface`, with `no` forms that restore 10 and 40 for **that one field** and leave the sibling and
   the rest of the `{name, cost, area, priority, passive}` entry alone - the shape #1640 records the IPv6 RA
   code getting wrong. Refuse 0, a non-integer, `>65535`, and `dead < hello`, in the console's words. Print
   both lines in the interface block at `engine/cli.js:8543-8551`. Touch: `_ipOspf()` (dispatch `:3044`),
   the running-config block, `docs/CLI.md:323`, new `test/ospf-timer-command.test.js`.
2. **S - the pair is per endpoint.** `ospfTimers(dev, ifaceName)` reads the port's override, then the box key,
   then the default; `simulator.js:1505-1520` passes `l.a.iface` / `l.b.iface` (already in hand) and keeps
   recording both pairs; `_ospfDeadTimeCell()` takes the port the neighbour is on, and the refusal at `:5967`
   says "this port" with the port's pair. Rewriting `test/ospf-timer-mismatch.test.js:80-81` to type the
   command instead of assigning the object is the acceptance test for steps 1-2: same refusals, same
   sentences, one surface.
3. **S - dead follows hello.** When `deadSec` is absent, derive it as four times the hello and keep an explicit
   dead interval authoritative, in both floors - `convergence.js:75` and `ospf.js:171-181`. No shipped lab sets
   `helloSec` (zero hits under `examples/`), so nothing measured moves; pin the arithmetic in
   `test/convergence-timing.test.js` and one four-times case in the new suite.
4. **S - the view.** `Hello` and `Dead` columns in the `show ip ospf interface` table (`engine/cli.js:6204`),
   from the same effective pair; the single-port form prints the one vendor line the model can state
   (`Timer intervals configured, Hello 10, Dead 40`) and stops where Wait/Retransmit are unmodelled.
5. **S - the rule reaches the config.** Call the timer half of `validateRouter()` where a device config is
   applied on load or import, so `BAD_TIMERS` is a sentence at the door instead of an interval nobody chose.
   Find the import path first (`server/` has no `ospf` reference); if no single choke point exists, publish
   `validateTimers()` from `engine/ospf.js` and call it from the loader, not the CLI.
6. **S - docs.** `docs/CLI.md:323` and the grammar table (four verbs become six); `docs/SIMULATION.md:427`
   ("no hellos, no dead timer" is doubly false); `docs/CONVERGENCE.md:60-70` (one of seven becomes two of
   seven); `test/docs-show-commands.test.js` if a new form is typed at a switch.

## Risks and tests

- **Phrase-pinned tests.** `test/ospf-timer-mismatch.test.js` matches `/Hello 5 s \/ Dead 20 s/` and
  `RFC 2328 10.5`; step 2 must keep both pairs in the sentence, only re-attributing the near one to a port.
- **Which number the countdown uses.** RFC 2328 sets a neighbour's dead timer from the received Hello and this
  model has no live state. Adjacency requires equal pairs, so the two agree whenever a row exists; say that in
  the comment rather than implying they are interchangeable.
- **Two readers of one number.** `convergence.ospfTimers` feeds both the adjacency schedule and the console
  cell; a per-port signature must not leave a third copy. Two source files read `helloSec` today - keep it two.
- One suite per step (`ospf-timer-command`, `ospf-timer-per-port`, `ospf-dead-derived`), plus the rewritten
  mismatch suite as the regression gate; full `npm test` and `npm run syntax` before merge.

## Intentionally out of scope

`router ospf <pid>` (one unnamed process, `docs/CLI.md:2129`), `ip ospf network`, area authentication and
stub/NSSA areas, and the other five convergence keys `docs/CONVERGENCE.md:60-70` names (`stpForwardDelaySec`,
`stpMaxAgeSec`, `ospf.exchangeSec`, `ospf.spfDelaySec`, `dhcpExchangeSec`) - each wants its own plan, and
STP's two need a `show spanning-tree` that prints timers before a command to set them is worth having.
