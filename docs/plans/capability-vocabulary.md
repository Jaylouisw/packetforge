# Plan: `dhcp-client` is declared by 1,142 models, and no port ever asks

Status: forward plan, no code. Measured on `1a11fb6f`, 2026-11-24, with a live lab (a `Mac mini (M2,
2023)` cabled `eth0` to `Gi0/0` on a `generic-router` holding pool `lan` 10.0.0.100-110). Closes **no**
open issue - the queue is empty; #1526, closed 2026-11-16, settled only `vlan`/`lacp`/`stp` and left
this token pending (`test/capability-vocabulary.test.js:45` still lists it). This file replaces the
open half of its own step 5; the rest of that vocabulary work has landed (see the note below).
Scope: `engine/device.js:69` (the `Interface` constructor), `devices/**` port declarations,
`test/capability-vocabulary.test.js:45`, five docs. No gate is added to any command.

## What exists today

**The token is everywhere and reads nothing.** 1,142 of 2,358 catalogue models declare
`dhcp-client`; 322 of those also declare `host`. Not one of the 1,142 marks a port, and not one
carries a static port address - measured with `loadCatalog('./devices')` over the tree.

**The intent cannot even enter through a spec.** The `Interface` constructor sets
`this.dhcp = false` unconditionally (`engine/device.js:69`); `spec.dhcp` is never read. Probed: a
port spec built as `{name:'eth0',type:'ethernet',speed:'1G',dhcp:true}` loads with
`iface.dhcp === false`. The flag therefore has exactly three writers, all post-load: the console
(`ip address dhcp`, `engine/cli.js:2716`), a saved lab document (`engine/device.js:1829`), and the
server's reset (`server/index.js:1434`).

**One reader, keyed on the flag, so the capability has no path to it.** `computeDhcp()` collects
clients as `iface.dhcp && iface.enabled !== false` (`engine/simulator.js:1214-1220`). Nothing
consults `hasCap('dhcp-client')` - which is why `PENDING = ['dhcp-client','firewall','wireless']`
(`test/capability-vocabulary.test.js:45`) keeps the suite green while `engine/device.js:149-151`
says in a comment that every token there is "a promise the engine keeps".

**Measured, on a device the catalogue ships.** The Mac mini, cabled to a router with a live pool,
never asks:

```
mac eth0 before: ip=null dhcp=false
ping success: false | reason: no route to 10.0.0.1
dhcp events: 0
eth0    unassigned   YES unset  up  up     <- show ip interface brief
```

Then one hand-typed command, and the same lab works: `ip address dhcp` gives `ip=10.0.0.100`,
`ping=true`, one `dhcp` event, and the brief reads `10.0.0.100 YES DHCP up up`. The model is fine;
only the wiring from the datasheet to the flag is missing.

**An unanswered discover is quiet**, so pre-setting the flag does not flood a timeline: a
two-`generic-pc` switch lab with no server produced exactly one event, `phase:'failed'`,
`reason:'no-server'`, `detail:'no DHCP server in this broadcast domain'`.

**The docs are mostly honest about this.** `docs/ARCHITECTURE.md:43`, `docs/ROADMAP.md:30` and
`docs/SIMULATION.md:96`, `:632`, `:719` all say the token is read by nothing. One does not:
`docs/DEVICE_SCHEMA.md:87` describes it as "asks for one".

## What is missing or weak, ranked

1. **No path from a declaration to the behaviour.** A spec cannot say "this port asks", and the
   constructor would drop it if it did - so the 1,142 declarations are decoration and
   `docs/DEVICE_SCHEMA.md:87` is wrong.
2. **The catalogue states a device-wide fact for an interface-level behaviour.** DHCP is per
   interface; 682 of the 1,142 models have two or more Ethernet ports (the widest single box in the
   catalogue declares 50, on `zyxel/GS1900-48`). No spec says *which* port asks: the WAN socket of a
   consumer router, the management port of a switch, the single NIC of a camera.
3. **The guard permits it.** `PENDING` is an allowlist that says "unread, and that is fine", so the
   defect cannot fail anything and #1526's class of bug can recur.
4. **A lab built from the catalogue silently has no address.** Every host a user drags in is
   unaddressed until they find `ip address dhcp` - and the ping failure reads `no route to 10.0.0.1`,
   not "unaddressed", which points the operator at routing instead of DHCP.
5. **39 models declare the token with no Ethernet port at all** (`ubiquiti/U6-Extender` is
   wireless-only; `mikrotik/RB1100AHx4` declares no ports): they cannot honour it in any step below.

## Ordered steps

