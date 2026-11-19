# Plan: a DISCOVER does not cross a router, and nothing chooses the pool a relayed client would need

Status: forward plan, no code. Measured on `a603c7f7`, 2026-11-18. Closes **no** open issue - the queue is
two device requests (#130, #803) and neither is about DHCP. Steps 1, 3, 4, 5 and 6 repair surfaces that
already exist; **step 2 is the one new behaviour and it is marked "needs Jay's approval"**, because two
files currently state its absence as deliberate. Scope: `engine/simulator.js`, `engine/segment.js`,
`engine/dhcp.js`, `engine/cli.js`, `engine/device.js`, `docs/SIMULATION.md`, `docs/CLI.md`, `_help()`, the
help-completeness list, and two new suites.

Distinct from `docs/plans/capability-vocabulary.md` (which asked whether the `dhcp-client` token has a
reader - it does, `ip address dhcp`), from `docs/plans/flow-determinism.md` (what a run carries over) and
from `docs/plans/research-inbox-lifecycle.md` (the research tree). This one is about one box in the DHCP
path that is missing: the router between the client and its server.

## What exists today

**The exchange is real and complete on the wire.** `computeDhcp()` (`engine/simulator.js:1184`) runs before
the first packet of a run (called at `:619`); `_runDhcpExchange()` (`:1249`) walks DISCOVER -> OFFER ->
REQUEST -> ACK/NAK through `engine/dhcp.js`; the lease is installed on the interface and recorded in the
server's allocation table, which `dhcpBindings()` (`:1241`) exposes to `show ip dhcp binding`.

**The server is whatever is in the client's broadcast domain, and the walk stops at a router.**
`segmentLib.segmentOf()` (`:1200`) returns the L3 endpoints reachable without crossing a router, and
`servers` (`:1201-1206`) keeps those holding a pool. `engine/segment.js:6-20` says so in its own words,
including *"What it does not model: DHCP relay (a DISCOVER does not cross a router to reach a server on the
other side)"*.

**Measured, two subnets, one cable between two routers:** PC1 asks on R1's `10.20.0.0/24`, the only pool is
`remote` on R2 (`network 10.20.0.0 255.255.255.0`, `default-router 10.20.0.1`). The run records
`{ type: 'dhcp', phase: 'failed', reason: 'no-server', detail: 'no DHCP server in this broadcast domain' }`
and the port stays `ip: null`. Nothing else in the lab can make that work.

**A server in the client's own segment but with a pool for another subnet also refuses.** Same lab with the
server one cable away: `reason: 'no-pool'`, `detail: 'the address of 10.99.0.1 is in none of the server
pools'`. The rule is `net.ipInSubnet(s.iface.ip, pool.network, pool.mask)` (`:1277`) - *the server's own
interface*, which is exactly the fact a relay replaces with the gateway address.

**The console has no word for it.** In `(config-if)#`, `ip helper-address 10.99.0.5` answers
`% Unrecognized interface command: ip helper-address 10.99.0.5` (`engine/cli.js:2343`); the `no` form
answers the same, and `ip forward-protocol udp 67` is `% Unrecognized config command`. `IFACE_WORDS`
(`:168`) is a complete table of the 17 first words interface mode accepts, and "helper" appears under none
of the values of `ip`. So the operator is told the console never heard of the command, not that the model
has no relay - two different facts, and the wrong one is on screen.

**Option 54 already assumes the server sits in the pool's subnet.** `normalizePool()` derives the server
identifier from the pool *gateway* (`engine/dhcp.js:207-213`) and `serverId()` falls back to the same field
(`:395-402`). Correct while the server's own port is inside the pool; the moment the pool is served to
another subnet, the ACK would name the router as the server.

**A port cannot carry the setting even if it were typed.** `Device.serialize()` writes a fixed port
document (`engine/device.js:1405`), `Device.hydrate()` copies a fixed allowlist back (`:1581`), and the
running-config printer has one line for the address method (`engine/cli.js:6501`). A field that is not in
all three is dropped on save, which is the defect #1405 and #1321 were.

**Documented as absent on purpose, twice:** `docs/SIMULATION.md:314-316` (*"DHCP relay (a DISCOVER does not
cross a router - a lab with a central server and a remote subnet will not work, by design rather than by
accident)"*) and the `segment.js` docstring above.

## What is missing, ranked

1. **The crossing itself** - no relay agent exists in the path, so a central server cannot serve a remote
   subnet (`segment.js:19-20`, `simulator.js:1201-1206`). *needs Jay's approval.*
2. **Pool selection by gateway address** - the server would have to answer for a subnet it is not in
   (`simulator.js:1277`), and `no-pool` is the only answer it can give today.
3. **Server identity in the answer** - option 54 would name the pool's gateway (`dhcp.js:207-213`), i.e. the
   router.
4. **The config surface** - no store, no printer, no persistence for a helper address (`cli.js:6501`,
   `device.js:1405`, `:1581`).
5. **The words** - a generic `Unrecognized` (`cli.js:2343`) instead of a sentence about the model; no entry
   in `_help()` (`:6767`), the advertised list (`test/help-completeness.test.js:99`) or `docs/CLI.md:198`.
6. **Observability** - the event log can say "relayed" only after step 2 exists; `_dhcpFailures()`
   (`cli.js:4461`) knows four reasons and would need the new ones.

## Ordered steps

