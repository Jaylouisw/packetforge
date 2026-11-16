# Plan: an access-list binding is only a guard where something evaluates it

Status: forward plan, no code. Reframes #1517, whose reproduction cannot be run against `main` (below).
Touches `engine/simulator.js`, `engine/cli.js`, `test/`, `docs/SIMULATION.md` §5.3, `docs/CLI.md`.
Distinct from `docs/plans/capability-vocabulary.md`: that plan decides which capability token gates
`access-list`; this one is about a binding that is accepted, printed, saved — and consulted by nobody.

## What exists today

Bindings are one map, `dev.aclBindings[ifaceName][dir]`: initialised at `engine/device.js:245`,
written into the save at `:1284`, restored at `:1367`. `ip access-group` writes it at
`engine/cli.js:1994-2002` after exactly two checks — the direction is `in|out`, and the list exists.
Nothing checks that the named interface is one whose traffic is ever tested.

Evaluation has exactly two call sites, and both are keyed by a **physical** interface name:

* ingress — `_aclCheck(dev, inIface, 'in', f)` at `engine/simulator.js:3004`, where `inIface` is
  `peer.iface` handed over by `_deliver` at `:2956`, i.e. a port at the end of a cable;
* egress — `_aclCheck(dev, port.name, 'out', frame)` at `:2793`, and `port` has just been rewritten
  from the subinterface to its parent at `:2783-2792`, under the comment "Outbound access list is
  evaluated on the physical port".

`_aclCheck` itself (`:2596-2612`) agrees with that: it reads one key and returns `permit` when the key
is absent. So a binding on any other name is neither a refused command nor a filter — it is a string
in a map that two lookups can never produce. Subinterfaces are real L3 interfaces (`interface
Gi0/0.10`, `engine/cli.js:571-579`; `encapsulation dot1q`, `:1058-1074`), can hold an address and
route, and are the one interface kind today on which `ip access-group` is accepted and never read.

### Measured on 7e89f959, 2026-11-16

Lab: `generic-pc` — access port VLAN 10 on `generic-switch` — trunk — `generic-router Gi0/0`, with
subinterface `Gi0/0.10` at `10.0.1.1/24`.

| step | result |
|---|---|
| ping pc to 10.0.1.1, no ACL | `success: true` |
| `access-list 101 deny ip any any`, then `interface Gi0/0.10` `ip access-group 101 in` | console `Interface Gi0/0.10: access list 101 applied in`; `bindings {"Gi0/0.10":{"in":101}}` |
| ping pc to 10.0.1.1 again | **`success: true`**, 0 `acl-deny` events |
| same list bound `in` on physical `Gi0/0` instead | `success: false`, 4 `acl-deny` events |
| `show access-lists` | `applied IN on Gi0/0.10` beside `counters: no packet has been tested against this list` — the two lines a healthy lab with no traffic also prints |

Also measured: `interface Vlan20` answers `% Interface not found: Vlan20` on a Catalyst 2960, a
`generic-l3-switch` and a router. No SVI type exists anywhere (no code creates a `Vlan<N>`
interface). #1517's transcript therefore cannot be reproduced as written, and its subject names an
interface the engine does not have.

## What is missing or weak, ranked

1. **A binding on a subinterface filters nothing, in either direction, and reports itself applied.**
   This fails open: a lab that binds `deny ip any any` to a stub subinterface to prove isolation
   passes its own check while nothing is filtered.
2. **#1517 bundles two different things**: (a) bindings on a logical interface are inert — a defect,
   fixable here; (b) there is no SVI at all — a new interface type, and a feature decision.
3. **Nothing distinguishes "no traffic yet" from "nothing looks at this"**: both print zero counters,
   and the binding line at `engine/cli.js:3753-3754` prints any key in the map without asking whether
   the resolver can ever produce that key.
4. **No test binds an ACL anywhere but a physical port** (`test/acl-data.test.js:56, 100, 116, 141`;
   `test/config-undo.test.js:143`), so the suite cannot catch this class as it stands.