| # | step | size | closes |
|---|---|---|---|
| 1 | The constructor learns the declaration: `this.dhcp = spec.dhcp === true` at `engine/device.js:69`, plus a regression asserting a port spec carrying `dhcp:true` loads set and a plain port stays `false`. Zero catalogue behaviour change today - no spec carries the field - so this is plumbing only. | S | - |
| 2 | The unambiguous third of the catalogue: the **152** models that are `host` **and** have exactly one Ethernet port get `"dhcp": true` on it. One mechanical PR, with a `scripts/` census printing the count it touched. `generic-*` fixture specs are **not** touched here. | S | - |
| 3 | Routers - **305** models. The asking port is the WAN/uplink socket (`spec.dualRole`, `wan` in the name), never the LAN bridge, never a 48-port `l3-forward` chassis. One PR, quoting one consumer-router lab. **Needs Jay's approval** on the rule. | S | - |
| 4 | The remaining **685** - 399 with two or more ports, 250 with one, 36 with none - taken one category at a time (64 switches, 158 PTP radios, 143 wireless APs, 43 IoT, 35 cameras, the multi-NIC hosts), each asking on the first wired port or the port its datasheet names. A switch that answers on every port is the failure mode this step exists to avoid - the PR must show one client, not 50. **Needs Jay's approval.** | M | - |
| 5 | Make the token honest in both directions: drop `dhcp-client` from `PENDING` (`test/capability-vocabulary.test.js:45`) and assert every spec declaring it has exactly one port that will ask - which also forces the 39 no-Ethernet models either to gain a port or lose the token. This is the step that stops #1526 recurring. | S | - |
| 6 | Docs: `docs/DEVICE_SCHEMA.md:87` becomes true rather than revised; `docs/ARCHITECTURE.md:43`, `docs/ROADMAP.md:30`, `docs/SIMULATION.md:96`/`:632`/`:719` and `CONTRIBUTING.md:117` lose "read by nothing". | S | - |

## Risks

- **Event counts move under existing suites.** Any lab already holding a catalogue host now emits one
  `dhcp` event per run (`phase:'failed'` with no server). Suites that filter `type === 'dhcp'` -
  `test/dhcp-in-path.test.js` counts them - must be re-measured, not re-numbered blind.
- **The two write paths disagree, and the operator should hear about it.** Setting a static address
  removes the DHCP client and says so (`engine/cli.js:2785-2789`), while a pre-set flag would
  silently outrank a static address the lab document states. The catalogue states no static port
  address today (measured: 0), but the step-2 PR must say which one wins.
- **Port choice is the whole risk.** "Every port asks" turns a 50-port switch into 50 lease attempts
  and 50 timeline entries. Steps 3 and 4 exist only to choose one port per model; a shortcut here is
  worse than leaving the token unread.
- **Fixtures are load-bearing.** `generic-pc` already declares `dhcp-client` and dozens of suites set
  the flag by hand; pre-setting it in the fixture would change those labs in one commit with no
  catalogue-wide story. Steps 2-4 stay out of `generic-*`.
- **A lease on a routed port is not harmless.** `computeDhcp()` installs the lease's router as
  `config.defaultGateway` on a non-L3 device and as `dhcpGateway` at distance 254 on an L3 one
  (`engine/simulator.js:1241-1248`); a router that asks by default gains a default route it never had.
  Step 3 must pin both behaviours.

## Test strategy

New `test/dhcp-client-capability.test.js`, built like `test/dhcp-in-path.test.js`: (a) a catalogue
host cabled to a router with a pool gets a lease with **no** console command - address, one `ack`
event, `Method` column `DHCP`; (b) the same host on a serverless switch reads `unassigned` / `DHCP`
and emits exactly one `failed`/`no-server` event; (c) a port spec carrying `dhcp:true` and a static
`ip` in one lab document keeps the static address; (d) the 56-port switch case: one client, one
event. Regression set: the fourteen `test/dhcp-*.test.js` suites,
`test/capability-vocabulary.test.js`, `test/import-devices-capabilities.test.js`, the catalogue
sweeps (`npm run test:roundtrip`, `npm run missing:devices`), then `npm test`. Docs steps run
`node scripts/check-doc-citations.js`.

## Already landed here (kept so the file is not re-proposed)

#1526's `vlan`/`lacp`/`stp` decision landed 2026-11-16: the three are out of `CAPABILITIES`
(`engine/device.js:151`) and documented as descriptive facts, guarded by
`test/capability-vocabulary.test.js`. The ghost `hasCap('route') || hasCap('router')` is gone, the
importer and engine arrays are held equal by `test/import-devices-capabilities.test.js:73-84`, and
the catalogue is 2,358 models across 258 vendors, not the 2,057 this file used to quote.

## Issues this would close

None - the queue is empty. It finishes #1526's residue and makes `docs/DEVICE_SCHEMA.md:87` true.

## Deliberately left out

**Gating `ip address dhcp` on the capability.** It looks like the obvious counterpart and it is a
trap: `generic-switch` is `['l2-forward','cli']`, every `l3-forward` chassis may legitimately take a
management lease, and dozens of suites type the command on both. The token decides what a device
does by itself, not what an operator may type - the opposite of `dhcp-server`, which is gated.

Also out: `firewall` and `wireless`, the other two `PENDING` tokens (declaring them inert is a
docs-only decision with no behaviour to wire); DHCPv6 and SLAAC (a separate path, already modelled,
`engine/ra.js`); DHCP relay (`docs/plans/dhcp-relay.md`); lease renewal and expiry, which need a
clock the model does not have (`docs/SIMULATION.md` section 8); and adding Ethernet ports to the 39
portless models - step 5 only demands that they stop claiming the token.