| # | Step | Size | Closes |
|---|---|---|---|
| 1 | **The setting, with nowhere for it to act yet.** `ip helper-address <addr>` and `no ip helper-address [<addr>]` in interface mode: one branch in `_ifaceMode()`'s `ip` dispatch (beside `ip nat inside`, `cli.js:2071`), a list on the port (`iface.helperAddresses = []`, capped at 16 as IOS does, the 17th refused by name), one line per address in `show running-config` (`cli.js:6501` block), and the field added to `serialize()` (`device.js:1405`) and `hydrate()` (`:1581`). Refuse a non-IPv4 address, `0.0.0.0` and a multicast address with the address-error sentence the rest of the console uses. No behaviour change: nothing reads the list. New `test/ip-helper-address.test.js` (accept, refuse, `no` forms, running-config, save/load roundtrip). | S | - |
| 2 | **The crossing.** In `computeDhcp()`, when the segment walk finds no server (`simulator.js:1256`), walk the same segment for an L3 device whose client-facing port carries a helper; for each helper in sorted order resolve the egress with the device's own route lookup and take the first that reaches a device with a pool. Carry `giaddr` = the relay's receiving port address, and choose the pool by `ipInSubnet(giaddr, pool.network, pool.mask)` instead of the server's own interface (`:1277`). The event gains `relayedBy` and `giaddr`; a helper that resolves nowhere is `reason: 'no-route-to-helper'`, a helper that points back at this device is `reason: 'helper-is-local'` (no loop). **needs Jay's approval.** `engine/segment.js`'s docstring loses its second sentence and gains the rule it now follows. New `test/dhcp-relay.test.js` (the measured lab now ACKs, with the right pool, gateway and server id; the local-server lab is unchanged; the server-with-another-subnet lab still says `no-pool`). | M | - |
| 3 | **Option 54 names the server, not the router.** Let the caller state the answering server's local address and use it in `serverId()` (`dhcp.js:395-402`) ahead of the gateway fallback, which stays for the same-subnet case. Assert in `test/dhcp.test.js` that an explicitly stated server wins and that an unstated one still falls back (no change for existing pools). | S | - |
| 4 | **The two new failures get a sentence.** `_dhcpFailureText()` (`cli.js:4476`) and the binding table's "were refused" line already print `detail`; make sure the two new reasons read as English on both the server's and the client's console, and that neither is silently counted as `no-server` again. No new view. | S | - |
| 5 | **The words on paper.** `docs/SIMULATION.md:314-316`: the relay moves out of the "Absent" row into a Modelled row with the two citations above; `docs/CLI.md:198` gains the command in the interface-mode summary and a short transcript in the DHCP section; `_help()` (`cli.js:6788`) gains the line and `test/help-completeness.test.js:99` gains the entry, so `help` cannot advertise less than the parser takes. | S | - |
| 6 | **Paste-back.** Add the helper line to the running-config roundtrip fixture (`test/config-roundtrip.test.js`, `test/config-text-to-state.test.js`) so a config that prints is a config that re-reads - the failure mode #1391 and #1405 were. | S | - |

Steps 1, 3 and 6 do not need step 2 to land, and step 2 does not need 3 or 4 to be useful; 1 is the only
one that must precede 2.

## Risks

- **Step 2 changes what an existing lab does**, and that is the point of it: a lab that records `no-server`
  today starts handing out addresses. It cannot change any lab that has no helper configured - no command
  can write one until step 1 - which is why 1 lands first and alone.
- **Deliberate design.** `docs/SIMULATION.md:314` and `engine/segment.js:19` call the absence intentional.
  If Jay wants it kept, step 1 can still land (a stored, printed, saved command that refuses to act is
  worse than no command) - but the honest fallback is to refuse `ip helper-address` with the sentence
  "this model has no relay", which is a two-line change in `_ifaceMode()` and closes item 5 only.
- **Same-segment servers keep refusing.** A server in the client's own segment with no matching pool still
  answers `no-pool` after step 2: the frame is not relayed there, and a local server that has nothing to
  offer is a real answer, not a reason to ask further away. Stated here so the test pins it.
- **Determinism.** Helpers are sorted before use and the first answer wins, so a run cannot depend on Map
  iteration order (`docs/plans/flow-determinism.md`).
- **Persistence is an allowlist.** A field missing from `hydrate()` (`device.js:1581`) is lost on reload and
  the lab quietly relays somewhere else - the trap #1321 documents.
- **Address ownership.** A relayed lease installs an address whose gateway is the relay; `test/\
  address-ownership.test.js`, `arp-conflict.test.js` and `vrrp-in-path.test.js` are the suites that would
  notice if the lease and the port disagree.

## Test strategy

- `test/ip-helper-address.test.js` (new, step 1): header command table, `no` forms, address refusals, the
  running-config line, `JSON` roundtrip through `Topology.toJSON()/fromJSON()`.
- `test/dhcp-relay.test.js` (new, step 2): the measured two-router lab; a relay with two helpers where only
  the second has a pool; a helper with no route; the same-segment server unchanged; no exchange when the
  relay port is shut.
- `test/dhcp.test.js` (step 3): `serverId()` precedence.
- Existing suites that must stay green: `dhcp-in-path`, `dhcp-bindings`, `dhcp-infinite-lease`,
  `segment`-adjacent `vlan`/`link-state` suites, `topology-roundtrip`, `config-roundtrip`,
  `help-completeness`, `docs-cli-transcript`.
- Run: `node test/dhcp-relay.test.js`, then `npm test` (one leg); the docs edits need
  `npm run check:citations` clean for `docs/SIMULATION.md` and `docs/CLI.md`, which are scanned.

## Out of scope

Option 82, DHCP snooping, `ip forward-protocol`, DHCPv6/relay-for-IPv6, and any UI surface for a helper.
Each is a separate absence and none of them is in the queue.
