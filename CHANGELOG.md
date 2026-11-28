# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Removed

- **`scripts/gh-bridge.js` is deleted, and nothing replaces it.** It carried GitHub issues and pull
  requests *to* the Forgejo instance, which has been a read-only archive since 2026-11-27 — and its
  pull-request path replied to incoming GitHub pull requests with "Mirrored to Forgejo (canonical
  repo): please direct review/merge there", which is the opposite of where the work happens. Nothing
  in the tree required it and no suite covered it; `docs/MIRRORING.md`, `docs/REQUESTING-HARDWARE.md`
  and `docs/TRIAGE.md` now describe the arrangement that exists, and keep the bridge only as history.

### Fixed

- **A port that had just come out of Blocking was Forwarding at the instant of the change.** #1722 settled
  *whose* timers pace a non-root's ports; #1731 settled that a bridge which only stops hearing the root owes the
  old root's Max Age. Neither said *from when* the two forward delays run, and the port state did not ask: the
  schedule counted from the change, `stpPortStateAt()` compared the absolute clock with `forwardAtMs` (8 s on a
  4 s root), so after a cable moved at 60 s every port the new tree had just unblocked read `forwarding` - while
  `link down` answered "Network converges again at 68000 ms" - and a partitioned bridge read `learning` through
  the Max Age it should have spent blocking. `setLinkState()` also recorded the change *after* rebuilding the
  tree, so the rebuild was paced from the previous change (or t=0). The schedule entry now carries `startedAtMs`
  beside `readyAtMs`, `stpPortStateAt()` takes the entry and counts the state back from the instant the box
  finishes (Blocking through a Max Age hold, then Listening, Learning, Forwarding), and the change is recorded
  before the rebuild. `test/stp-root-timers-pace-the-tree.test.js` (43 assertions), `docs/CONVERGENCE.md` (#1731).
- **A non-root ran the root's timers from t=0, whatever instant it heard the root.** #1722 settled *whose*
  forward delay paces a non-root's ports and #1746 the Max Age a bridge sits out after it loses the root;
  neither said when the adoption *starts*. `stpTimersInForce()` applied the root's numbers from the lab's
  t=0, so a switch powered on before its root walked the root's two 4 s delays from a BPDU that did not exist
  yet - 8 s on a board still advertising nothing - and `hello`, carried in every adopted timer set since
  #1722, was counted by nothing. A bridge now carries `bootedAtMs` (runtime only, never serialised) and
  `stpAdoption()` returns the instant the root's first configuration BPDU is accepted: the root's own boot
  when the two come up together or the root first, because a port transmits a configuration BPDU the moment
  it becomes designated; one hello later when the box powers on into a tree already running, which is the
  worst case for the root's next one. The schedule dates the two forward delays from that instant,
  `stpPortStateAt()` answers the window before it from the bridge's *own* timers (a box not yet powered
  blocks), and the `Basis` column reads `heard the root SW1 at 7000 ms, then ...` or `powered on at 5000 ms,
  then ...`. A re-convergence pays no hello - a box that was already hearing the root holds its BPDU, so a
  cable moving elsewhere does not restart the clock - and a box powered on after the change holds nothing, so
  it owes no Max Age. `test/stp-adoption-window.test.js` (35 assertions),
  `research/stp-root-timers-pace-the-tree.md`, `docs/CONVERGENCE.md` (#1731).
- **An OSPF router given a higher priority took the DR seat on the spot, which no box does.** The
  DR/BDR election was held from scratch on every `computeOspf()` pass, so `ip ospf priority 200` typed on
  a DROTHER made it the DR by the next `show ip ospf neighbor`, and a router whose cable came back took
  the seat back from whoever had been holding it. Both are the one thing a real segment will not do:
  "OSPF DR and BDR elections are not pre-emptive ... the newly added router does not take over the DR or
  the BDR role because those roles have already been assigned" (Cisco, *Scaling Networks v6.0*, ch. 10),
  and NetworkLessons' three-router capture shows `ip ospf priority 200` leaving `FULL/DR` on the old DR
  until `clear ip ospf process`. The election now runs the way RFC 2328 §9.4 describes it - over what
  each router last declared, not over the ranking alone: an incumbent DR still standing and still
  eligible keeps the seat, an incumbent BDR is promoted ahead of any higher-priority newcomer when the
  DR seat frees, and the ranking fills only the seat left empty (and is still the whole vote on a fresh
  segment, so every first-election capture is unchanged). The two seats live on the topology
  (`topo.ospfRoles`, beside the DHCP leases, so a later request sees the answer an earlier one reached)
  and `/reset` clears them, which is this model's `clear ip ospf process`.
  `test/ospf-dr-election-is-not-preemptive.test.js` (28 assertions) and
  `research/ospf-dr-election-is-not-preemptive.md`.
 `computeOspf()` walked
  `topo.links`, so an adjacency needed a cable between the two devices: two routers cabled into the same
  switch - the commonest OSPF lab there is, and the one the DR/BDR pair is taught on - answered
  `% no adjacencies: nothing on the other end of an OSPF interface is running OSPF` on every box, and
  installed no route. A Hello is a multicast within a broadcast domain, which is the walk
  `segmentOf()` already performs for DHCP (bridges, VLANs, link state and the spanning tree's blocked
  ports), so the adjacency set is now the segment's - a cable is the degenerate case, a segment of two.
  The election moved with it: elected pairwise, a segment of three routers produced *two* DRs. It is now
  one DR and one BDR per segment (highest Router Priority, then highest Router ID), and the routers that
  are neither print `2WAY/DROTHER` for each other, as a box does - a real neighbour that carries no LSA,
  listed in `show ip ospf neighbor` and never used as a next hop. The closing sentence counts them
  (`3 neighbour(s), 2 fully adjacent (1 in 2WAY/DROTHER)`) instead of claiming every row is FULL.
  `test/ospf-segment-adjacency.test.js` (27 assertions) and `research/ospf-segment-adjacency.md`.
- **A non-root's ports were paced by its own forward delay, not the root's.** A bridge adopts the hello,
  forward delay and max age the root advertises in its configuration BPDU - "all switches in the Spanning Tree
  topology learn and use such Timers Values, ignoring local Timers Values" (Cisco Learning Network) - so a tree
  whose root runs a 4 s forward delay forwards every port 8 s after power-on. `buildSchedule()` read
  `stpTimers(dev)` per device, so the same tree converged at two speeds: 8 s on the root, 30 s on a non-root
  left at the 15 s default, while that non-root's own report printed the root's 4 s on its Root ID line. The
  schedule now takes the election as `opts.stp` and uses the timers in force (`stpTimersInForce()`), naming the
  root in the entry's basis when they are adopted; a bridge with no path to the root hears no BPDU, keeps its
  own config, and says so. `setLinkState()`'s `reconvergeAtMs` was a hardcoded +30 s and is now the schedule's
  own STP completion. `test/stp-root-timers-pace-the-tree.test.js` (26 assertions) and
  `research/stp-root-timers-pace-the-tree.md` (#1722).
- **The timer line in `show spanning-tree` was a literal, and the two blocks print different sets.** Both blocks
  said `Hello Time 2 sec  Max Age 20 sec  Forward Delay 15 sec` no matter what the box was running, while
  `stpForwardDelaySec` / `stpMaxAgeSec` on the device's config already drove the convergence schedule - so a
  fixture with a 4 s forward delay could forward ports at 8 s and still be told by its own report that the delay
  was 15. A Catalyst prints the timers in force, and on a non-root the two lines disagree: the **Root ID** line
  carries the root's timers (they arrive in the root's BPDU, and only those pace the tree), the **Bridge ID** line
  this box's own configuration - a root prints one line twice. Both lines are now built from `stpTimers()`, the
  root's device for the top line and the answering device for the bottom, with `helloSec`/`maxAgeSec` added to
  what that function returns. Where a root and a non-root still differ, this model's convergence times each device
  by its own configuration rather than the root's, a divergence recorded in `research/stp-timer-lines-source.md`
  and tracked as #1722.
- **`no router bgp` with the AS still untyped deleted the process.** `no router bgp` is
  `no router bgp autonomous-system-number` in both the IOS and the IOS XE command reference, with the number
  outside any brackets (IOS XR brackets it, `no router bgp [as-number]`, which is how the family shows that
  IOS requires it), and a line missing a required value is answered `% Incomplete command.` without running
  the command. This branch read the three words and cleared the process, so an operator who typed
  `no router bgp` and stopped to look the number up had already destroyed the configuration they were about
  to name: the local AS, the neighbours and the `router bgp` stanza in `show running-config` were gone. It
  now answers `% Incomplete command: no router bgp <as>` - naming the AS that is still running, or saying
  there is no process to remove - and changes nothing; a third word that is not an AS in 1-4294967295 is
  refused by the same `% Invalid AS number "<x>"` check the create path runs, before the delete; and
  `no router bgp <as>` still answers `BGP disabled`. The two questions beside it stay open and are recorded:
  a *mismatched* AS (this console still treats the number as a name for its one process) and a `no` with no
  process to remove (it still answers `BGP disabled`). The evidence is in `research/no-router-bgp-argument.md`
  (#1704).

- **`vlan 20` on a VLAN that already existed wiped its name and reported it as created.** The door wrote a
  fresh `{ name }` record on every line, so a bare re-entry on a VLAN named `sales` replaced the name with the
  default `VLAN0020` - and the sentence hid it, announcing `VLAN 20 created (name: VLAN0020)`: a creation that
  did not happen, printing a name the box had just thrown away. A switch changes a name through the `name`
  keyword only, so a bare `vlan 20` now selects the VLAN and leaves the record alone
  (`VLAN 20 already exists (name: sales), so there was nothing to create`), a different name is reported as the
  rename it is (`VLAN 20 renamed (name: ops, was sales)`), and a VLAN that a port made answers the same way
  instead of claiming to have created it. `vlan 20` on a VLAN that is not there still prints
  `VLAN 20 created (name: VLAN0020)`.

- **A static route typed twice was stored twice, so the config it printed grew on every paste and the table
  showed the route losing to itself.** `ip route` and `ipv6 route` pushed a new row every time the command ran,
  so `show running-config` printed the same line twice and `show ip route` printed a second `S` row annotated
  `(not installed: the S route for this prefix has distance 1)` - the shadowing note, applied to the same route.
  The set form is now idempotent: a line naming a route already configured adds nothing and answers
  `Route 10.9.0.0/16 via 10.0.0.254 is already configured: nothing was added`. The comparison covers every slot
  the command sets (network, mask, next hop, interface, distance), so a different next hop for the same prefix
  and the floating static (same next hop, other distance) are still stored as two rows. The vendor evidence for
  the rule - and the one thing it does not settle, because a box prints nothing for a repeated line - is in
  `research/duplicate-static-route.md` (#1657).

- **`show ip route static` was refused, and `connected` would have hidden the box's own addresses.**
  `show ip route` takes a protocol word - the vendor's field list reads "The name of a routing protocol or the
  keyword connected, mobile, static, or summary ... bgp, eigrp, hello, isis, odr, ospf, nhrp, or rip" (Cisco IOS
  IP Routing: Protocol-Independent Command Reference, `show ip route`) - and every capture prints the whole
  codes legend, the `Gateway of last resort` line and only the rows of that source. This console answered all of
  them with the prefix refusal ("does not take \"static\" ... read the row for the prefix"), which is right about
  a prefix (#1403) and wrong about a protocol. `show ip route <protocol>` now narrows the same table by route
  code, resolving the word through the same abbreviation table every other keyword slot uses (`c` is
  `connected`, `s` is ambiguous between `static` and `summary`), and keeps the legend, the per-row annotations
  and the gateway line untouched. `connected` keeps **both** the `C` and the `L` rows - a local host route is "a
  subtype of the connected route" (Cisco doc 116264) and a `show ip route connected` capture prints the pair for
  every interface (Cisco doc 221548) - so the narrowed view still shows the addresses the box owns. A protocol
  with no rows prints the legend and the gateway line and nothing else, `summary` is refused as the different
  table it is, a second word (`show ip route ospf 1`) as a process id this console does not keep, and a box that
  does not route refuses the word instead of printing a router's table. The prefix refusal keeps its own
  sentence, and the protocol hint is a clause on that sentence rather than a second line under it, because
  every refusal in this console is one sentence.
  `test/show-ip-route-protocol.test.js` (34 assertions) and `research/show-ip-route-protocol.md`.
- **A broadcast segment refused for a subnet mismatch explained itself with the point-to-point mask
  exception.** `computeOspf()` recorded `reason: 'subnet'` from two different comparisons - the broadcast
  check (equal masks, networks differ) and the point-to-point reachability check - so `show ip ospf
  neighbor` printed "the mask itself is ignored on a point-to-point link, RFC 2328 10.5" at an Ethernet
  segment whose masks were already identical, and never stated the fact that decided it: the peer address
  was outside this port's network. The record now carries the network type it was refused under
  (`network: 'broadcast' | 'p2p'`); a broadcast refusal names the network the peer fell outside
  (`10.8.0.1 is outside the network of this port (10.7.0.0/24)`), and the point-to-point sentence is
  unchanged (#1652).

- **A /24 against a /30 on a serial OSPF link formed no adjacency, and the console blamed the far end.**
  RFC 2328 10.5 states the Hello's Network Mask check and then excepts it for exactly this case - "on
  point-to-point networks and on virtual links, the Network Mask in the received Hello Packet should be
  ignored" - and a Cisco box follows the RFC: a /24 on one end of a point-to-point link and a /30 on the other
  form a `FULL/ -` adjacency and install the far prefix (ipSpace's capture; Cisco TAC doc 7112 separates the
  mask check from the "neighbour must be inside this interface's network" check). `computeOspf()` compared the
  two masks on every link and dropped the link with no record, so `show ip ospf neighbor` answered `nothing on
  the other end of an OSPF interface is running OSPF` about a router that was running it. A point-to-point
  pair now skips the mask comparison and checks reachability per direction instead (the peer's address must
  fall inside this port's own interface network, and the reverse); a broadcast segment keeps the mask check;
  and either refusal is recorded as `mask` or `subnet` with both ends' addresses and masks, so the console
  names the field that disagreed (`b2 runs OSPF with /25 on its end of this link and this box with /24: ...`).
  `test/ospf-p2p-mask-mismatch.test.js` (28 assertions) and `research/ospf-p2p-mask-ignore.md`.

- **`no ipv6 nd ra lifetime` wrote the value again instead of restoring the default.** Cisco's IPv6 command
  reference gives the no form as its own spelling - `ipv6 nd ra lifetime seconds` / `no ipv6 nd ra lifetime`,
  "To restore the default lifetime, use the no form of this command", default 1800 seconds - and the Catalyst
  1200/1300 and CBS 250/350 command lists repeat it. The branch here shifted the leading `no` into a `negated`
  flag and never read it again on the lifetime path: the bare form answered `% Incomplete command`, and the
  long form (`no ipv6 nd ra lifetime 900`) was accepted, answered with the set-receipt and stored the value a
  second time - a `no` that did the opposite of what it said. The bare form now restores 1800 s and drops the
  line from `show running-config`; a removal with nothing to remove refuses and names the default in force
  (`% No router lifetime set on R1 (it is the default, 1800s)`); a value on the no line has to name the value
  in force, so `no ipv6 nd ra lifetime 900` against a configured 1200 refuses and names 1200; `0` is treated
  as a configured value, not as nothing; and the seconds field is refused in the set form's own words in both
  directions. `test/ipv6-nd-ra-lifetime-no-form.test.js` (34 assertions) and
  `research/ipv6-nd-ra-lifetime-no-form.md`.

- **`no ip name-server 8.8.8.8` removed every resolver, not the one it named.** `ip name-server` prints up to
  six addresses on one line, and the vendor's no-form carries the addresses to remove — the command reference
  writes `no ip name-server … server-address1 [server-address2...server-address6]` and says "To remove the
  addresses specified", the 3560-X guide says "To remove a name server address", and an Oracle procedure on two
  Cisco switch families removes three configured servers with three separate one-address commands. The branch
  here read none of the words: it cleared `config.dnsServers` and printed `Name servers cleared`, so a server
  the operator did not name went too, and a word that was not an address did the same. It now removes exactly
  the addresses named (one `Name server <address> removed` receipt each, survivors keep their order), refuses a
  line that names an address the box does not hold with nothing removed, and keeps the bare `no ip name-server`
  as a whole-list clear — but only when there is a list to clear.
  `test/no-ip-name-server-removal.test.js` (24 assertions) and `research/no-ip-name-server-removal.md`.

- **`show interfaces <port>` claimed `duplex: full` for a port with no link — a duplex nothing had
  negotiated.** A Catalyst reports the *setting* for a port that is not up (`Auto-duplex, Auto-speed,
  media type is 10/100/1000BaseTX` on a `notconnect` port, in the 2960-XR command reference's own sample of
  the command) and the resolved value once the link is up. The block printed the model's resolved `full`
  either way, one space after a rate already marked `(auto)`. The setting now travels beside it
  (`iface.duplexMode`, `auto` by default), so a dead port reads `duplex: auto`, a hard-set one reads what was
  set, and an up port reads what was negotiated — the data plane, the LAG member check and
  `W_DUPLEX_MISMATCH` still read `iface.duplex` and are unchanged. `show running-config` writes the setting,
  so an explicit `duplex full` is no longer invisible (it was keyed on the resolved value, which is `full`
  for both `full` and `auto`) while the default writes nothing. `test/interface-duplex-when-link-down.test.js`
  (23 checks) and `research/interface-duplex-when-link-down.md`.
- **`show mac address-table dynamic` was refused, though it is a form of a table this console already prints.**
  The word was answered `% show mac address-table does not take "dynamic"`, with a pointer to `interface <port>`
  as though it were the only form of the command. Cisco's 2960-X command reference prints the sample in three
  releases (15.2(7)E, 15.2(4)E, 15.0(2)SE) and a live lab paste shows the same shape: the title, the rule, the
  headings and the closing `Total Mac Addresses for this criterion: N`, with `DYNAMIC` rows only — none of the twenty
  `All … STATIC … CPU` rows the unfiltered view prints, because those are the type the criterion excludes. The
  filter now prints exactly that, closes at the rows it printed (`…: 0` on a switch that has learned nothing,
  where the unfiltered view reads 20), takes `d`, `dyn` or `dynamic` as one word, and narrows with `interface <port>`.
  A trailing word with no view is still refused, and the sentence now names both filters instead of one.
  `test/mac-table-dynamic-view.test.js` (20 checks) pins the empty and populated tables, the short form and the
  port filter; [`research/mac-table-dynamic-view.md`](research/mac-table-dynamic-view.md) holds the samples and
  what is still unbuilt (`dynamic vlan`, `dynamic address`, `static`, `vlan`, `count`, `aging-time`).
- **The hardware-request queue and the missing-devices report could not read the tracker: both asked
  `github.com/api/v1/…`, which GitHub answers `410 Gone`.** The two tools were built on
  `scripts/forgejo-api.js`, and its base was derived from `canonical.WEB` — the *web* host with the
  archive's path hung off it — so the move to GitHub left it asking a URL that answers an HTML
  apology. `scripts/request-queue.js` printed "Could not read issues", and nothing caught it because
  no suite ever read the tracker: 491 green suites and two dead tools. The client is now
  `scripts/github-api.ts`, speaking GitHub's REST API at `api.github.com` (or `GITHUB_API_URL`) in
  TypeScript with no build step, and the two `.js` callers require it as `require('./github-api.ts')`
  the way they already require `canonical.ts`. Everything they rely on is preserved: pagination,
  label matching by name, `state`, an ISO `createdAt` for the age column, the comment order the
  blocker line reads, and a failure reported as *"could not look"* with a reason rather than as an
  empty queue. What GitHub genuinely shapes differently is translated: its issues endpoint returns
  **pull requests too**, so those are dropped *after* the page size is counted (filtering first would
  make a page of 50 holding 20 pull requests look like a short last page and silently stop the
  scan); it paginates on `per_page`, not the archive's `limit`; and `state_reason` replaces the
  archive's close reason, surfaced as `stateReason`. A read needs no token — GitHub allows anonymous
  reads at 60 an hour, so `availability()` no longer refuses to look without one — while a write
  fails with a message that names `GH_TOKEN`; `FORGEJO_TOKEN` is deliberately not accepted, for the
  reason the sweeper gives. Proved live: `node scripts/request-queue.js` reads the 8 open issues in
  `jaylouisw/packetforge` and finds the queue empty (it *is* empty — none of the 8 is a request),
  `node scripts/missing-devices.js` reports 0 open requests, and the old base replayed against the
  real host answers `HTTP 410 Gone` as an error with the fix in the sentence. The check that would
  have caught it is `test/github-api-client.test.ts` — offline, stubbed transport, asserting the
  base is `api.github.com` and that a 410 is an error rather than an empty list.
- **The hardware-request sweeper read the archive instead of the tracker.** `scripts/sweep-device-requests.js`
  held the archive's internal API address as a literal (`http://10.0.10.20:3000/api/v1`), so a plain run
  swept a backlog nobody can add to and `--close N` aimed its comments and closes at a repository that
  takes no new work. It now takes the host from `GITHUB_API_URL` (set on every Actions run) and
  defaults to `api.github.com`; it also stops accepting `FORGEJO_TOKEN`, because GitHub answers an
  archive token with 401 and that reads like "no access" rather than "wrong token".
- **The VRRP advertisement interval was set with a word no box has — `vrrp <vrid> advertise <seconds>` — and
  the spelling every box uses, `vrrp <vrid> timers advertise <seconds>`, was answered `% Unrecognized vrrp
  command`.** Cisco's syntax is `vrrp group timers advertise [msec] interval`, "use the vrrp timers advertise
  command in interface configuration mode", with `Router(config-if)# vrrp 1 timers advertise 4` as its own
  sample (Cisco IOS First Hop Redundancy Protocols Command Reference); every configuration-guide example
  spells it that way (`vrrp 1 timers advertise 3`, `vrrp 5 timers advertise 30`, `vrrp 10 timers advertise
  110`). The expensive half was the printer: `show running-config` wrote ` vrrp <vrid> advertise <seconds>`,
  so a config saved from the device carried a line no device would take back. The set form, the `no` form and
  the printed line now all name the timer; the old spelling is refused where it is typed with the box's form
  in the sentence and changes nothing, and the two real keywords this model does not hold — `timers advertise
  msec <interval>` (a sub-second interval) and `timers learn` — are refused by name rather than approximated.
  `test/vrrp-timers-advertise.test.js` (31 checks) pins the accepted form, the master-down interval moving
  with it, the printed line and its paste-back, and every refusal;
  [`research/vrrp-timers-advertise.md`](research/vrrp-timers-advertise.md) holds the five sources and what a
  capture of the invented line's rejection would still settle.
- **A static route could name the router's own address as its next hop, and the table then printed a default
  route pointing back at the box that typed it: `ip route 0.0.0.0 0.0.0.0 10.0.0.1` answered
  `Route added: 0.0.0.0/0 via 10.0.0.1` on a router holding 10.0.0.1/24.** A next hop is the far end of a wire;
  IOS refuses the line at config time, in a sentence that names no address and carries no space after the `%`:
  `%Invalid next hop address (it's this router)` (three raw console pastes — a Learning Network thread, a Cisco
  Community thread and a r/ccna session — with a teaching page printing the spaced variant). Nothing is stored
  now, so the line never reaches `show ip route`, `show running-config`, the gateway-of-last-resort line or a
  reopened lab. The check reads every interface, including a shut port and a subinterface, and runs after all
  slots are parsed, so the vendor's interface-first order and a distance-bearing line are refused the same way.
  A neighbour on the same segment is still accepted, and a refusal after a good route leaves it alone.
  `test/static-route-own-next-hop.test.js` (14 checks) pins the sentence and the non-install;
  [`research/static-route-own-next-hop.md`](research/static-route-own-next-hop.md) records the captures, the
  spaced dissent, and what is still open — a multicast or broadcast next hop, and a route that predates the
  address it now points at.
- **`switchport` with no keywords — the documented inverse of `no switchport` — was answered with a sentence
  that had nothing after its colon: `% Unrecognized switchport command: `.** The operator's word was the command
  itself, so the handler's `t.join(' ')` tail was empty, and the console refused a line five vendor references
  document: "To put an interface that is in Layer 3 mode into Layer 2 mode for Layer 2 configuration, use the
  switchport command in interface configuration mode. To put an interface in Layer 3 mode, use the no form of
  this command" (Catalyst 9300 command reference, IOS XE 16.5.x, Layer 2/3 Commands, `switchport`; the same
  entry in the 9200 16.12, 3850 16.3, 2960-S/2960-C 15.2(4)E and IOS interface command references). This console
  has no routed port for the line to return to Layer 2 — `no switchport` clears a port's Layer 2 configuration
  and leaves it switching — so the bare form now names the port, says what the command is for on a box, and says
  nothing changed. It is still not a reset: a trunk, its native VLAN, its allowed list and its description all
  survive it byte for byte, and `no switchport` is still the only command that wipes the port.
  `test/bare-switchport.test.js` (23 checks) pins the answer on a 2960 and a 3560, the unchanged
  `show interfaces` / `show running-config`, the unknown-keyword refusal, the `no switchport` reset, and the
  router's `l2-forward` refusal; [`research/bare-switchport-command.md`](research/bare-switchport-command.md)
  records the LAN Base half of the question — Cisco's own notes say the command pair "is not supported" on that
  feature set, and one real LAN Base 3750X answers `Command rejected: not allowed on this interface.`, but what a
  2960 prints is not settled, so `no switchport` is still accepted on every box that switches.
- **The auto-create notice was printed on two lines, and the second one does not exist: `switchport access
  vlan 22` on a switch with no VLAN 22 answered `% Access VLAN does not exist.` then `Creating vlan 22`.** A
  box prints that as **one** sentence — `% Access VLAN does not exist. Creating vlan 22` — as Cisco's own
  transcripts show (Layer 2 Configuration Guide, IOS XE 17.14.x, Catalyst 9300, "Example: Configuring an IEEE
  802.1Q Tunneling Port"; the Catalyst 9500 17.12 chapter of the same name, in the PDF's text layer). The pair
  was a transcription of a *rendered* page: search snippets wrap the sentence after `exist.`, the document
  itself does not, and the break lands at that word whatever the prompt length in front of it, which no
  80-column console would do. The console now prints the one line and then its own receipt, and
  [`research/vlan-autocreate-notice-line.md`](research/vlan-autocreate-notice-line.md) records the two
  renderings of the same URL and what a raw session log would still settle. `test/vlan-auto-create.test.js`
  asserts the whole sentence as the first line (15 checks); the replay filters in `test/switchport-mode.test.js`
  (32), `test/switchport-negation.test.js` (46) and `test/config-roundtrip.test.js` (47) match the one-line form.
- **The maintainer's own queue could not see a device request that was missing its label: #2521 sat
  open carrying only `device`.** `scripts/request-queue.js` asked the tracker for
  `labels=device-request`, so a request filed before the triage workflow labelled it was answered as
  "Queue is empty" — while the app's `/api/requests`, `scripts/sweep-device-requests.js` and
  `scripts/close-merged-issues.js` all read the `[Device]:` title and listed it. The reader and the
  closer therefore disagreed about whether the same issue was a request. Both `request-queue.js` and
  `scripts/missing-devices.js` now select on the label *or* the title through one exported predicate,
  `isDeviceRequest`, matching the regex the server and the sweeper already use, and the queue prints
  an issue that arrived by title alone with its labels so the missing one can be applied.
  `test/request-queue.test.js` pins ten cases, including the one that matters: `[Device]:` with only
  `device` is a request, and a bug report that mentions a device is not.
- **A keyword typed in capitals was refused as an unknown view: `show ip ROUTE`, `show ip interface BRIEF`,
  `show mac ADDRESS-TABLE`.** A box matches the words of a command in any case - IOS says so itself ("You can
  enter commands in uppercase, lowercase, or mixed case. Only passwords are case sensitive", and "Cisco IOS
  commands are generally case-insensitive") - and this console folded the *first* word of a `show` line only.
  So `show ip ARP` and `show POWER INLINE` reached their views (their words are compared lowercased) while the
  six views dispatched by a literal comparison - `nat`, `interface brief`, `route`, `dns`, `dhcp`, `ospf`, `bgp`
  - plus `show ipv6 nd` and `show mac address-table` answered `% Invalid show command: ip ROUTE` about views the
  console has. Every word after `show` is now compared through one lowercased copy of the line; the *values* on
  that line keep the case they were typed in, so `show ip route EXTRA` still quotes `EXTRA` back.
  `test/show-keyword-case.test.js` (37 checks) pins eleven case variants to their lower-case twins byte for byte,
  the real route and brief tables behind the capitalised spellings, and the refusals that must not move;
  [`research/show-keyword-case.md`](research/show-keyword-case.md) records the sources and leaves the interface
  *name* - as opposed to the keyword - open.

- **A bare `show`, and `show mac` / `show power`, were refused as words the console does not know.** `show` on
  its own answered `% Invalid show command: (empty)`, and the two half-commands answered `% Invalid show command:
  mac` and `… power`, though both are doors whose word is the rest of the line (`show mac address-table`,
  `show power inline`) — the same two rows `show ?` prints with their extra words. IOS separates the faults:
  `% Invalid input detected at '^' marker.` is for a word the parser does not know at that position, while
  `% Incomplete command.` is "You did not enter all the keywords or values required by this command" (Command
  Reference, IOS XE 17.18.x, Catalyst 9200, "Using the Command-Line Interface", Table 3; 15.2(7)E and 17.15.x carry
  the same table), and a 3750 transcript shows that sentence for a keyword chain one word short
  (`SW1#clear mac address-table` -> `% Incomplete command.`). All three now answer `% Incomplete command: …` and
  name the word that completes the line, echoing the spelling typed (`show m`, `show pow`). An unknown word is
  still `% Invalid show command: <word>`, an ambiguous prefix is still ambiguous, and both completed views print as
  before. `test/show-incomplete-view-word.test.js` (23 checks; the old handler passed 9 and failed 14) pins the
  three shapes at `#` and from `do` in config mode;
  [`research/show-incomplete-view-word.md`](research/show-incomplete-view-word.md) records the sources, the house
  hint after the vendor sentence, and the two neighbouring questions left open (`show mac addr`, `show mac
  Address-Table`).

- **`no vlan 22` was refused while a trunk's allowed list named 22, though the box deletes the VLAN and leaves
  the line alone.** Deleting a VLAN is a VLAN-database operation: the interface line is configuration and
  survives it, and the trunk stops carrying the VLAN because a trunk port is a member of a VLAN only while that
  VLAN exists. Two operators answer the exact question on Cisco Community - "No, you need to remove it manually
  from the trunk interface" and "only deleting it (`no vlan 30`) won't make it disappear from the interface's
  config" - and the Catalyst 9300 trunk guide makes membership the intersection of enabled, existing and
  allowed. The console answered `% VLAN 22 is still carried by 1 port(s): Fa0/3 - move them off it first`, a
  sentence no box prints, and kept the VLAN. It now commits the deletion, prints
  `Fa0/3 stops carrying VLAN 22: the switchport configuration is unchanged (vlan 22 brings it back)`, and leaves
  `switchport trunk allowed vlan ...` and `switchport trunk native vlan ...` exactly as typed; re-creating the
  VLAN restores carriage with no interface command. The data path agrees in both directions: a VLAN the database
  does not hold carries nothing, so tagged and native-VLAN frames are dropped at ingress (and nothing is learned
  in a VLAN `show vlan` no longer prints) and again at egress, while LLDP - a link protocol, not customer
  traffic - stays exempt as it already was from the allowed list. Ports that only *reference* a VLAN without
  carrying it (a native or allowed list stored on a non-trunk port, a voice VLAN) still refuse, because no
  source says what a box does with a reference that is not in force.
  `test/vlan-delete-leaves-port-inactive.test.js` (39 checks) and `test/show-interfaces-port.test.js` (47) pin
  the receipt, the untouched backup, the drop counter and the MAC table; two labs that used a native VLAN as a
  mismatch fixture now create the id they name; [`research/trunk-allowed-vlan-on-vlan-delete.md`](research/trunk-allowed-vlan-on-vlan-delete.md)
  records the sources and the native-VLAN paste still open.

- **A trunk pruned with `switchport trunk allowed vlan remove 1-4094` was refused, though a box takes it.** The
  command subtracts a list from the one the port carries, the default is 1-4094, and `none` is a documented
  allowed-list value meaning an empty list — so a trunk carrying nothing is a state a device can be in. The
  console answered `% that would leave the trunk allowing no VLANs: name what it should carry instead …`, a
  sentence no box prints, and left the default list untouched. Two field configurations use exactly this line
  to prune a trunk before adding the VLANs it should carry
  (`remove 1-4094` then `add 10,11,54,55,512,599,1000,3407` on an SF350-48; `remove 1-4094` on a gi5 trunk in a
  Cisco Community configuration), and it is the same destination `switchport trunk allowed vlan none` stores.
  The subtraction now commits: `remove 1-4094` and `remove 1-1001,1006-4094` store the four media defaults
  (`1002-1005`, which cannot come off a trunk), `remove 10,20` on a list of `10,20` stores the empty list, and
  the backup prints `switchport trunk allowed vlan 1002-1005` or `… none`. `except 1-4094` reaches the same
  pinned remainder and is committed the same way. The three suites that pinned the refusal now pin the
  accepted line, the stored list, the backup and the prune-then-add sequence;
  [`research/trunk-allowed-remove-everything.md`](research/trunk-allowed-remove-everything.md) records the
  captures and the open half (whether a box prints `1002-1005` or `none` after the full removal).

- **A trunk's allowed list folded a pair of VLANs into a range no switch prints.** `switchport trunk allowed vlan
  remove 5-10,12` folds runs into ranges (a c3550 prints `1-4,7,11,13-4094`), and this printer folded *every*
  run — so a backup of a port carrying 157 and 158 read `157-158`, where three captured `show running-config`
  blocks print `59,157,158,160`, `1,81,82,171,999` and `55,56,59,155,157,158,160,200`. The rule the captures
  fit is arithmetic: a range is written only where it is shorter than the list it replaces, so three or more
  consecutive ids fold and a pair stays two ids (`81-82` is exactly as long as `81,82`). `formatVlanList()`
  follows it, and the panel's mirror with it, so the backup, the console's receipt and the `switchport:`
  sentence of `show interfaces` all read `157,158`. `test/running-config-allowed-vlan-two-id-run.test.js`
  (12 checks) pins the captured pairs, the two folds, the whole five-line `fa2/0/39` block and the round trip;
  [`research/trunk-allowed-two-id-run.md`](research/trunk-allowed-two-id-run.md) carries the captures and the
  open half (a device-computed run of exactly three).
- **A 100G port was printed as `HundredGigabitEthernet`, a word no IOS box says.** IOS XE's interface-type
  lists pair `TwentyFiveGigE or twe`, `FortyGigabitEthernet or fo` and `HundredGigE or hu` in one sentence —
  the 40G word is spelled out and the 100G word is not — and a Catalyst 9500 prints `interface HundredGigE1/0/2`
  in running-config and `HundredGigE1/0/1 is up, line protocol is down` from `show interfaces`.
  `HundredGigabitEthernet` is real, but it is FSOS's name, and FSOS catalogue ports already carry it. The
  display table's `hu` expansion therefore printed the C9500-24Y4C's four cages as 27-character
  `HundredGigabitEthernet1/0/1` rows that pushed the address cell past the brief table's 23-column field; they
  now read `HundredGigE1/0/1`, and every typed spelling (`Hu1/0/1`, `hundredgige 1/0/1`,
  `HundredGigabitEthernet1/0/1`) still resolves to the same port, whose stored key is unchanged.
  `test/hundredgige-spelling.test.js` pins the brief row, its column, the stanza header, the typed spellings
  and an FSOS box keeping its own long word; [`research/hundredgige-interface-spelling.md`](research/hundredgige-interface-spelling.md)
  records the sources and the one cell still open — whether `show ip interface brief` abbreviates any
  high-speed type, which one Cat9k transcript suggests it may.
- **An EdgeSwitch 18X powered a device from fifteen sockets that cannot source power, and missed the one that
  can.** Ubiquiti's datasheet names both ends of the passthrough in one sentence — "Sixteen Gigabit RJ45 ports
  offer copper connectivity with **PoE input on port 1** and **PoE passthrough on port 16**" — against a tech-spec
  row that only says "(1) 24V passive PoE port". The catalogue entry had put that one port on `eth0` (the first,
  an assumption its own note admitted) and, because a PoE switch's ports are otherwise inferred, `derivePortHardware()`
  filled `eth1`–`eth15` with 15.4 W of 802.3af on a 24 V passive box. `show power inline` therefore listed sixteen
  PSE ports where the hardware has one, and a device cabled to any of fifteen of them would have been shown as
  powered. `eth15` (port 16) is now the outlet at the vendor's 15 W per-port ceiling, classed `passive`; `eth0`
  (port 1) declares the inlet at the box's own 14 W `Max. Power Consumption`; `eth1`–`eth14` declare `poeOut: false`
  so the switch-wide inference cannot re-promote them. The budget is a **derived** 10 W (24 W adapter − 14 W draw,
  the same arithmetic as the ES-10XP's 52 W), marked derived because Ubiquiti prints no total PoE row.
  `test/es-10x-passthrough.test.js` pins the outlet, the absence of every other PSE, the inlet, the derived budget
  and the console's answer; source:
  [ES-18X datasheet](https://media.dustin.eu/media/d200001001720050/edgeswitch-18x-product-data-sheet-brochure.pdf),
  with the [EdgeSwitch X datasheet](https://dl.ui.com/ds/edgeswitch_x_ds.pdf) showing the same construction on the
  ES-10X; [`research/es-18x-passthrough-port.md`](research/es-18x-passthrough-port.md) records the sources and the
  four questions they leave open (adapter-only operation, which ceiling binds, the outlet's out-of-box state, the
  inlet's idle draw).
- **A bridge priority off the `4096` ladder was refused in a sentence no box prints.** `spanning-tree
  priority 4500` answered `% 4500 is not a valid bridge priority: it must be a multiple of 4096 ... the nearest
  valid values are 4096 and 8192` - true, and helpful, and not what the hardware says. A Catalyst prints four
  lines instead: `% Bridge Priority must be in increments of 4096.`, `% Allowed values are:`, and then its
  sixteen allowed values eight to a line in a six-character column (`0     4096  8192  12288 ...` above
  `32768 36864 ... 61440`). The value check does not echo the number it rejected, and the block is command
  neutral - the same four lines come from `spanning-tree vlan <id> priority` and `spanning-tree mst <n>
  priority` in Cisco's own guides. The console now prints them verbatim; the out-of-range refusal (`61441`) is
  unchanged and still names the range before the step rule runs. `test/stp-priority.test.js` pins the four lines
  byte for byte and replays all sixteen listed values to prove none is itself refused;
  `test/command-answers-the-question.test.js` moved to the new wording. Sources: the
  [Catalyst 4500 12.2(37)SG guide](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/37sg/configuration/guides/config/spantree.pdf)
  (Courier text layer keeps the column), the
  [15.2(5)Ex guide](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/XE3-9-0E/15-25E/configuration/guide/xe-390-configuration/spantree.pdf)
  and a [Cisco Community PVST+ transcript](https://community.cisco.com/t5/switching/spanning-tree-vlan-priority-issue/td-p/2506756);
  [`research/stp-priority-step-refusal.md`](research/stp-priority-step-refusal.md) records the wrap and indent
  questions the captures leave open.
- **A DHCP pool with no `range` was refused, though `range` is optional on the box.** The commonest DHCP
  configuration in the world - `ip dhcp pool LAN` / `network 10.4.5.0 255.255.255.0` / `default-router
  10.4.5.1` - was answered `% Pool LAN is incomplete - ... both rangeStart and rangeEnd are required.
  (E_DHCP_BAD_RANGE)`, and a client on that subnet got no address at all. Cisco's own DHCP-server
  walkthrough configures exactly that pool and shows `Leased addresses : 77` beside the row `10.4.5.1 -
  10.4.5.254`; a pool with no `range` serves its whole subnet, and the range only narrows it. `range` is now
  optional, the derived range runs network+1 to broadcast-1 (every address for a /31 or /32), a half-typed
  range is still refused, and `no range` returns a pool to its subnet instead of marking it broken. The
  allocator also skips the gateway now, as `poolCapacity()` already claimed: a pool whose range covered .1
  was offering the router's own address to the first client that asked.
  `test/dhcp-range-is-optional.test.js` (21 checks) pins the derived range, the served lease, `show ip dhcp
  pool`'s subnet row and `no range`; source:
  [`Cisco SD-WAN DHCP server guide`](https://www.cisco.com/c/en/us/support/docs/routers/sd-wan/221087-configure-and-troubleshoot-a-dhcp-server.html).
- **The Catalyst 9300-48P was a PoE+ switch that could not source a watt.** Its own description said "48x 1G PoE+
  (437 W budget)" while the row carried no PSE port and no `poe` block, so `show power inline` answered "% No PoE ...
  no port on this device can supply power" and the budget fell through to the model-name parser (0 W, source `name`).
  Cisco's Catalyst 9300 data sheet prints the row in Table 1 (`C9300-48P | 48 POE+ | Modular Uplinks | 715W AC |
  437W`), the 437 W default (787/1152/1440 W with larger secondary supplies) in Table 3, and "PoE+ on all ports
  (30W per port)" in the PoE feature list. The row now declares `poe-pse`/802.3af/802.3at, 30 W on Gi1/0/1-48 and a
  437 W budget; the eight Gi1/1/x modular uplinks still source nothing, as the data sheet's "Modular Uplinks"
  column says. `test/c9300-48p-poe.test.js` (29 checks) pins the spec and the arithmetic: 17 Class-4 access points
  fit at 433.5 W and the 18th is refused with "25.5 W requested, 3.5 W left". Source:
  [`Catalyst 9300 Series data sheet`](https://www.cisco.com/c/en/us/products/collateral/switches/catalyst-9300-series-switches/nb-06-cat9300-ser-data-sheet-cte-en.html).
- **`show spanning-tree` had a `Type` column in the header's vocabulary and no cell under it.** Cisco derives
  RSTP's link type from the port's duplex - "The link type is automatically derived from the duplex mode of a
  port. A port that operates in full-duplex is assumed to be point-to-point, while a half-duplex port is
  considered as a shared port by default" (Cisco TAC 24062) - and every captured table prints it: the
  ntc-templates `Shr` rows on a box whose ports were half duplex, `Fa0/13  Desg FWD 19  128.13  P2p Edge` on a
  2960. This console printed four fields and stopped, so the one cell that tells an operator a link is a shared
  segment was missing. A row now ends `P2p` on a full-duplex port and `Shr` on a half-duplex one, read from the
  port the row names (a bundle's from its members, which `validateLag()` will not let disagree); two ends of a
  duplex mismatch print exactly the pair a box does. No row claims `Edge`, because `spanning-tree portfast` is a
  command this console refuses, and a port with no duplex answer prints `-` rather than a guessed link type.
  `test/stp-port-table-type-column.test.js` (33 checks); four suites that pin the table's header, rule and cells
  were updated; [`research/stp-port-table-type-column.md`](research/stp-port-table-type-column.md) records the
  sources and the four things still unwitnessed (`Edge`, `Peer(STP)`-style suffixes, the `link-type` override,
  and what a box prints for a port with no link).
- **`no channel-group 1 mode on` removed the port on a line the box refuses.** The setting form's grammar
  is `channel-group <n> mode {…}`; the undo's is `no channel-group` with no `mode` keyword — four command
  references print the pair, and a 2022 CCNA transcript shows the answer to the mixture:
  `% Invalid input detected at '^' marker.` This console read the id, discarded every word after it, and took
  the port out of the bundle, so a typo that hardware rejects changed the link and reported success. Any token
  after the id is now refused before membership is read and before the removal receipt is built —
  `% no channel-group takes the group number and nothing after it: the word "mode on" was not used, and
  nothing was changed` — while the bare form, the numbered form and `no channel-group 9999` are unchanged.
  `test/channel-group-undo-grammar.test.js` (20 checks);
  [`research/no-channel-group-undo-grammar.md`](research/no-channel-group-undo-grammar.md) records the syntax
  lines, the capture and the two things left unwitnessed (the caret line, other vendors' grammar).
- **`show arp` printed the panel's abbreviation where a box spells the interface out.** Every primary capture of
  this table prints the whole name - `Ethernet0/0` in the TAC command reference, `GigabitEthernet0/0/6` in the
  IOS XE ARP guide, `GigabitEthernet0/0/2` in the ASR FAQ this repo already quotes, `FastEthernet0/3/0/6` on a
  CRS - and none prints `Gi0/0/6`; a switch's rows read `Vlan1`, not `Vl1`. The console wrote the stored
  (faceplate) name straight into the cell, so the same box said `GigabitEthernet0/0` in
  `show ip interface brief` and `Gi0/0` one command later, and a row could not be diffed against a real
  device's. The Interface cell - the neighbour rows, the box's own local rows and a VRRP group's - now calls
  the same `ifaceName.displayName()` the brief table uses, and the conflict paragraph under the table names the
  port the same way; the stored name is untouched, so `interface GigabitEthernet0/0` typed from a row still
  resolves. `test/show-arp.test.js`, `test/show-arp-local-address.test.js`,
  `test/show-arp-vrrp-virtual-address.test.js`, `test/arp-ageing.test.js` and `test/arp-conflict.test.js` (132
  checks) now assert the printed cell is the recorded port **in the hardware's spelling**, three of them
  literally; [`research/show-arp-interface-spelling.md`](research/show-arp-interface-spelling.md) records the
  captures, the one contradicting (retyped) blog sample, and what is still unwitnessed.
- **`no ip address` refused the address the syntax line says it takes.** Cisco's `ip address` reference prints
  two syntax lines, and the second is `no ip address ip-address mask [secondary]`; a Cisco defect record's own
  workaround is an operator typing `no ip address 192.168.1.100 255.255.255.0` on a live SVI. This console
  answered every word after `no ip address` with `% no ip address takes no argument: ...`, so a configuration
  file that takes back one named address could not be replayed against a port holding another one - and the
  refusal was telling the reader the command has no such form. The two-word form is now accepted and the
  address is matched, mask included (a prefix length counts, as `ip address` takes one): a match removes the
  address and says which, a mismatch answers `% Invalid address: Fa0/1 holds 10.0.0.1/24, not 10.0.0.9/24 -
  nothing was removed` and leaves the configuration byte-identical — the answer the forum thread records, where
  the box printed `Invalid address` and the operator was told to match the current IP. `secondary` stays refused
  by name (one address per port), an address with no mask is `% Incomplete command`, a DHCP client is refused by
  name there because its address is leased rather than configured, and a word that is not an address keeps the
  refusal it had. `test/no-ip-address-named-form.test.js` (46 checks);
  [`research/no-ip-address-named-form.md`](research/no-ip-address-named-form.md) records what is witnessed and
  what is not — the full sentence around `Invalid address`, and whether the mask must match, are both still
  open.
- **`show ipv6 nd` swallowed every word after it.** The view takes no argument, so it printed the whole
  advertisement whatever followed - including the two words the operator has already typed in this very mode.
  `show ipv6 nd prefix`, the obvious way to ask which prefixes the box advertises, answered with the full block
  and never mentioned the word it had dropped, and a typo read as a complete answer too. It was the last `show`
  view that dropped a tail: every sibling refuses it through `showNoTail` (#1403, #2097). It now refuses the
  word by name, says what it does print, and points at the `Prefixes` block and `Interfaces` line that answer
  the narrower question. `test/show-argument-refusal.test.js` gains 13 checks; the two `cli.js:7744` citations
  in `docs/BGP-POLICY.md` were re-pointed to `_help()` now that the line moved.
- **`switchport mode` took a second word and obeyed the first one.** Every command reference prints the
  syntax as one keyword choice - `switchport mode {access | dot1q-tunnel | dynamic {auto | desirable} |
  private-vlan | trunk}`, and `no switchport mode {access | dot1q-tunnel | dynamic | trunk}` - and the same
  book's error table says a word outside that set gets `% Invalid input detected at '^' marker.` with nothing
  applied ([Catalyst 2960-S/2960-C 15.2(4)E commands](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-2_4_e/command/reference/cr_2960/cli3.pdf);
  the same line in the [2960-XR 15.2(5)E](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15-2_5_e/command_reference/b_1525e_consolidated_2960xr_cr/m_layer2_2960xr_cr.pdf)
  and [15.2(2)E](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15-2_2_e/consolidated_guide/command_reference/b_consolidated_2960-xr_1522e_cr/b_consolidated_2960-xr_1522e_cr_chapter_0100.pdf)
  books). This console read the second word and dropped the rest, so `switchport mode trunk access` - two modes
  on one line, the shape a half-edited paste produces - **made the port a trunk**, and `switchport mode access
  flurbish` set access, both without a word about the word. Both forms now refuse before anything is written:
  `% switchport mode trunk takes one mode and nothing after it: the word "access" was not used, and the mode is
  unchanged`, quoting the tail as typed, and `no switchport mode <mode> <word>` answers in the same shape. The
  port stays where it was - a refused `switchport mode access flurbish` on a working trunk leaves it a trunk,
  `allowedVlans: all` included - and `show running-config` does not move. `switchport mode dynamic auto` keeps
  the usage line that names the two modes this console has, because `dynamic` is a two-word value in the
  vendor's grammar rather than a trailing typo. `test/switchport-mode-grammar.test.js` (23 checks),
  [`research/switchport-mode-grammar.md`](research/switchport-mode-grammar.md); the
  `no-command-swallows-a-word` sweep gains the two cases and now snapshots each port's switchport settings, so
  its "no refused command wrote configuration" check can see a mode change at all (it could not before: the
  settings live on the interface, not in `config`). Pre-fix that sweep fails with
  `Switchport mode trunk on Fa0/2`.

- **`interface range` is a command the box has, and the console called it a missing port.** A Catalyst takes
  `interface range {port-range | macro macro_name}`, enters `(config-if-range)#`, and applies each line typed
  there to every port in the range - `Device(config)# interface range tengigabitethernet 1/1/1-2` then
  `Device(config-if-range)# shut` ([IOS XE 17 Interface Characteristics Configuration Guide](https://www.cisco.com/c/en/us/td/docs/switches/lan/c9000/infra/interface-characteristics/interface-characteristics-configuration-guide.html);
  the [Catalyst 2960 command reference, 12.2(44)SE](http://www.cisco.com/en/US/docs/switches/lan/catalyst2960/software/release/12.2_44_se/command/reference/cli1.html)
  prints the same prompt for `interface range gigabitethernet0/1 - 2`). This console opens one port per line,
  so it answered `% Interface not found: range Fa0/1 - 3` - the sentence a misspelt socket gets, about a
  command the box really has, which sends the reader looking for a port called `range`. The keyword is now
  refused by name in the shape of the `vlan 10-12` list refusal - what a box does, what this console does, and
  that no port was opened - and `no interface range ...` ends `nothing was removed`. The refusal changes
  nothing: no port opens, the cursor stays where the line was typed (the rule in
  [`research/interface-refusal-mode.md`](research/interface-refusal-mode.md)), and `show running-config` is
  unchanged. A line with no keyword (`interface Fa0/1 - 3`) is still a port name and keeps the
  missing-socket sentence. `test/interface-range-refusal.test.js` (42 assertions in 8 tests),
  [`research/interface-range-refusal.md`](research/interface-range-refusal.md).

- **A catalogue audit called 33 fibre devices copper, and no job ran it.** `scripts/audit-devices.js`
  answered "does this description promise optics the ports cannot deliver?" from its own
  `OPTICAL_CAGES = ['sfp','sfp+','sfp28','qsfp+','qsfp28']`, so every Fibre Channel cage
  (`brocade/g720`, `dell/ds-6630b`, `hpe/sn3600b` — `fc-sfpdd`, `fc-sfp28`, `fc-qsfp28`) and every PON
  connector (28 GPON ONTs on `sc-apc`/`sc-upc`) read as copper: **33 findings, none of them a defect**,
  against `0` from the invariant that gates the same rule. Both now call `isOpticalCage()` in
  `engine/media.js`, which reads the cage table the engine cables from, and both strip an
  "optional/unfitted module" clause — `watchguard/firebox-m290` and `microsemi/syncserver-s600` ship
  copper and name an unfitted SFP option, which is documentation, not a promise. The denial strip also
  runs before the clause split now: `SFP: none` used to be split at the colon into a bare `SFP`.
  `test/audit-agreement.test.js` (11 checks) pins the three shapes that were wrong, the control that
  must still fail, and the catalogue-wide agreement between the audit's answer and the invariant's
  (0 vs 0). The script is now part of `npm test` — 0.43 s — instead of a tool `CHANGELOG` advertised
  and no job ran. Both audits' verdicts now name what they gated and what they only reported
  (`audit-port-types`: "Gated: 0 … Reported, not gated: 2,704"). See
  [`docs/plans/catalogue-audit-agreement.md`](docs/plans/catalogue-audit-agreement.md).

- **`ip default-gateway` is inert on a box that routes, and a DHCP lease is not it.**
  With `ip routing` enabled, `show ip route` printed `S*  0.0.0.0/0  [254/0] via <gw>` under the line
  `Gateway of last resort is not set` - a row no box installs - and `routeTo()` sent uncovered destinations to
  it, so a lab that configured only `ip default-gateway` forwarded traffic the device drops. The vendor scopes
  the command to "when IP routing is disabled on a device" ([Cisco IOS IP Routing: Protocol-Independent
  Configuration Guide, 16.11](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/configuration/xe-16-11/iri-xe-16-11-book.pdf);
  [Catalyst 3750 configuration guide](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3750/software/release/12-2_50_se/configuration/guide/scg/swiprout.pdf)),
  and operators see it retained but unused ([Cisco Community](https://community.cisco.com/t5/routing/ip-routing-command-on-a-layer-2-switch/td-p/582837)).
  The gateway now forwards only while routing is off, and the line stays in `show running-config` because the box
  keeps it. A routing box that takes its address by DHCP still gets a default route at distance 254 from the
  lease - `S*  0.0.0.0/0  [254/0] via <router>` - which is a different mechanism and stays absent from the file.
  (`research/ip-default-gateway-when-routing.md`.)

- **`ip route` takes the vendor's fully specified form: interface first, next hop after it.**
  `ip route 10.2.3.0 255.255.255.0 Gi0/0/0 10.1.2.2` was refused as
  `% 10.2.3.0/24: no interface called "10.1.2.2"`, because every word past the fifth was read as a port name
  or a distance. The vendor's syntax is `ip route prefix mask { ip-address | interface-type interface-number
  [ip-address] } [distance]` ([Cisco IOS IP Routing: Protocol-Independent Command Reference, `ip route`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/iri-cr-book/iri-cr-a1.html)),
  and a CCNA lab types that line and gets `S 10.2.3.0/24 [1/0] via 10.1.2.2, GigabitEthernet0/0/0`
  ([lab 6.1.2](https://itexamanswers.net/6-1-2-lab-investigate-static-routes-answers.html)). An address in
  that slot is now the next hop, a second one is refused by name, and the `no` form reads the same slots -
  which fixes `no ip route <prefix> <mask> <iface>`, previously `% Route not found` for a route that was in
  the table. `test/ip-route-fully-specified.test.js` (24 checks),
  [research/ip-route-fully-specified.md](research/ip-route-fully-specified.md).
- **`show spanning-tree` prints the `Role` and `Sts` cells a box prints, not the detail view's sentence.**
  The table read `Fa0/1  alternate  blocking  (traffic dropped)`. A Cisco table abbreviates -
  `Fa0/13  Desg FWD 19  128.13  P2p`, `Gi0/1  Root FWD 4  128.25  P2p`, `Gi0/2  Altn BLK 4  128.26  P2p` -
  and the command reference's field table fixes those values (`Desg`, `Root`, `Altn`; `BLK`, `LTN`, `LRN`,
  `FWD`, ...), while `Port 1 (...) of VLAN0001 is alternate blocking` is the wording of
  `show spanning-tree detail`. `(traffic dropped)` is not a device string in any view. The table now maps
  the engine's roles and states through `stpRoleCell()`/`stpStateCell()`, including the converging
  `LTN`/`LRN` cells, and the detail-view sentence stays in the payload and tooltip, where a sentence
  belongs. `test/stp-port-table-role-and-sts.test.js` (26 checks),
  [research/stp-port-table-role-and-sts.md](research/stp-port-table-role-and-sts.md).
- **A subinterface's number is a name, not a VLAN id.** `interface Gi0/0.5000` was refused as
  `% VLAN out of range: 5000`, because the number after the dot was checked against the 802.1Q range. On IOS
  the subinterface number runs 1 to 4294967293 and the VLAN is set separately by `encapsulation dot1q`
  (1 to 4094); the two need not match ([Cisco IOS `interface`](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/interface.htm),
  [Cisco Press, *VLAN Routing with Router 802.1Q Trunks*](https://www.ciscopress.com/articles/article.asp?p=2990405&seqNum=2)).
  The name now opens, carries no tag until `encapsulation dot1q` is typed (no `encapsulation dot1q null`
  line is printed), and the tag stored is the one typed - a `.5000` port can terminate VLAN 100. A number
  outside 1-4294967293 is refused as a number, and the one-line `.10` form still writes
  `encapsulation dot1q 10`. A `.5000` subinterface also survives save/load, which keyed its rebuild on
  `encapVid` and dropped it. `test/subinterface-number.test.js` (8 checks),
  [research/subinterface-number.md](research/subinterface-number.md).
- **`show ip ospf interface brief` answers as a view, not as a port that is missing.** `brief` is a keyword
  of the command — `show ip [ospf] [process-id] interface [type number] [brief]` — and its table is the
  one-line-per-interface view every IOS box prints: `Interface    PID   Area            IP Address/Mask
  Cost  State Nbrs F/C` ([Cisco IOS OSPF Command Reference](http://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_ospf/command/iro-cr-book/ospf-s1.html);
  the widths are measured off the Academy multiarea lab's `Se0/0/0      1     0               192.168.12.1/30
  781   P2P   1/1`). This console read the word as a port name and answered `% No interface brief on <box>`,
  the sentence a misspelt port gets, about a command the box really has. It now refuses the view by name,
  prints the header it would have, and names the one cell no other view stands in for — the `PID`, which is
  the id from `router ospf <process-id>`, a command this console does not model — then points at
  `show ip ospf interface [<port>]`. The table is not printed with `PID` or `State` filled in from nothing:
  the State election here runs only across a cable with two speakers, and the `C` half of `Nbrs F/C` counts
  neighbours *detected*, a state the engine does not record. A port genuinely named `brief` still wins over
  the keyword. `test/show-ip-ospf-interface-brief.test.js` (16 checks) pins the refusal, the header at the
  measured widths, four abbreviations and the three views that already worked
  ([research/show-ip-ospf-interface-brief.md](research/show-ip-ospf-interface-brief.md)).
- **`show mac address-table` puts the VLAN id in a right-aligned field, not in column 0.** The first column is a
  four-character field whose right edge is the last dash of the heading's `----` rule: a learned entry in VLAN 1
  prints `   1`, VLAN 87 `  87`, and the reserved block's `All` prints ` All` — the word is a value in the same
  field, not a left-hand label. Machine-recorded Catalyst sessions keep the spaces that Cisco's HTML collapses
  (` All    0100.0ccc.cccc    STATIC      CPU` / `   1    30a3.30a3.a1c3    DYNAMIC     Po1`
  [raw capture](https://github.com/networktocode/ntc-templates/blob/master/tests/cisco_ios/show_mac-address-table/cisco_ios_show_mac-address-table4.raw),
  a second capture with a two-digit id, and the NetAcad 7.2.7 lab's PDF). This table printed every id in column 0,
  the shape a browser-wrapped paste shows, so the one column an operator scans for an entry's VLAN was in the
  wrong place on every row (`research/mac-table-vlan-cell.md`). The console's own `Age` column widens the field to
  eight characters, so the value keeps the device's right edge (column 3) and the MAC cell keeps column 8
  (`test/mac-table-vlan-cell.test.js`, 15 checks).
- **`show vlan brief` names an access EtherChannel by the bundle, not by its members.** A working two-member
  bundle in VLAN 10 printed `Fa0/2, Fa0/3` in the Ports cell — the cables a frame might cross — while
  `show etherchannel summary` on the same box printed `Po1(SU)` over those two members. An IOU switch with
  `Et0/0`-`Et0/1` bundled and `switchport access vlan 10` on the members prints `10 VLAN0010 active Po1` and
  an empty VLAN 1 row ([EtherChannel lab](https://lkjil1224.tistory.com/70)); NX-OS and the vendor's
  `show vlan-switch` sample agree (`research/show-vlan-brief-etherchannel.md`). A member that never negotiated
  is still a single link and keeps its own name, and the bundle is printed after the physical ports
  (`test/vlan-brief-etherchannel.test.js`, 13 checks).
- **`show ip bgp summary` prints the prefix count its last cell is for, not the word `Established`.** The
  column is the box's `State/PfxRcd`, and a device puts a *number* there while the session is up — the
  prefixes received from that neighbour — and the FSM word (`Idle`, `Active`, `Connect`, `OpenSent`,
  `OpenConfirm`) while it is not: *"you won't see the word 'Established' in the output of the show … summary
  command: rather, you'll see the number of prefixes received from the neighbor"*
  ([Noction](https://www.noction.com/blog/debugging-bgp-states); Dell's field description says the same,
  [`show ip bgp summary`](https://www.dell.com/support/manuals/en-lt/dell-emc-os-9/s4048t-on-9.14.2.6-cli-pub/show-ip-bgp-summary)).
  This table printed `Established` on every live row, so a reader comparing it with a capture found a value no
  box produces and could not answer the question the column is opened for: is my peer sending me anything?
  `Simulator.computeBgp()` now counts, per neighbour, the prefixes that neighbour sent (from the candidate
  lists, so a prefix a better path keeps out of the forwarding table is still counted — the same distinction
  the `N more received, not installed` line already draws), and the cell prints that number; a down session
  keeps `Idle`, the word Cisco's own capture shows for a peer with no route
  ([Troubleshoot BGP Basic Issues](https://www.cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/218027-troubleshoot-border-gateway-protocol-bas.html)).
  The `Reason` column beside it, the `N of M neighbour(s) established` line and the prefix table are
  unchanged, and the ten-column box layout (`MsgRcvd`, `MsgSent`, `TblVer`, `InQ`, `OutQ`, `Up/Down`) is not
  invented — the model keeps none of those counters.
  `test/bgp-summary-state-cell.test.js` (11 checks) pins the header, the count, the `Idle` cell and the
  absence of the word in the table; `test/bgp-session.test.js` now measures the cell instead of the word, and
  `docs/CLI.md`'s sample follows.
  [research/show-ip-bgp-summary-state-cell.md](research/show-ip-bgp-summary-state-cell.md) has the captures,
  the fault-to-word table and what is still open (the Adj-RIB-In boundary and the `Up/Down` formats).

- **`show ip route` spells the port out, and separates it from the next hop with a comma.** The row printed the
  catalogue's panel name — `C 10.0.1.0/24 is directly connected, Gi0/0` — where every capture of this command
  writes the type word in full (`GigabitEthernet0/0`, `Ethernet2`, `Serial0/0/1`, `Tunnel0`), and it put two
  spaces where the box puts `, `: `S 10.8.0.0/16 [1/0] via 10.9.0.9, GigabitEthernet0/0`. The row is a sentence,
  not a table cell, which is the rule `show ip ospf neighbor` and `show ip interface brief` already follow; the
  interface now goes through the same `displayName()` expansion. The spelling is resolved once in
  `Device.routesTable()` (`ifaceDisplay`) and read by both surfaces, so the inspector's Routes panel and the
  console cannot name the same port differently, while the stored `iface` stays the key `routeTo()` forwards by.
  A protocol-learned row on the hardware carries the route's age between the two (`via 10.119.254.6, 0:01:00,
  Ethernet2`); this engine does not track it and prints no substitute.
  `test/show-ip-route-interface-spelling.test.js` (12 checks) pins the spelling, the comma, the next-hop-only row
  with no dangling comma and the absence of an invented age; four suites that measured the old cell now measure
  the rule (`show-ip-route`, `show-ip-route-static-via-interface`, `local-route-row`,
  `ospf-adjacency-link-state`), and `docs/CLI.md`'s samples follow.
  [research/show-ip-route-interface-spelling.md](research/show-ip-route-interface-spelling.md) has the captures,
  the teaching pages that paraphrase with `Gi0/1`, and what is still open (the age field, and whether any image
  ever abbreviates here).

- **`show ip ospf neighbor` names the port in full, the way the box does.** The Interface cell printed the
  catalogue's panel spelling (`Gi0/0/0`) where every capture of this command spells the port out: the ntc-templates
  raw file this table's widths were measured on reads `Port-channel1` and `Vlan1000`, Cisco's `13688-16` sample ends
  `Ethernet0`, and the Cisco Press OSPFv2 chapter's three rows read `GigabitEthernet0/0/1..3`. The cell now goes
  through the same `displayName()` expansion `show ip interface brief` and the `%OSPF: OSPF not enabled on …`
  sentence already use, so `Gi0/0/0` prints as `GigabitEthernet0/0/0` and a row on a gigabit port reaches column 86
  - which the box's does too, and nothing wraps it here. `show ip ospf interface brief` keeps the abbreviation
  (`Et0/2` in Cisco's own note), so the two commands in this family still spell the same port differently, as they
  do on hardware. `test/show-ospf.test.js` pins the long cell, the absence of the short one and the 86-column row;
  [research/ospf-neighbor-table-layout.md](research/ospf-neighbor-table-layout.md) has the four captures, the one
  hand-typed blog row that disagrees (`Gig0/0`) and what is still open (a paste from a very long port name).

- **A `ping` ends at the success rate, because a box prints no sentence per echo.** Each echo is reported as one
  character of the marks line (`!`, `.`, `U`) and the run closes with `Success rate is N percent (n/m)` - the round
  trip riding on that line as `, round-trip min/avg/max = a/b/c ms` when anything came back. This console appended
  `Reply from <address>: bytes=100 time=<rtt> ms` for every answered echo and `Request timed out (seq N)` for every
  lost one, which is **Windows** `ping`'s output shape (`bytes=` and all - Cisco's own BRKTRS-2811 deck prints
  `Reply from 10.10.30.27: bytes=100 time<1ms TTL=126` from a `C:\>` prompt beside IOS captures of `!!!!!`), so the
  report was IOS's marks line followed by another operating system's reply lines. `_pingReplyLines()` is now the
  marks line and the rate only, for both address families; the `% Echoes lost:` sentence stays, because it is the
  console's own explanation of a drop and carries the reason. `test/ping-report-shape.test.js` (29 checks) pins the
  four-line success report, the total-loss report with its `%` explanation, a fabricated 4/5 run, IPv6 parity and
  the absence of `bytes=`; eight suites that had measured the old shape now measure the rule
  (`ping-default-count`, `ping-ipv6`, `ping-own-address`, `ping-loss-reason`, `ping-unreachable-letter`,
  `dns-console`, `convergence-timing`, `ping-round-trip-clause`), and `docs/CLI.md` / `docs/ARCHITECTURE.md` drop
  every reply line from their examples. [research/ping-report-shape.md](research/ping-report-shape.md) has the
  captures and the three things still open (an IOS ICMP-error sentence, NX-OS/IOS-XR, and what to say when a path
  carries no modelled delay).

- **`show etherchannel <group> summary` takes the group number, and the counts stay the box's.** A real box
  accepts a channel-group number in front of the keyword — the 2960-X, 9500 and 9200 command references print
  their example in that form — and narrows the table to that group's row while the nine-line key and both counts
  are printed exactly as the unfiltered view prints them. A two-group box answers `show etherchannel 2 summary`
  with `Number of channel-groups in use: 2` and one row; the same command on a box holding only group 2 answers
  `1` (a training lab with both switches, and a 2960-S thread). This console refused the number as though it were
  a typo: `% show etherchannel does not take "1": every group is listed - each group is headed by its number`,
  which sent an operator who copied a line from a vendor document back to the whole table. The number is now read
  before the keyword (with or without one, under either spelling of the view), the table keeps the named group's
  rows, both counts still describe the device, and a number that names no group prints the furniture over no
  rows — the shape an empty box already prints. A word the view cannot use is still refused, now with the advice
  that a group number is what narrows the table. `test/show-etherchannel-group-summary.test.js` (25 checks) pins
  the filtered and unfiltered tables, the counts, the empty selection, the alias and both refusals;
  [research/show-etherchannel-group-summary.md](research/show-etherchannel-group-summary.md) carries the
  captures and the two things still open (a number naming no group, and one outside the platform's range).
- **The `Codes:` legend above `show ip route` is the image's nine lines, not one line of this console's codes.**
  A box prints its whole code list on every `show ip route`, whether or not a route uses any of it: at IOS 15.2E
  that is nine lines, breaking after `B - BGP`, with every continuation starting at column 7 so each code lines
  up under the `L` - `D - EIGRP`, `EX`, `O`/`IA`, `N1`/`N2`, `E1`/`E2`, the five IS-IS codes, `ia`, `*`, `U`,
  `o - ODR`, `P`, `H - NHRP`, `l - LISP`, `a - application route` and the `+`/`%`/`p` line. This console printed
  one 85-column line naming the six codes its own table can emit, so a reader comparing a captured table against
  this one found a shape no box produces. The set and the shape are one object on the hardware, so they are one
  object here: `IP_ROUTE_CODES_LEGEND` in `engine/cli.js` is the 15.2E Catalyst block, character for character,
  and a box that does not route still prints no legend at all (it has no table). IOS XE 16/17 prints a longer
  block of its own - `m - OMP`, four NAT codes, three NHRP codes - which `research/show-ip-route-codes-legend.md`
  records along with the 15.0 variant, the three captures that fix the indent, and the one thing still open (a
  fixed-config 9200 at 17.x). `test/show-ip-route-codes-legend.test.js` (17 checks) pins the nine lines, the
  column, the codes the table can emit and the gateway sentence's place under the block.
- **A router's own interface address is a row in `show ip route`, and the box prints it.** Configuring
  `ip address 10.1.1.1 255.255.255.252` installs two rows on IOS, one line apart: the connected subnet
  (`C 10.1.1.0/30 is directly connected, Ethernet0/0`) and the address itself as a `/32` local host route
  (`L 10.1.1.1/32 is directly connected, Ethernet0/0`). Cisco's note on local host routes states the rule,
  prints the pair, and gives the exception - an address configured with a `/32` mask "appears in the routing
  table only as connected (it has the C flag)" - plus the two numbers that belong to the row: distance 0, the
  same as the connected route, and never redistributed by `redistribute connected`. This console printed only
  the connected row, so the address a technician had just typed was missing from the table they were told to
  check it in, and `ping <own address>` succeeded with no row explaining why. `routesTable()` now emits the
  row beside its subnet, priced at distance 0, taking its fault note from the same port; the `show ip route`
  legend leads with `L - local` and keeps the box's order (`B` before `O`). A `/32` address still prints one
  row, and a box that does not route is untouched. `test/local-route-row.test.js` (23 checks) pins the pair,
  its order and wording, the distance, the `/32` case, the shut-port withdrawal, the non-routing switch and
  the receive-entry distinction from `routeTo()`;
  [research/local-route-in-show-ip-route.md](research/local-route-in-show-ip-route.md) cites the pages and
  records what is still open (the classful heading lines, the 12.x table, a `/31`).
- **A `show running-config` stanza header spells the interface type in full.** The printer headed every
  block with the catalogue's panel spelling, so a factory 2960-X printed 28 stanzas reading
  `interface Gi1/0/1` … `interface Gi1/0/28` where a box prints `GigabitEthernet1/0/1` - and prints the
  same header however the `interface` command was typed. A Catalyst's own
  `show running-config interface fastEthernet 0/6` comes back headed `interface FastEthernet0/6`, a
  9200's `show running-config interface gigabitethernet1/0/1` is headed `interface GigabitEthernet1/0/1`,
  and the 4000 Series ISR's default configuration goes `interface GigabitEthernet0/0/0` / `no ip address` /
  `negotiation auto` / `!`. The header now goes through the same `displayName()` the brief table uses, so
  the two vendor-shaped views cannot name one port two ways, a subinterface keeps its tag after the
  expanded parent (`GigabitEthernet1/0/3.10`), and a name the table does not know - UniFi's `Port 1`,
  RouterOS's `eth1` - is printed untouched. The panel name stays the key, `show interfaces` still heads
  its block with `Gi1/0/1`, and the printed file still replays byte-identically.
  `test/running-config-interface-name.test.js` (34 checks) pins every header, the three typed spellings,
  the subinterface, the router and VRP spellings, the untouched names, the agreement with
  `show ip interface brief`, and the round trip;
  [research/running-config-interface-name.md](research/running-config-interface-name.md) cites the pages
  and records what is still open (the capitalisation of the type word, types the table does not know).
- **A router advertises the `/64` it holds as an interface address, without an `ipv6 nd prefix` line.** Cisco's
  `ipv6 nd prefix` reference states the default in its Usage Guidelines — "By default, prefixes configured as
  addresses on an interface using the ipv6 address command are advertised in router advertisements" — with a
  2,592,000 s valid / 604,800 s preferred lifetime and L=A=1; the same parameters, restated for IOS XE, ASA and
  the small-business switch line. The engine built its advertisement from `config.ra.prefixes` alone, so a router
  with `ipv6 address 2001:db8:1::1/64` and nothing else advertised a default router and no prefix: a host
  configured for autoconfiguration learned a gateway and formed no address, which is the opposite of what IPv6
  does out of the box. `ra.js` now derives the option from each `/64` interface address and merges it with the
  configured list, a configured entry replacing its own prefix's parameters and only that prefix;
  `show ipv6 nd` reads the same two helpers, prints the automatic rows with a `source` column and counts how many
  came from an address, so the report and the wire cannot disagree. `test/ipv6-ra-advertises-interface-prefix.test.js`
  (31 checks) pins the default announcement, the encoded option, the host's address, the override, the additive
  case and the `/48` that is deliberately not turned into a `/64`;
  [research/ipv6-ra-advertises-interface-prefix.md](research/ipv6-ra-advertises-interface-prefix.md) records the
  one vendor sentence that argues for replacing every automatic prefix, and the `no-advertise` keyword this
  console still lacks.

- **An empty `show lldp neighbors` ends with `Total entries displayed: 0`, the line a box prints.** The count
  line was added for a table with rows and deliberately withheld from an empty one, because no vendor page in
  hand showed an empty neighbour table. The captures now in hand do: a Catalyst 9300 with dot1x holding the
  phone's LLDPDUs back goes from the column heading straight to `Total entries displayed: 0`, another 9300
  asked about one port with nothing on it does the same in the filtered view, an IOS router that had just been
  given `lldp run` prints it under the heading, and Cisco's own IOS XE release notes print the zero for a
  filtered `show lldp entry *`. The count was always the number of rows the view printed, so zero is the same
  rule as four; only the evidence was missing. The sentence above it stays, because the number cannot say
  whether the table is empty because nothing was ever heard or because every entry ran past its hold-time -
  a box prints the same zero for both. `test/lldp-total-entries.test.js` (21 checks) pins both empty states,
  the position of the line and the filled cases;
  [research/lldp-total-entries.md](research/lldp-total-entries.md) has the five captures and what is left
  open.

- **A probe answered with an ICMP unreachable is marked `U`, not `.`.** `ping` printed one character per
  echo from the echo-reply table alone, so an echo a router had answered with destination-unreachable looked
  exactly like an echo into a dead cable: `..`, a `Request timed out` line per probe, and the same success
  rate. A box keeps the two apart - `U` "A destination unreachable error PDU was received", `.` "the network
  server timed out as it waits for a reply" - and spells `U` for **any** type-3 code, the opposite of
  `traceroute`'s `!H`/`!N` letters, which this console already implements from the same page (Cisco doc 12778,
  whose own worked example prints `U.U.U` for a code-1 answer). The engine had recorded every received error
  per `seq` since `_forwardL3` learned to answer one and no caller read it: the ping reply now carries
  `unreachable`, `unreachableFrom`, `errorType` and `errorCode`, and the view prints the letter and no
  contradictory per-echo sentence. A source-side `no route` (a box that cannot route its own echo) stays a
  timeout, because the only vendor capture of that case has the marks line buried under `debug ip packet` -
  `test/ping-unreachable-letter.test.js` (18 checks) pins that open half on purpose;
  [research/ping-unreachable-letter.md](research/ping-unreachable-letter.md) cites six vendor pages and lists
  what a clean capture would settle.
- **`show ip ospf interface <port>` answers a port with no OSPF on it the way a box does.** The view picked the
  reason itself and printed `% Gi0/1 has no address: OSPF needs one to form an adjacency` or `% Gi0/1 is not in
  OSPF`. A router prints one tagged system message instead - `%OSPF: OSPF not enabled on GigabitEthernet0/0/2` -
  with the tag glued to the percent sign, no `is`, the port in its long type spelling, and no reason at all:
  Cisco's own Frame Relay OSPF guide prints it for an unaddressed Serial0 while the same box prints the full
  block for s0.1, a Catalyst paste has it for an L2 access port (`%OSPF: OSPF not enabled on
  GigabitEthernet9/1`), and two networklessons captures add a FastEthernet and a Loopback. Both invented
  sentences are gone; the reason is still readable in `show ip interface brief` and `show running-config`. The
  name is expanded by the same table `show ip interface brief` uses, so one port cannot be named two ways by two
  views. The administratively-down branch and the no-such-port sentence are unchanged, because no capture was
  found for either. `test/show-ospf-interface-not-enabled.test.js` (12 checks) pins the sentence, the one-line
  shape, three spellings of one port and the untouched branches;
  [research/show-ospf-interface-not-enabled.md](research/show-ospf-interface-not-enabled.md) cites the five
  captures and lists what a paste from a live box would still settle.
- **`show running-config` ends an interface stanza with `!`, the line a box prints.** The printer wrote
  `exit` after every interface block - on a 24-port switch, 24 `exit` lines in a row - because #1230 needed
  the parser to leave interface mode before the next block. No box prints `exit` in this file: the Cisco
  4000 Series ISRs' own default configuration goes `interface GigabitEthernet0/0/0` / `no ip address` /
  `negotiation auto` / `!` / `interface GigabitEthernet0/0/1` ..., the IOS 11.2 `show running-config`
  sample separates every stanza with `!` and closes with `end`, and `exit` is documented as a command that
  leaves a mode. The parser no longer needs the line - a new `interface` line inside interface mode is a
  mode switch, and a global command at an interface prompt is applied in global config - so the separator
  is now the character a box writes, and a config copied off a real device (which has `!` and no `exit`) is
  read back onto the same ports. The `ip dhcp pool` stanza still closes with `exit`, because `!` is read as
  a comment here rather than as a mode exit; that question is open.
  `test/running-config-stanza-separator.test.js` (17 checks) pins the stanza shape, the last block above
  `end`, a byte-identical replay and a vendor-shaped paste;
  [research/running-config-stanza-separator.md](research/running-config-stanza-separator.md) cites the pages
  and lists what a `!` does at a real submode prompt, which would settle the rest.
- **A Catalyst 2960X-48FPS-L is 48 PoE+ ports with a 740 W budget, and the catalogue gave it no power to
  give.** The spec's own description said "48x 1G PoE+ downlinks (740 W budget)", but its port template
  declared no `poeOut` and the spec no `poe` block, so the device's budget was 0 W, `show power inline`
  answered `% No PoE on Catalyst 2960X-48FPS-L-sw1: no port on this device can supply power`, and an access
  point cabled to Gi1/0/1 stayed dark. Cisco's 2960-X hardware installation guide lists the model as "48
  10/100/1000 PoE+ ports (PoE budget of 740 W) and 4 SFP module slots", and its technical specifications as
  "30 W-per-port maximum, 740-W switch maximum (Catalyst 2960X-48FPD-L and 2960X-48FPS-L switches)". The 48
  copper ports now source 802.3at out of 740 W; the four SFP cages still source nothing.
  `test/c2960x-48fps-poe.test.js` (29 checks) pins the budget, every PSE port, the 24-AP fleet that fits and
  the 30th AP that is denied; [research/catalyst-2960x-poe-budget.md](research/catalyst-2960x-poe-budget.md)
  cites the pages and records what a real `show power inline` would still settle.
- **`show access-lists` spells a standard entry the way a box does.** The table echoed each rule as it
  had been typed, so a standard list read `permit 192.168.1.0 0.0.0.255` and `deny host 10.0.1.10` where
  every IOS prints `permit 192.168.1.0, wildcard bits 0.0.0.255` and `deny 10.0.1.10` - the comma form, and
  a host as the bare address with no `host` keyword (`any` stays `any`). `engine/acl.js` now renders the
  body from the parsed source (`displayBody()`), and `engine/cli.js` asks it for standard entries only,
  keeping the typed line for the extended form (which already matched the captures: `host` kept, no comma)
  and for any entry with no parsed source. Sequence numbers, the four-column indent, the match counter and
  `show running-config` are unchanged. `test/show-access-lists-standard-address-form.test.js` (17 checks)
  pins all of it;
  [research/show-access-lists-standard-address-form.md](research/show-access-lists-standard-address-form.md)
  lists what is still open (the `permit`/`deny` padding, and whether an all-ones wildcard typed numerically
  folds into `any`).
- **IPv6 router advertisements are on before anybody asks.** `show ipv6 nd` on a device that had only
  been given an address answered `Advertise : disabled  (ipv6 nd ra enable to start)`, and SLAAC therefore
  needed a command no Cisco console teaches: the vendor's `ipv6 nd ra suppress` reference states the
  Command Default as "IPv6 router advertisements are automatically sent on Ethernet and FDDI interfaces if
  IPv6 unicast routing is enabled", and `show ipv6 interface` on a freshly addressed port already prints
  "ND router advertisements are sent every 200 seconds". Advertising is now the default; `ipv6 nd ra
  disable` and `ipv6 nd suppress-ra` are the two ways off, `enable` answers that the box is already
  advertising, and only an explicit off reaches `show running-config`. A port that carries no IPv6 address
  advertises nothing - `linkLocal6()` will derive a link-local for any MAC, so the forwarding path now
  checks the port rather than trusting the default. `test/ipv6-ra-default.test.js` (19 checks) pins the
  fresh-router advertisement, the report's wording, the saved off switch, the silent IPv4-only port and
  `suppress-ra`'s solicited answer;
  [research/ipv6-ra-default.md](research/ipv6-ra-default.md) cites the four vendor pages and lists what is
  still open (the 200 s interval, which is not modelled, and prefixes that a box derives from its own
  addresses rather than from `ipv6 nd prefix`).
- **A switch's MAC table starts with the twenty rows nobody learned.** `show mac address-table` on a switch
  nobody had configured printed an empty table and `Total Mac Addresses for this criterion: 0`. A real Catalyst
  forwards a fixed set of addresses to its own CPU - CDP's two, the `0180.c200.0000`-`0010` group-address run
  (spanning tree, LACP, LLDP among them) and the all-nodes broadcast - and prints them as `All … STATIC … CPU`
  above the learned rows, counting them in the
  total: a factory-default 2960 reads 20, and the same box with one address learned reads 21 (a 12.2SE paste at
  brezular.com/2010/10/10/mac-flooding-attack-2; Cisco's own CCNA lab shows the same twenty over two learned
  rows and closes at 22). They belong to no VLAN and to no port, so they appear only in the unfiltered view, and
  only on a device whose category is a switch - a PC answering the same command still gets an empty table. The
  IOS XE family prints one more row, `0180.c200.0021`, which this console does not print for any model.
  `test/mac-table-reserved-rows.test.js` (22 checks) pins the set, its order, the four cells, the placement above
  the learned rows, the counted total and the filtered view;
  [research/mac-table-reserved-rows.md](research/mac-table-reserved-rows.md) records the 20-versus-21 split and
  why the eleven-row `0000.0000.000x` sample in Cisco's current 2960-X/2960-L/1000 references was read as
  documentation boilerplate rather than a transcript - the same eleven rows are in Hikvision's and SNR's
  manuals, and the same page contradicts itself a few paragraphs later.
- **The Interface column of `show ip interface brief` spells the type out.** Every published capture of the
  command prints `GigabitEthernet1/0/1`, `FastEthernet0/1` and `Vlan1`; this console printed the catalogue's
  short spelling (`Gi1/0/1`) under the vendor's header - and that header's 23-column Interface field is
  exactly the room `TenGigabitEthernet1/1/1` needs, so the table was drawn for the long word and filled with
  the short one. Rows now print the vendor's spelling (`displayName()` in `engine/iface-name.js`, from a table
  of the IOS-style abbreviations only: `eth1`/`Eth1/1` are vendor spellings and pass through untouched), while
  the stored name, `show running-config` and every lookup key stay on the panel's short form - so a name
  pasted out of the table still resolves. `show interfaces` keeps the panel name by its own tested rule, the
  same split a bundle already has (`Port-channel1` in the brief table, `Po1` in the summary). The samples, and
  what is still open (a name wider than the column, a vendor that prints neither spelling), are in
  [research/interface-brief-name-spelling.md](research/interface-brief-name-spelling.md).
- **Opening configuration mode prints the sentence a box prints.** `configure terminal` answered in silence,
  so the first line of every captured IOS session - the vendor's
  `Enter configuration commands, one per line.  End with CNTL/Z.` - was missing from a transcript a reader
  compares against their own console, and the only sign of the mode change was the prompt, which a pasted
  config does not show. The sentence is now the command's
  answer, printed once per entry and by no config command or submode after it. It is one line with two spaces
  after `line.` - the half no HTML page can settle, because browsers collapse the run of spaces and two of the
  vendor's own pages wrap the sentence across two lines; the PDF's Courier text layer keeps both. The string,
  its placement and the "once per entry" rule are pinned by `test/config-mode-greeting.test.js`, and the pages
  that disagree are in [research/config-mode-greeting.md](research/config-mode-greeting.md).
- **`show ip interface brief` lists the EtherChannel, not only its members.** An EtherChannel is an interface,
  and a box prints its row beside the ports that make it up: `Port-channel2 unassigned YES unset up up` on a
  3850, `Port-channel1 ... down down` on an FTD whose members were suspended, and a 3750X table that ends
  `Port-channel1 ... up up` / `Port-channel20 ... down down` after `Te1/1/2`. This console's table listed
  twenty-eight ports and no bundle, because `lagFor()` maps each member to an id and nothing in the model was an
  interface object for the port-channel - so the interface an operator addresses, and pings, appeared in no view
  they open first. The bundle now has a row after the physical ports, in bundle-number order: `Port-channel<n>`,
  `unassigned  YES unset` (this model builds no Layer 3 bundle), and `up  up` only when at least one member is
  really in the bundle - a bundle whose members are all stand-alone reads `down down` while each member reads
  `up up`, which is the same predicate `show etherchannel summary` prints as `Po1(SD)` with `(I)` members. The
  name is spelled out here and stays `Po1` in the summary and the MAC table, as a box spells it in each; both
  come from `engine/lag.js`. The captures, the row order one 9300-class table contradicts, and the port-channel
  views that still cannot name the bundle (`show interfaces Port-channel1`) are in
  [research/port-channel-in-interface-brief.md](research/port-channel-in-interface-brief.md).
- **A bundle carries eight links, and a LACP group's surplus waits as hot-standby.** One EtherChannel "can
  consist of up to eight compatibly configured Ethernet ports", and "for a LACP EtherChannel, you can configure
  up to 16 Ethernet ports ... Up to eight ports can be active, and up to eight ports can be in standby mode"
  (Cisco, *Configuring EtherChannels*, Catalyst 2960-X 15.2(3)E). This console capped nothing: ten
  `channel-group` lines made a ten-member bundle, every member read `(P)` bundled, and the hash was taken
  across all ten, so a lab moved ten links' worth of traffic over hardware that carries eight - and the
  `H - Hot-standby (LACP only)` line of the summary's own key was unreachable, because no member of any bundle
  could be in that state. The active set is now the eight lowest-numbered members that can carry; a `mode on`
  group refuses a ninth member and an LACP group a seventeenth; the receipt for a member that lands beyond the
  eighth says it is hot-standby; `show etherchannel summary` prints `(H)` for those members and promotes one
  into `(P)` when an active link's cable goes away; and the data plane never hashes a frame onto a parked link.
  The vendor sentences, the platforms they come from, and what is still open - the box's own wording for the
  ninth and seventeenth line, `lacp max-bundle`, and the per-vendor maxima one global number cannot express -
  are in [research/etherchannel-member-limit.md](research/etherchannel-member-limit.md).
- **`speed` and `duplex` take one word, and a word after it is refused instead of dropped.** The vendor's
  syntax lines close both commands after one value - `speed {10 | 100 | 1000 | 2500 | 5000 | auto [rates] |
  nonegotiate}` and `duplex {auto | full | half}` - so `speed 100 flurbish` is a parse error on a box. This
  console read the first word and dropped the rest: the rate was forced, the duplex was set, and the word was
  never mentioned, which is the silence `ip address <ip> <mask> <word>` closed for its own line. Four orders
  lied, and three reported a different command than the one typed: `speed auto 10` was answered as a plain
  `speed auto`, although `auto` followed by rates means "autonegotiate only at the rates named there" and this
  model has no advertisement to restrict; `speed nonegotiate`, a real keyword, was called an invalid rate; and
  `no speed flurbish` returned the port to autonegotiation anyway, while `no duplex` is the form that *does*
  take a word (`no duplex {auto | full | half}`, back to the default, `auto`). Each refusal now names the word
  it did not use and leaves the port exactly as it was. The syntax lines, the vendor's `speed auto 10 100`
  example and the ten other commands that swallow a trailing word are in
  [research/speed-duplex-grammar.md](research/speed-duplex-grammar.md).
- **An overlapping address on a port that is administratively down, and where the box refuses it.** The
  one-subnet-one-wire rule belongs to the routing table, so it is asked at both ends of a port's life. A port
  that is down installs no connected route and takes an overlapping address without a word; the command that
  opens it is where the collision surfaces, in the same one line, and the port stays down. Connected Dots
  walks the same address through all three states on one router - accepted while `Gi0/0` is shut, refused
  with `% 172.20.101.0 overlaps with GigabitEthernet0/1` at `no shutdown`, and accepted once `Gi0/1` is
  shutdown -
  an IOS SVI log on Cisco's forum keeps the SVI down for the same reason ("Vlan123 has been shutdown"). The
  model refused at address entry whatever the port's state, so a lab could not build the case at all. A shut
  incumbent no longer blocks a live port either, and a shut parent frees its subinterface's subnet, because
  that route leaves through the parent. An incumbent that is open but has no carrier is deliberately not
  modelled: no source in hand speaks about line protocol rather than administrative state. The sources, the
  three states, and what would settle the carrier case are in
  [research/ip-address-overlap.md](research/ip-address-overlap.md).
- **`show arp` prints the box's own addresses.** Cisco's field list for the command says the hyphen in `Age (min)`
  "means the address is local", and a router and a switch transcript each show the row - `Internet 10.2.2.1 - ... ARPA GigabitEthernet0/0/2` on an ASR1000, `Internet 192.168.2.1 - ... ARPA Vlan1` on a 2960-CX. The table held only what the device had heard, so the address configured on the box was absent from the box's own cache. There is now one local row per interface holding an IPv4 address: the port's MAC in `Hardware Addr`, its name in `Interface`, and `-` in `Age (min)`; it is not aged and not a neighbour. End hosts get no such row, because their cache holds their neighbours rather than themselves. The sources and the open cases are in [research/show-arp-local-address.md](research/show-arp-local-address.md).
- **A channel group configured at one end only forms no bundle, and its member is stand-alone.** LACP is a
  conversation, and a port that never configured a channel group never sends or answers an LACPDU, so
  `channel-group 1 mode active` against a plain access port has nothing to negotiate with. `memberSuspension()`
  returned `null` the moment the far port named no group, so the summary read `Po1(SU)` with both members
  `(P)` and the data plane hashed frames across two links the far end saw as unrelated single ports. The
  vendor states the outcome for the platform these views follow: "Incompatible ports are suspended. Beginning
  with Cisco IOS Release 12.2(35)SE, instead of a suspended state, the local port is put into an independent
  state and continues to carry data traffic as would any other single link" (Catalyst 2960, *Configuring
  EtherChannels*, 12.2(46)SE). The group now reads `Po1(SD)` with the member `(I)` and the ping still crosses
  over that one link. Two smaller corrections travel with it: the letter for a member that negotiated nothing
  is `(I)` stand-alone rather than `(s)`, because the key printed above the table reserves `s - suspended` for
  a member that is *not* carrying - so the passive/passive pair reads `(I)` now too, being the same state
  reached another way; and `mode on` is deliberately untouched, because it negotiates nothing and the switch
  forces the bundle up ("a usable EtherChannel exists only when the switches at both ends of the link are
  configured in the on mode ... otherwise, packet loss can occur"). The sources, the IOS XE wording that
  disagrees, and what is still unresolved are in
  [research/lacp-one-sided-group.md](research/lacp-one-sided-group.md).
- **MED is compared only between paths learned from the same neighbouring AS.** RFC 4271 9.1.2.2(c) is
  explicit - "MULTI_EXIT_DISC is only comparable between routes learned from the same neighboring AS (the
  neighboring AS is determined from the AS_PATH attribute)" - and Cisco states the same test on the path
  ("MEDs are compared only if the first AS in the AS_SEQUENCE is the same for multiple paths", *Select
  BGP-path Algorithm*, doc 13753, step 6). `comparePaths()` compared it unconditionally, and admitted as
  much in the file header: two external peers in different ASes offering one prefix were separated on
  MED, so the table installed the lower-MED route where a box ties them at step 6 and decides on eBGP
  over iBGP and then the advertising router ID. `neighbourAs()` reads the leftmost AS of the AS_PATH -
  the neighbouring AS, because an eBGP speaker prepends its own AS when it advertises (5.1.2(b)) - and
  `medComparable()` skips the comparison only when both paths name an AS and the two differ; a path that
  names none (empty AS_PATH, or AS_SET-leading, which 9.1.2.2(c) defines as the local AS) stays
  comparable. `bgp always-compare-med` and `bgp deterministic-med` remain unmodelled, and `bestPath()`
  still sorts rather than eliminating, which only matters for a list of three or more candidates. The
  rule was already written down as MED-3/MED-4 in [docs/BGP-POLICY.md](docs/BGP-POLICY.md); the sources,
  the two inferences and what is still missing are in
  [research/bgp-med-neighbour-as.md](research/bgp-med-neighbour-as.md).
  `test/bgp-med-neighbour-as.test.js` pins 22 checks: the same-AS behaviour that must not regress, a
  different-AS pair where the *higher* MED wins because its path has the lower router ID (and the other
  path winning once the IDs are swapped, so the outcome is provably the ID's), the null cases, the
  string spelling of an AS number, and two labs - one proving the AS_PATH of an installed eBGP route
  begins with the peer's AS, the fact the rule reads.

- **An all-numeric hostname is warned about, then taken - the vendor's own line.** Every IOS and IOS XE
  `hostname` reference publishes the ARPANET rule ("start with a letter, end with a letter or digit, and
  have as interior characters only letters, digits, and hyphens") and states the outcome of one breach
  with a transcript: `hostname 123` prints `% Hostname contains one or more illegal characters.` and the
  prompt becomes `123(config)#` - "Creating an all numeric hostname is not recommended but the name will be
  accepted after an error is returned". The console renamed in silence, so an operator got no word that
  the name breaks a rule a real box enforces. The warning is not a refusal: it is printed before the name
  is stored, nothing downstream is skipped, and `config.hostname`, `device.name`, the prompt and
  `show running-config` all carry the flagged name afterwards. The sentence is the vendor's verbatim
  (full stop included) rather than the console's `% Warning:` prefix, because recognising the line is the
  point. Only the numeric case is modelled: the same reference prints the line for `\99` and never shows
  the prompt that follows, and half the catalogue's default names are vendor model strings (`ZenWiFi ET8`,
  `FRITZ!Box 7590`) that breach the rule - so the rest would be a warning on every replayed
  running-config. The open questions are written down in
  [research/hostname-illegal-characters.md](research/hostname-illegal-characters.md).
  `test/hostname-illegal-characters.test.js` pins 45 checks: the exact line and the `123(config)#` prompt,
  the name reaching `show running-config`, the line printed once and before the name is taken, a repeated
  rename warning again, the other breach shapes staying silent, four catalogue-style names staying silent
  with `test/config-roundtrip.test.js` replaying all 2198 models, six legal names printing nothing, and
  `no hostname` restoring without a warning.

- **`show vrrp` prints the priority the group runs at, and an address owner runs at 255.** VRRP reserves
  255 for the router whose own interface address is one of the group's virtual addresses - Cisco: "If a
  VRRP group is the IP address owner, its priority is fixed at 255"; Nexus: "the default is 100 for
  backups and 255 for a master that has an interface IP address equal to the virtual IP address" - and
  the election here has always voted that way. The `Pri` column printed the configured value instead, so
  a router that owned the virtual gateway showed `100` in the very table explaining why it had just
  outranked a 254, and the timeline event carried the same number. The column now quotes the election's
  number, a note under the table says why it differs from the configuration (`owner mode`, and that
  `vrrp <vrid> priority` cannot set 255), and the configured value is untouched: `show running-config`
  still prints it and a backup still runs at it. `electMaster()` now returns both numbers per candidate
  (`priority`, `configured`) so no caller has to re-derive the rule. The refusal of
  `vrrp 7 priority 255` is unchanged, and [research/show-vrrp-owner-priority.md](research/show-vrrp-owner-priority.md)
  records the sources and the one question left open - what IOS's own `show vrrp brief` prints for an
  owner, where every sample in hand has no owner in it or is internally inconsistent.
  `test/show-vrrp-owner-priority.test.js` pins 28 checks: the owner's 255 and the backup's 254, the note
  and its wording, the refused value staying refused and leaving the group alone, an owner configured
  150 printing 255 while the running-config keeps 150, the verdict carrying both numbers, the column
  without a simulator, a shut owner still at 255 in `Init` while the backup takes over, and a group
  where nobody owns the address printing configured values with no note.
- **`ip address <addr> 255.255.255.255` is refused on a port, in the vendor's own sentence.** A 32-bit mask
  leaves one address and no host space, so a box will not put one on a link that has to reach another box:
  Cisco's guide says `255.255.255.255` "describes a subnet with only one IPv4 host address ... strictly
  reserved for use on links that can have only one address. The example for Cisco routers is the loopback
  interface", and three transcripts - a GRE tunnel, a 2811 serial port on 15.0(1)M10, and a 4331 routed port
  on IOS XE - show `Bad mask /32 for address <what was typed>` for the same command. This console accepted
  the address and stored it, so `show ip interface brief` and `show running-config` carried a /32 a device
  would not have. The refusal is the same one line the network- and broadcast-address cases already print,
  comes before nothing is stored, and stands down for an interface whose type is `loopback` - the vendor's
  exception, which no catalogue device currently declares. `research/ip-address-not-a-host.md` now records
  the four sources and the two questions left open (whether an SVI or port-channel behaves like the three L3
  ports, and the loopback exception the model cannot demonstrate). `test/ip-address-not-a-host.test.js` pins
  27 checks: the /32 line on a port, the bare-prefix spelling, the held address and `show running-config`
  untouched, a `/31` still accepted at the boundary, and a dot1q subinterface refused like its parent.

- **`vrrp <vrid> priority` accepts 1-254, because 255 belongs to the address owner alone.** The console took any
  priority up to 255 and quoted "(1-255)" back at everything it refused, so an operator could type the one value
  that means "I own this virtual address" on a router that does not - and the group then outranked the real owner
  in every election the simulator ran. IOS's own parser answers `<1-254>  Priority level(default 100)` for this
  keyword, Cisco's command reference gives the range as 1-254, and the RFC reserves 255 for the owner and 0 for a
  master releasing the group; the engine already derives the owner's 255 by itself. The help index, `docs/CLI.md`
  and the stated-range sweep now carry the same two numbers, and
  [research/vrrp-priority-range.md](research/vrrp-priority-range.md) records the sources and the two questions
  left open (the refusal's real wording, and what an owner's `show vrrp` prints). `test/vrrp-priority-ceiling.test.js`
  pins 17 checks: both edges accepted, 255 refused with the range quoted and the group left untouched, 0 and 256
  refused, `show vrrp` printing what was accepted, and the library still accepting 255 and 0 as protocol values.

- **`show lldp neighbors` ends with `Total entries displayed: N`, and the count is the rows it printed.** The
  table was the whole answer and the view stopped at its last row, so a pasted neighbour list gave a reader no
  way to tell how many entries were in it without counting - the question the command is opened with when a
  link stops working. The sentence is the vendor's, at the left margin directly under the last row, and the
  number is the rows this view printed rather than every neighbour ever heard: a Catalyst 3750 configuration
  example ends four rows with `Total entries displayed: 4`, and a filtered Nexus detail view ends its one row
  with `1`. An empty table prints no count, because no vendor page in hand shows one - the empty case is the
  half left open in [research/lldp-total-entries.md](research/lldp-total-entries.md), which also says why the
  capability-codes legend was *not* taken with it. `test/lldp-total-entries.test.js` pins 16 checks: the
  wording and position, the count against the rows, the plural for a single row, a row aged past its TTL leaving
  the count, a row for a downed port still counting, the empty table printing none, and both accepted
  spellings agreeing - `show lldp neighbors` and `show lldp neighbours`. `show lldp` was a third until it
  became the status view (#1915), which is the one check this count lost.

- **A Catalyst does not route until somebody types `ip routing`, and now neither does this one.** The console has
  printed two `show ip route` shapes since the host table landed - the codes legend over a routing table, and
  `Default gateway is not set` over the Host/Gateway cache - and which one a device got was decided by the
  catalogue's `l3-forward` capability, which no operator can change. So a 3560 printed a routing table from the
  moment it was placed on the board, in the state Cisco says it does not ship in: "By default, the switch is in
  Layer 2 switching mode and IP routing is disabled. To use the Layer 3 capabilities of the switch, you must
  enable IP routing." (Catalyst 3560 *Configuring IP Unicast Routing*; the Catalyst 9300 defaults table says
  `IP routing | Disabled`.) `ip routing` and `no ip routing` are now commands, gated on the hardware that can
  honour them - a 2960 is told it "cannot route between networks: it has no l3-forward capability" - and
  `Device.isL3()` is now the capability **and** the switch, so `show ip route`, the L3 data path, the IPv6 router
  advertisements and the installed-route table cannot disagree about whether a packet is forwarded. A box with
  routing off still answers for its own addresses, keeps its static routes in `show running-config`, and drops a
  packet it would have routed, with the drop attributed to it. The default follows the platform: a Cisco
  `l3-switch` leaves the factory in Layer 2 mode, every other box keeps the answer it gave before the command
  existed, and `show running-config` prints the line only when it differs from the default - which is why a
  router's own file never showed it. `test/ip-routing.test.js` (37 assertions) pins the platform defaults, both
  table shapes, the data path, the printed line and the save/reload round trip;
  [research/ip-routing-default.md](research/ip-routing-default.md) holds the citations and the four things still
  unresolved, including the 216 non-Cisco `l3-switch` entries whose vendors' documentation was never read.

- **`traceroute` takes a name, and prints the lookup a box prints** (#1484). The `help` index has claimed
  `traceroute|tracert <address|name>` since the command landed, and `_traceroute()` put its one argument through
  `net.isIp()`, so `traceroute srv.lab` was refused as an invalid target while `ping srv.lab` - two lines above it
  in the same ticket - resolved. A name now goes through the lab's DNS before a probe is sent: the
  `Translating "srv.lab"...domain server (10.0.2.2) [OK]` line comes before `Type escape sequence to abort.`,
  the target line reads `Tracing the route to srv.lab (10.0.9.9)`, and the hops are the hops the address form
  walks, figure for figure. A name that does not resolve sends nothing and prints the NXDOMAIN/NODATA/SERVFAIL
  sentences `ping` prints, from the same helper. `max <n>` is still swallowed - that half of the index row is
  still unimplemented - and the evidence, including what is not settled, is in
  [research/traceroute-name-target.md](research/traceroute-name-target.md).

- **The interface type has four spellings, and the long one is the one people paste** (#1769).
  `interface Gi1/0/1` opened a Catalyst port; `interface GigabitEthernet1/0/1` - the spelling every
  Cisco document writes and every real `show running-config` prints - was refused with `% Interface not
  found`. Cisco states the rule in one sentence ("you can specify either gigabitethernet 0/1,
  gigabitethernet0/1, gi 0/1, or gi0/1"), and `engine/iface-name.js` now folds every spelling of a type
  onto the type, with or without the space, so `interface`, `show interfaces`, subinterface creation, the
  API and saved labs all resolve through the one table. Folding onto the *type* rather than onto Cisco's
  `gi` is what lets the long name reach a Huawei port the catalogue calls `GE0/0/1`. A name the table does
  not know is untouched (`SFP+1` is still not `SFP1`), the fold cannot invent a socket (a UniFi `Port 1`
  is not reachable as `Po1`), and partial spellings (`Gig1/0/1`) stay refused rather than guessed - see
  [research/interface-type-spellings.md](research/interface-type-spellings.md).

### Added

- **Link state is real, and a pulled cable re-converges** (#1057). `Link` has carried
  `state: 'up' | 'down' | 'blocked'` since the physical layer was built and **nothing in the engine
  read it** - a cable marked down still carried every frame, still cost what it cost in the spanning
  tree, and was still walked by the DHCP segment search. The field was decoration, and the failure it
  hid was total: a lab could show a cut link passing traffic. Now a down link drops frames with
  `reason: 'link down'`, is not a bridge port (so STP heals around it), is not walked by the segment
  search, flushes every bridge's MAC table, and re-bases the convergence schedule at the instant of
  the change. The change instant lives on the topology so a reloaded lab still knows when its cable
  was cut. New CLI `link up|down|state <id> [at <ms>]` and `links`; new route
  `POST /api/topologies/:id/links/:linkId/state`; a down cable is drawn dashed and red with a
  take-down/bring-up entry in the cable menu. `docs/LINK-STATE.md` documents what is modelled and
  what is not - no degraded links, no flapping, no RSTP fast convergence.

- **VRRP is in the data path** (#1052). `engine/vrrp.js` elected a master and nothing called it, and
  the CLI had no `vrrp` command at all - a lab could read about a virtual gateway and never build
  one. `Simulator.computeVrrp()` now elects once per (broadcast domain, vrid) before the first
  packet; the winner claims the group's addresses so ARP and ICMP for the VIP are answered locally,
  answers with the **virtual** MAC and accepts frames addressed to it, and announces the VIP with a
  gratuitous ARP on takeover - without which the switches keep pointing the virtual MAC at the old
  master's port and the failover black-holes. New CLI: `vrrp <vrid> ip|priority|preempt|advertise`
  per interface and `show vrrp`. Groups survive save/load.

- **DHCP is in the data path** (#1051). `engine/dhcp.js` was a complete, tested model with no
  caller: `ip address dhcp` set a flag, no DISCOVER was ever sent, and a host stayed unaddressed for
  the life of the lab. `Simulator.computeDhcp()` now runs the exchange before the first packet, walks
  the broadcast domain properly (`engine/segment.js`: bridges pass, routers stop, STP-blocked ports
  pass nothing, VLANs are boundaries), installs the lease on the interface, and reports the failures
  a real server produces — `no-server`, `no-pool`, `pool-exhausted`, `nak`. New CLI sub-mode
  `ip dhcp pool` with network/range/exclusions/reservations/lease, validated on exit rather than on
  every keystroke. Pools survive save/load.

- **README corrections.** The protocol table claimed DHCP client/server and VRRP, and the CLI row
  claimed `ip dhcp pool` and `vrrp`. `engine/simulator.js` requires neither library, and the CLI has
  no `vrrp` command at all — `docs/SIMULATION.md` §5.1 has documented DHCP as absent from the data
  path the whole time. Both are now listed under "What this does not model yet" with their issues
  (#1051, #1052) rather than advertised as features.

- **Control planes take time now** (#1049). Every timer in the engine was parsed, range-checked and
  then discarded: `computeStp()` blocked its ports and `computeOspf()` installed its routes at t=0,
  so a lab could only ever show the converged answer. `Simulator.setRunTime(ms)` asks a question at
  an instant - STP ports Listening/Learning and dropping traffic, OSPF without learned routes, no
  DHCP lease - and a failed ping reports `converging` with the process and its ready time instead of
  pretending a packet was lost. New `converge` command, `ping ... at <ms>`, and ping replies that
  print a real millisecond time from propagation + serialisation + store-and-forward. See
  [docs/CONVERGENCE.md](docs/CONVERGENCE.md).

- **`scripts/sweep-device-requests.js`** answers "is this hardware request already modelled?" against
  the ~800-issue backlog, with no fuzzy matching: a vendor-agreement guard and a model-key guard,
  because the first version closed three Ubiquiti requests pointing at `roku/Ultra`. See
  [docs/TRIAGE.md](docs/TRIAGE.md). 41 requests closed with per-issue comments naming the file.

- **OLT uplinks are real ports now** (#987). The Adtran SDX 6320's 4x100GbE + 4x10GbE uplinks
  declared no connector (so a 10G uplink was guessed as copper, #1069 again), the FiberHome
  AN5516-01's HU2A card was missing its second combo position, and the Huawei MA5600T had no uplink
  at all despite naming the H801X2CS in its own description. All three are modelled, cited to their
  datasheets, and the three name-based quarantines in `test/spec-vs-description.test.js` are gone.
- **`xfp` cage.** XFP is 10G in a larger cage than SFP+ and an SFP+ module does not seat in it. The
  FiberHome HU2A's 10GE ports are XFP and the Huawei H801X2CA is its XFP variant of the same 2x10GE
  card as the SFP+ H801X2CS - so the cage is now a hardware fact, and the engine refuses the pair.

- **`scripts/check-node-surface.js`** runs in CI and in `npm test`: it fails the build if any source
  file uses an API that arrived after Node 18 (`toSorted`, `Object.groupBy`,
  `Promise.withResolvers`, and the rest), because a green suite on a newer local interpreter says
  nothing about the oldest job in the matrix. This dev machine runs Node 24 while CI tests 18/20/22.

### Added

- **`test/skip-audit.test.js`**: every skip that exempts a class of hardware from a check must name
  an issue, or declare itself ordinary control flow / deliberate with a reason. The three silent
  holes of the last two releases (a `Math.max` over strings, a console skip, an empty-media skip)
  were all of this shape and all invisible to the backlog. The audit carries a self-test that
  writes an untracked exemption to a temp file and asserts it is flagged, because a lint that cannot
  fail is the same disease it is meant to cure.

- **DOCSIS has an upstream medium** (#1039). The coax cage offered only downstream media (1G on
  3.0, 10G on 3.1), so a 200 Mbps return-path port shared no rate with anything: its media list came
  out empty, the cable picker offered nothing, and the rate invariant skipped it with an early
  `continue`. `docsis-30-us` (200 Mbps) and `docsis-31-us` (1 Gbps) now exist, the plant rates on
  five CCAP chassis and one HFC node are corrected to what they carry, and
  `test/coax-docsis.test.js` pins the asymmetry.

- **Console ports have a baud rate, not a line rate** (#979). Five RS-232 rates (9600/19200/38400/
  57600/115200) are separate media, a spec states `baud: 115200`, and a multi-baud port negotiates
  **down** to the highest rate both ends share. A 9600-to-115200 cable now refuses with
  `E_BAUD_MISMATCH` naming both rates instead of "no shared medium", and a console cabled to a data
  port refuses with `E_PROTOCOL_MISMATCH` explaining that a console is out-of-band.

### Added

- **Fibre Channel is a first-class link type** (#980). Four FC cages (`fc-sfp`, `fc-sfp28`,
  `fc-sfpdd`, `fc-qsfp28`), sixteen FC media across 2/4/8/10/16/32/64/128G, and the real rate
  ladder: a 32G port runs at 28.05 Gbit/s and a 64G port at 57.8, because FC frames its payload.
  Two FC ports link and negotiate down the ladder; an FC port cabled to an Ethernet port is refused
  with `E_PROTOCOL_MISMATCH` naming both protocols, since the optic seats and the frames never
  cross. Seven SAN switches moved from Ethernet cages to FC ones, including Dell DS-6630B, which
  was hiding 96 × 32G and 8 × 128GFC behind an SFP28 model. See [docs/FIBRE-CHANNEL.md](docs/FIBRE-CHANNEL.md).
- **SFP56 cage and 50GBASE-SR/LR**, so a 50G SFP-form port is neither understated as 25G nor given
  a QSFP connector.

### Fixed

- **The board document's `format`/`version` stamp is read, not just written** (#1520). `serialize()`
  stamped every board `format: 'packetforge-topology', version: 1` and `server/index.js` restated the
  same two lines by hand into the file envelope, and **nothing ever read either**: `Topology.fromJSON()`
  turned `{format:'lab', version:99}` into a board without a word. A guard that looks like a guard and
  is none is worse than no guard, because the next reader concludes the version is checked. The pair is
  now one exported constant, `documentStampProblem()` reads it, and every door - the engine loader, the
  saved-file reader, `POST /load` - asks that one function and answers in words that name both what the
  document claimed and what this build reads. Absent still loads, because every board written before
  the check existed carries no stamp. `test/document-stamp.test.js` pins all of it, including the HTTP
  answer.
- **`wired-port-has-media` now asserts that every cabled port has a medium**, rather than guarding
  only the ones that already had one. 84 coax and 24 MCX ports had none, so the picker silently
  omitted them and no check noticed.
- **`derivePortHardware` gave any port that declared nothing a flat 1000 Mbps**, so 163 console
  ports advertised a gigabit (then 100 Mbps, from a stray `speed: "100M"` in 128 spec files) on a
  115.2 kbps cage. The rate now falls back to the cage's own ladder, and `speedCaps` no longer
  widens a 9600-baud port to the whole five-rate ladder.
- **Console ports were exempt from the cage-rate invariant**, which is how those 163 ports stayed
  green. The exemption is gone; "slow is correct" (DSL, PON, console) still excuses a low rate, and
  the overreach check now runs on console ports like any other.
- `derivePortHardware` took a port's line rate from its `speed` label instead of its `speedCaps`.
  Where the two disagree the caps are the truth, and on `qlogic/5800V` the disagreement was a real
  one: 32G of FC claimed as 32000 Mbps on a 28050 Mbps port.
- The `qlogic/5800V` notes said its ports were "modelled at the nearest step (10G) with the real
  2/4/8G rates in speedCaps" — true when written, false once FC had cages. Its 4 ISL ports are now
  10GFC and the note describes what the model actually does.
- `mikrotik/CRS812`'s 50G ports were named `SFP28-n` while being SFP56; renamed, and the description
  check learned that `SFP56` is not `SFP`.

### Security

- **The server listens on loopback, and the banner says where** (#1527). `server.listen(PORT)` with no
  host binds every interface, so a simulator started on a laptop in a cafe - or behind a reverse proxy -
  was reachable from anything that could route to it, and the banner printed `localhost` either way, so
  nothing in the log disagreed with the reader's assumption. `PF_HOST` now names the address and
  defaults to `127.0.0.1`; the banner prints what `server.address()` reports and whether that is this
  machine only or reachable from other hosts. The Docker image sets `PF_HOST=0.0.0.0`, because a
  published port has to be reachable from the host. A `PF_HOST` this machine does not own - or a
  `host:port` copied out of a URL - now exits `1` with a message naming that value, instead of the old
  `EADDRNOTAVAIL` text that blamed `PORT` and told the reader to leave it "unset to listen on all
  interfaces". `test/server-bind.test.js` covers all four cases against a real server.

### Security

- **The REST API stops handing the board to any page that asks** (#1527, `docs/plans/server-exposure.md`
  step 3). The WebSocket upgrade already refused a page from another origin, but every JSON answer carried
  `Access-Control-Allow-Origin: *`, so the page that had just been refused a socket could
  `fetch('/api/topologies/default')` and read every device and cable over HTTP - the cheaper door the issue
  never named. `sendJSON` now echoes the caller's own `Origin` only when `allowOrigin()` accepts it (same host
  and port as `Host`, or listed in `PF_ALLOWED_ORIGINS`), sends no such header otherwise, and every answer
  varies by `Origin` so a cache cannot pass one page's echo to another; the `OPTIONS` preflight follows the
  same rule. `/api/catalog` and `/api/media` keep the wildcard - fixed hardware catalogues, no board, read
  from other origins on purpose. `test/server-cors.test.js` covers same-origin, foreign, `Origin: null`, an
  absent `Origin`, both catalogues, the preflight and the allow-list against a real server.

### Fixed

- **OSPF refused to form an adjacency between interfaces addressed in different
  subnets.** The adjacency was built from the cable alone, so two routers that
  disagreed about the subnet installed routes via a next hop that was on no
  connected subnet — traffic that never resolves is traffic that is black-holed.
  Both ends of a broadcast link must now share the subnet **and** the mask, which
  is the check that makes a misconfigured router a misconfigured router instead of
  a silently-working one. `test/protocol-regression.test.js` proves the refusal,
  and proves a matching subnet still forms the adjacency (#240).
- **DNS reported three different failures as NXDOMAIN.** A name with no `A` record
  (NODATA), a name the zone does not hold (NXDOMAIN), and a lab with no DNS server
  configured at all (SERVFAIL) all came back as "no such domain". They are now
  distinguished — NODATA is NOERROR with an empty answer — and a failed ping says
  `dns-nodata`, `dns-nxdomain` or `dns-servfail` instead of always
  `dns-nxdomain` (#241).
- **`docs/SIMULATION.md` listed five defects as open that were already fixed**
  (#41, #42, #43, #44, #54). The section now records what each one used to do and
  what it does instead, so the page does not cry wolf about its own engine.

### Added

- **The simulator has a notion of time.** Propagation (by medium and length), serialisation
  (by frame size and line rate) and a per-hop store-and-forward term are summed over both
  directions, so a 40 km fibre measures slower than a 1 m patch lead instead of identically.
  An unrecorded length stays unknown rather than inventing a distance.
- **A palette search that finds what exists.** Punctuation is folded on both sides, vendor +
  model match together, a punctuation-only query matches everything, and exact model hits
  rank first. No fuzzy typo tolerance — a confident wrong hit is worse than none.
- **A faceplate that fits its labels**: shrink within a floor, then shorten from the front,
  full name in the tooltip. `Fa0/2` and `Fa0/24` can no longer look identical.
- **TP-Link TL-SG105 and TL-SG105E** 5-port gigabit switches, from the datasheet.
- **A hybrid UPC/APC patch-cord catalogue** plus the rules for when a hybrid lead is correct,
  because a flat ferrule cannot meet an 8° angled one.
- **An upstream/transit design** (`docs/UPSTREAM-DESIGN.md`) replacing "the internet is one
  RJ45" with real link types and multihoming.
- **235 assertions over the control plane** (BGP, OSPF, VRRP, DHCP, NAT, DNS), five of which
  document defects as `DOCUMENTS BUG` and reference the issues that will flip them.

### Fixed

- An 8-wide faceplate group no longer clips port names mid-glyph.
- Palette search finds `MC220L` by `mc-220l`, `mc 220l` or `TL-MC220L`.

### Known defects (filed, not fixed)

- #41 BGP re-advertises an iBGP-learned route to another iBGP peer; next hop becomes the relayer.
- #42 OSPF installs a route for its own connected network, at transit cost.
- #43 OSPF does not advertise a passive interface's network at all.
- #44 OSPF keeps the more expensive advertisement for a shared network, chosen by id order.
- #54 NAT `flowKeyOf()` omits the inside source, so two hosts behind one PAT pool collide.


### Added

- **Cables are drawn as what they are made of.** Every medium was one grey 2 px line and
  wireless-versus-not was the only distinction the canvas had. Colour now carries the family
  (copper, fiber, dac, aoc, pon, coax, dsl, powerline, wireless), width the construction and a
  dash "not a plain cable run", with `data-medium` and `data-media-id` on every line (#34).
- **Cable length is a property of the lead.** The picker offers the lengths people actually buy
  per family, defaults to the short lead, and an existing cable's length can be set from the
  inspector or `PATCH /topologies/<id>/links/<id>` (#31).
- **A 3 m DAC is expressible at last**, because the ceiling ("up to 7 m") is no longer printed
  where the length belongs (#31).
- `docs/CONNECTORS.md` gained the canvas colour key and how to wire up a new medium.

### Fixed

- **SFP28 accepts 1G SFP and 10G SFP+ modules**, with the reaches widened to the whole module
  class (1000BASE-EX/ZX, 10GBASE-ER). 100M stays out deliberately (#17).
- **MikroTik ports read eth1 / SFP+1**, not the RouterOS CLI spelling, and the CLI keeps the
  RouterOS names as aliases so existing commands still resolve (#27).
- **The inspector no longer draws the cable label and the LLDP neighbour on top of each
  other** — they have their own row and can wrap (#25).
- **A cable passing behind a chassis is no longer erased**: devices are drawn first, cables
  after (#34).
- **Re-validating an existing cable** is no longer refused as `E_PORT_IN_USE`; the check
  compares the actual endpoint rather than an interface name that is only unique per device.
- **A server restart no longer discards the board**, and the browser notices when it is stale:
  connection badge, backoff retry, and a re-fetch that reports when fewer devices come back
  than the tab was showing (#24).

### Devices

- Acer Nitro 5 AN515-57 added from hardware request #23.


### Fixed

- **A server restart no longer discards the board.** Topologies are saved to
  `data/topologies/<id>.json` on every change and loaded at start-up, written
  synchronously: a 120 ms debounce looked harmless but on Windows a kill calls
  `TerminateProcess`, so no signal handler runs and the tail of your work vanished.
  Saves are atomic (write then rename), a board that cannot be parsed is reported
  and left in place rather than deleted, and device ids survive the round trip (#24).
- **The browser notices when it is stale.** The socket had no `onclose`, no `onerror`
  and no retry, so a tab kept drawing a board the server had never heard of. It now
  shows a connection badge in the status bar, retries with backoff, and re-fetches the
  server's copy on reconnect - reporting it when fewer devices come back than the tab
  was showing (#24).

### Added

- **SLAAC via router advertisements.** IPv6 hosts can now get an address off the
  wire instead of having one typed in. `engine/ra.js` builds, encodes and parses
  ICMPv6 router solicitations (133) and advertisements (134) — M/O flags, router
  lifetime, reachable/retrans timers, prefix information options (prefix, length,
  L/A, valid and preferred lifetimes) and the source link-layer address option.
  A host with `ipv6 address autoconfig` multicasts an RS to `ff02::2`, the router
  answers to `ff02::1`, and the host splices its own EUI-64 identifier onto the
  advertised prefix, installs the router's link-local as its default gateway
  (remembering which port it was heard on, because `fe80::` is on-link
  everywhere) and can then be pinged from another host. An advertisement with the
  M flag set is refused with a stated reason rather than silently ignored, only a
  device with `l3-forward` ever advertises anything, a prefix is only advertised
  on the link the router is attached to, and `suppress-ra` stops the periodic
  advertisement without silencing the answer to a host that asks. New commands:
  `ipv6 nd ra enable|disable|managed|other-config|lifetime`, `ipv6 nd prefix
  <prefix>/<len> [valid <s>] [preferred <s>]`, `ipv6 nd suppress-ra`,
  `ipv6 address autoconfig` and `show ipv6 nd`. Tests:
  `test/ipv6-slaac.test.js`.
- **SCION in the forwarding path.** ASes are declared with `scion <isd>-<as>`
  (`1-ff00:0:0` is core because its AS number ends in `:0`, the SCION
  convention). Beaconing runs over the real peering graph derived from the
  topology — up-segments away from each core, down-segments back out, and
  core-to-core segments chained across adjacent core ASes. Paths compose from
  that segment set, are validated by shape (`up|down`, `up|core|down`, …) and
  selected with policy (`avoidAses`). `Simulator.pingScion()` then source-routes
  the packet along the path, one hop per AS, with **no IP addresses and no
  routing table involved** — which is the point of path-aware networking, and is
  asserted: not one interface has an IPv4 address and the packet still arrives.
  A non-core AS that no beacon reaches has no up-segment, so it gets no path and
  a stated reason.
- **Hardware-aware inspector.** The Device tab only showed port / IP / mask,
  hiding the entire physical layer it was built on. Each port is now a row with
  cage, negotiated rate, admin state and a cabled marker, expanding to an IP
  editor plus a hardware grid (cage, speed caps, supported media, PoE, VLAN
  mode/access/native/allowed, LAG, sub-interface encap). A port filter handles
  52-port switches, and PoE switches report their real power budget.
- **Link inspection.** Cables were previously unselectable. Clicking one opens
  an inspector with the media id, negotiated rate, duplex, length and both
  endpoints' cage and port state — and states that the cable passed the
  physical-layer check rather than implying it.
- **PoE budget bug.** 27 devices exposed PSE-capable ports but every one had a
  0 W budget, because nothing populated it — including an Aruba whose model name
  says `370W`. The budget is now derived from the model name when the spec does
  not carry one, and the inspector says "budget not modelled" rather than
  displaying a misleading 0 W.
- `test/ui-render.test.js` — loads the real `web/app.js` in a stub DOM and
  asserts on the HTML it produces, so the inspector is tested rather than
  assumed.
- **IPv6 in the forwarding path.** Interfaces take `ipv6 address <addr>/<len>`;
  every interface derives an EUI-64 link-local from its MAC; neighbour discovery
  runs over the wire (NS to the solicited-node multicast MAC `33:33:ff:…`, NA
  back, cached, pending packets flushed on resolution); ICMPv6 echo request/reply
  (types 128/129) with hop-limit decrement on every router. Multicast MACs are
  now received and flooded like broadcast, which is what makes NS arrive.
  CLI: `ipv6 address`, `ipv6 route`, `ipv6 gateway`. `Simulator.ping6()`.
- **BGP route installation.** Sessions form only when BOTH sides are configured
  (each lists the other with a matching remote-as); advertisement runs to
  convergence with per-neighbour split horizon and AS-path loop detection; the
  best path per prefix is installed with eBGP 20 / iBGP 200 administrative
  distance. CLI: `router bgp <as>`, `bgp router-id`, `neighbor <ip> remote-as`,
  `no neighbor`.
- **DNS in the data path.** `ping` accepts a hostname, resolves it through a
  device that hosts the zone (honouring the client's resolver list) and follows
  CNAMEs before sending a single ICMP packet. CLI: `dns zone`, `dns add`,
  `ip name-server`. `bgp`, `dns`, `scion` and `ipv6` are now exported from the
  public engine API.
- Administrative-distance ordering in the routing table (connected 0, static 1,
  eBGP 20, OSPF 110, iBGP 200, default 254) — previously only prefix length
  decided, so a static route could not override a routing protocol.
- **OSPF route installation.** Area-aware adjacency graph built from the live
  topology, per-router SPF, next-hop resolved to a real adjacent IP, routes
  installed as code `O`; costs derive from link rate, passive interfaces are
  advertised but form no adjacency.
- `scripts/import-devices.js` — strict validation of researched device specs
  (vocabulary, declared ports, line rates, duplicate detection).
- `scripts/audit-devices.js` — catalogue accuracy audit: uncablable ports and
  devices that describe optics but expose no optical cage.
- 226 researched devices across 24 vendor families, taking the catalogue to
  317 models / 32 vendors; every ethernet port verified cablable.

- **VLANs, LAG and STP are now enforced in the data path**, not just modelled:
  - per-VLAN MAC tables and VLAN-scoped flooding; broadcast never crosses a VLAN
  - 802.1Q tagging on trunks, untagging on access ports (visible in the event log)
  - spanning tree blocks ports in both directions, turning a physical loop into a
    working topology instead of a broadcast storm
  - LAG groups act as one logical port: STP does not block members, one member
    carries each frame, and frames never hairpin back out the ingress group
- `switchport` CLI family: `mode access|trunk`, `access vlan`, `trunk native vlan`,
  `trunk allowed vlan`, plus `channel-group` and `vlan <id>` configuration.
- `show vlan brief`, `show spanning-tree`, `show etherchannel summary`, and a
  VLAN-aware `show mac address-table`.
- `test/l2.test.js` (28 assertions) proving the behaviour above end to end.
- Physical-layer model: 32 media types (copper / fiber / DAC / console / wireless),
  9 cage types, per-port media + speed capabilities, and PoE source/sink budgets.
- Live cabling feasibility engine — 11 blocking rules and 5 warnings. Impossible
  cables are refused with a stable error code, both at the API and in the UI.
- Link-type picker: when several media are valid, the user chooses the physical
  medium (and can deliberately force a lower speed, e.g. 100BASE-TX).
- 802.1Q VLAN membership: access/trunk, native VLAN, allowed-VLAN lists.
- LACP / static link aggregation with deterministic hashing and member validation.
- 802.1D spanning-tree election (root / designated / alternate roles, blocking ports).
- `GET /api/media` and `POST /api/topologies/:id/validate-link` endpoints.
- `docs/PHYSICAL_LAYER.md`.
- 202 new test assertions (validation 22, VLAN 59, LAG 57, STP 64).

### Fixed

- The multi-vendor campus example lab cabled a 25G SFP28-only switch to 1G RJ45
  ports — physically impossible. Rebuilt with valid copper and 1G-fiber uplinks;
  the new validator now catches this class of error in CI.

## [0.1.0] - 2026-11-07

### Added

- Event-driven L2/L3/ARP/ICMP simulation engine: MAC learning, unknown-unicast/broadcast
  flooding, longest-prefix routing, default gateways, TTL decrement, ICMP echo/reply.
- Vendor-agnostic Cisco-like CLI (`show`, `interface`, `ip address`, `ip route`, `ping`).
- Browser UI: pan/zoom SVG canvas, port cabling, per-device console, live packet
  animation, WebSocket multi-client sync, topology save/load.
- Hardware catalog: 91 models across 17 vendors — routers, switches, L3 switches,
  firewalls, ONTs/CPEs, access points, and 22 point-to-point radios (Ubiquiti
  airFiber / airMAX AC / GigaBeam / Wave + MikroTik Wireless Wire / LHG / DynaDish / SXT).
- Searchable, manufacturer/type-filtered device palette with collapsible vendor groups.
- Example labs (single-switch, routed campus, multi-vendor WAN) that self-verify.
- CI/CD: test matrix (Node 18/20/22), server smoke test, Docker image published to
  GitHub Container Registry on tags, CodeQL analysis, Dependabot for Actions.

[Unreleased]: https://github.com/Jaylouisw/packetforge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Jaylouisw/packetforge/releases/tag/v0.1.0