5. **Docs drift, plus one wrong sentence.** `docs/SIMULATION.md:322` is right but cites
   `engine/simulator.js:1792` and `:1688-1697`, both stale (:3004 and :2783-2793 today), and says
   "bound per interface" without saying a binding on a non-port is inert. `docs/CLI.md:1995-2001`
   says `encapsulation dot1q` **and** `ip access-group` "refuse a physical port" — `ip access-group`
   accepts one (measured above); only `encapsulation` refuses it.

## Ordered steps

| # | step | size | closes |
|---|---|---|---|
| 1 | Ingress: resolve the logical ingress interface in `_processFrame` — the subinterface of `inIface` whose `encapVid` equals the frame's `vid` — and test it before the port; a denial names the interface whose list denied. Regression: the table above (deny on `Gi0/0.10 in` stops the ping; the parent-port case stays at 4 events, not 8). | S | #1517 (a) |
| 2 | Egress: the same resolution in `_emitFrame`, before the collapse at `:2783`, so `out` on a subinterface is tested on the traffic that leaves it while the parent's own list is still tested. | S | — |
| 3 | One resolver for both directions (`_aclTargets(dev, portName, vid)` returning names most-specific-first) so they cannot drift, with the order written where the code reads it: inbound parent-then-child, outbound child-then-parent. A test per direction. | S | — |
| 4 | Console truthfulness: `show access-lists` binding lines and `show running-config` mark a binding whose interface the resolver cannot produce `(no evaluation path)` instead of `applied IN on …`. This is what catches the next interface kind (an SVI, a LAG logical port) rather than assuming steps 1-3 covered everything. | S | 2, 3 |
| 5 | Guard test: walk the interface kinds the CLI can create on one spec (physical, subinterface) and for each, both directions, assert the binding either denies traffic or the command is refused. Counter check: one packet, one hit per list, never two. | M | 3, 4 |
| 6 | Docs: rewrite the §5.3 row with current line numbers and the precedence order; add the precedence sentence to the `docs/CLI.md` ACL section; fix `docs/CLI.md:1995-2001`. | S | — |
| 7 | **needs Jay's approval** — SVI: `interface Vlan<N>` as an L3 interface bound to a VLAN, which is what #1517's title asks for; the resolver from step 3 must then include it, because a bridged frame on a switch has no other logical ingress. If declined, retitle #1517 to the subinterface defect and close it with steps 1-2. | M | #1517 (b) |

## Risks

- **Precedence is a claim, not a measurement.** Two lists in the same direction on parent and child
  can both be "right"; state the IOS order (inbound: physical then subinterface; outbound:
  subinterface then physical) as a modelled choice, with one test per direction so a future
  reordering is visible rather than silent.
- **Double counting.** `_countAclHit` tallies inside `_aclCheck` (`:2624-2630`), so one packet tested
  against two lists must tally each list once, not the packet twice. Step 5 asserts it.
- **Untagged and native-VLAN frames** must not resolve to a subinterface by accident: match on
  `encapVid === vid` only, and fall back to the port when nothing matches.
- **Failing closed by accident.** A resolver that denies when the *parent* has no list would break
  every existing ACL lab; `test/acl-data.test.js` and `test/counters-agreement.test.js:213` are the
  regression net.
- **Scope creep into the SVI.** Step 7 is a feature and is fenced as one.

## Test strategy

New `test/acl-logical-interface.test.js` builds its own lab (the table above), so it does not depend
on a catalogue change; `test/acl-data.test.js` stays the physical-port suite and must pass untouched.
Run `npm test`, then `node scripts/check-doc-citations.js` after step 6, because the §5.3 row is
exactly the kind of citation that has already rotted twice.

## Deliberately left out

- IPv6 ACLs, `established`/reflexive matching, time-ranges and logging: absent today
  (`docs/SIMULATION.md:325`) and not needed to make an existing binding honest.
- Whether `access-list` should be gated on the `firewall` capability — that is
  `docs/plans/capability-vocabulary.md` step 5; answering it twice would create two answers.
- ACLs on a LAG logical port, `match ip address` for BGP route maps (`docs/BGP-POLICY.md:1107`), and
  any change to `engine/acl.js` parsing.
