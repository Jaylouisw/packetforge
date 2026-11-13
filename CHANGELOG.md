# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- **A `?` under a value slot now names the values the device has.** A slot the console could complete
  from the device used to print only its own name (`Next: <name>`) with no hint of what was available;
  now the values are listed, named by what they are. Measured on a lab holding R1 (router), SW1
  (switch) and PC1 (PC), with VLANs 10/30/44 created on the switch:

  ```
  R1#show logging device ?
  Completions for "show logging device" (1):
    why something happened - drops, forwards, protocol events

    Next: <name>

    Devices in this lab: PC1, R1, SW1

  Names in angle brackets are values: type one, then ask ? again for what follows it.

  R1#show interfaces counters ?
  Completions for "show interfaces counters" (1, and this form ends here):
    one row per port: packets, bytes, drops

    Next: <port>

    Ports on this device: Gi0/0, Gi0/1, Gi0/2

  Names in angle brackets are values: type one, then ask ? again for what follows it.

  SW1(config)#no vlan ?
  Completions for "no vlan" (1):
    remove a VLAN no port is still in

    Next: <id>

    VLANs on this device: 1, 10, 30, 44

  Names in angle brackets are values: type one, then ask ? again for what follows it.
  ```

  The slot line (`Next: <name>`) is unchanged, so existing scripts that parse it still work — the
  value list is an addition after it, not a replacement. `test/value-hints.test.js` holds **24
  assertions**. See [docs/CLI.md](docs/CLI.md).

  All three were re-run on 2026-11-12 on exactly that lab and the value lines are verbatim: `Devices in
  this lab: PC1, R1, SW1`, `Ports on this device: Gi0/0, Gi0/1, Gi0/2` (the router's `portTemplate` is
  `Gi0/`, start 0, count 3) and `VLANs on this device: 1, 10, 30, 44`. A device is listed by its **name** —
  the string the lab gives it — so a hand-built device will not match: `Device` falls back to
  `label + '-' + id` when no name is supplied (`engine/device.js:114`), which turns the same line into
  `Devices in this lab: PC-PC1, Router-R1, Switch (L2)-SW1`. Build the lab from a file, or `hostname` each device in config mode, before diffing —
  `POST …/devices` accepts a `name` field and silently drops it (as it drops `label`), so a name
  has to come from a document you `/load` or from the device's own configuration. Three things the transcript above does
  not show, all of which will make a hand-run look wrong: the block ends with
  `Names in angle brackets are values: type one, then ask ? again for what follows it.` and it separates the
  hint lines with blank lines, so a diff against the excerpt will not match. And the VLAN list only reaches
  `1, 10, 30, 44` if the three VLANs are created **back to back** — `vlan <id>` does not enter a sub-mode, so
  `vlan 10` / `exit` / `vlan 30` leaves config mode after the first and the next two answer
  `% Unrecognized command: vlan 30`.

- **`show logging types` — the event vocabulary, and a refusal that can tell a typo from a quiet type.**
  `show logging <type>` used to answer a word it did not recognise with "either a type that has not
  happened yet or a typo", which is not something an operator can act on. The console knows all 60 type
  names it records, so the three cases are now three different answers, measured on one switch after a
  failed ping:

  | typed | answer |
  |---|---|
  | `show logging acl-deny` (a real type, nothing logged yet) | `% No event of type "acl-deny" has happened here yet - it is a type this console records` + `% "show logging types" lists all 60 of them, with what has happened` |
  | `show logging dropp` (a typo) | `% "dropp" is not a type this console records, so no event of it can ever appear` + the count + `% Types with events so far: drop, frame, lldp, ping` + `% Closest: drop` |
  | `show logging xyzzy` (a word outside the vocabulary, nothing like it) | the same "can never appear" answer, with **no** `Closest:` line — the hint only appears when some type starts with the same two characters |
  | `show logging stp` (an unambiguous prefix) | resolves to `stp-block` and answers for *that* type — `no event of type "stp-block" has happened here yet` — not for `stp` |
  | `show logging types` | `Event types this console records (60), and how many have happened here:` and a two-column table of all 60, `-` where nothing has happened |

  Every row of that table was re-measured on 2026-11-12 on a bare `generic-switch`, and the two shapes are the
  interesting part because they are what a reader would get wrong: with the log empty, `show logging dropp`
  prints the two lines about the vocabulary, then `The log is empty - nothing has run in this lab yet`, and
  **no** `Closest:` line; after a single failed ping it prints `Types with events so far:` followed by
  whatever has fired — `drop, ping` on a bare switch, `drop, frame, lldp, ping` on one with a PC cabled to
  it — and `Closest: drop` instead.

  The second line in each row is state-dependent too, and that is the trap in reading the table above as a
  single transcript: on an **empty** log a real type answers `% The log is empty: nothing has run in this lab
  yet` and `% Run something ("ping <addr>", a simulation step) and this fills up`, while `lists all 60 of
  them, with what has happened` appears only once the log holds something. Both states were measured, so the
  row is exact for the after-a-ping state it is labelled with. `show logging stp` really does answer for `stp-block`, `show logging types |
  include acl` really is the single `acl-deny             -` row, a bare `show logging d` really is read as
  the `device` keyword, and the header really says 60. One wrinkle worth knowing when reading output: the
  empty-log third line is `% The log is empty: nothing has run in this lab yet` (colon) for a **real** type
  and `% The log is empty - nothing has run in this lab yet` (dash) for an unrecognised word, so the two
  branches do not print the same sentence punctuation.

  Prefix resolution now draws on the whole vocabulary rather than only the types that have already fired,
  so `show logging dro` works in a lab where nothing has dropped yet. `show logging types` composes with
  the output filter (`show logging types | include acl` answers the single `acl-deny -` row). One
  behaviour to keep in mind: a bare `show logging d` is not read as the type `drop` — it resolves to the
  `device` keyword and asks for a name.

  The unknown-word answer has **two shapes**, and which one you get depends on whether anything has
  happened yet. Once at least one event has fired, `show logging dropp` prints three lines plus a
  suggestion — `% "dropp" is not a type this console records, so no event of it can ever appear`,
  `% "show logging types" lists the 60 types this console does record`,
  `% Types with events so far: drop, ping`, `% Closest: drop`. In a lab where nothing has run, the third
  line is instead `% The log is empty - nothing has run in this lab yet` and **no `Closest:` line is
  printed at all** — not even for `dropp`, which earns one a moment later. The branch that computes the
  hint is only reached once the log is non-empty, so do not read its absence as "the vocabulary has
  nothing like this".

  `test/event-types.test.js` holds **37 assertions**. See
  [docs/CLI.md](docs/CLI.md).

- **A reverse lookup, and the way back out of every DNS setting.** `nslookup <name>` resolved forward;
  given an address it now asks the **reverse** name and says so before answering, so the transcript does
  not look like a lookup of something nobody typed:

  ```
  Router-d2#nslookup 10.0.0.53
    (as 53.0.0.10.in-addr.arpa - a reverse lookup of 10.0.0.53)
  Server: Router-d1
    10.0.0.53 -> web1.lab.example (PTR)
  ```

  The answer is printed against the address that was typed, not the `in-addr.arpa` name the resolver
  actually asked. And every DNS setting now has a removal, which several of them did not: `no dns zone
  <name>`, `no dns add <name> [<type>]`, `no ip name-server [<address>]`, `no ip domain-name` and
  `no ip domain-lookup`. Each one reports what it did rather than answering silently —
  `Zone 0.0.10.in-addr.arpa removed (it held no records)`, `Removed 1 record for
  53.0.0.10.in-addr.arpa (PTR)`, `Name server 10.0.0.53 removed` — and the bare form is a different
  operation from the addressed one: `no ip name-server` with two servers configured answers
  `Name servers cleared (2)`, while naming one leaves the other in the list. A removal that has nothing
  to remove says why in two lines instead of one: `% No zone named lab.example on Router-d1` followed by
  `% This device serves no zone - nothing to remove`.

  Two details that cost a lab an hour if you assume otherwise: turning lookup **off** does not forget
  what was learned — `show hosts` keeps the resolved rows (`53.0.0.10.in-addr.arpa web1.lab.example
  dynamic now`) while reporting `Name lookup is disabled ("ip domain-lookup" turns it back on)` — and
  `show dns` takes **no** argument, so `show dns zones` is refused (`% "show dns" takes no argument
  here - type it on its own, or "?" for the commands`). See [docs/CLI.md](docs/CLI.md).

- **`show hosts` — the resolver view, including the names that failed.** The only way to see what a
  device would ask, and what it had learned, was to read the config back and guess. The view prints the
  default domain, whether lookup is on, and the servers it will ask, then either says plainly that
  nothing has been resolved yet or shows a table with IOS's `Host / Address / Type / Age` columns. Both
  halves were measured:

  ```
  Default domain is lab.example
  Name lookup is enabled
  Name servers are 10.0.0.53

  No name has been resolved here since this lab started
  A "ping <name>" asks the servers above and records the answer here
  ```

  A **failure** is recorded as a failure rather than dropped, which is the half that matters when a lab
  cannot reach its name server — the name is listed with `unresolved failed now` and then repeated
  under the table with its own reason, one line per failed name:
  `% nosuch.lab.example did not resolve - no server hosts a zone for it`. There is no separate tally; a
  second failed name adds a row and a line. The last line says where the full record is:
  *"The full record of each lookup is in `show logging` (type dns)"*.
  Two limits worth knowing before the fingers try them: there are **no static host entries** —
  `ip host coredb 192.168.1.20` answers `% Unrecognized config command` — and the view exists on every
  device, so a switch with nothing configured prints the same empty state instead of refusing. See
  [docs/CLI.md](docs/CLI.md).

- **The output pipe: `| include`, `| exclude`, `| begin`, `| section`, `| count`.** `show running-config |
  include route` was read as a **port name** — `% show running-config takes one port, not "| include route"` —
  so the console blamed the port table for a filter it did not have. Five filters now, matched as plain
  case-insensitive text rather than as regular expressions (the page says so instead of pretending to be
  grep), chaining (`| include interface | count`), usable after `do` inside a configuration block, with an
  unknown filter refused by name and the five that exist listed. Two rules keep the pipe from lying: **a
  refusal is never filtered** — a `% …` line passes through untouched, because a filter that swallowed the
  reason a command failed would be the most expensive filter in the console — and **silence is reported**,
  because "printed twelve lines, none matched" and "printed nothing" look identical on a blank screen. See
  [docs/CLI.md](docs/CLI.md).

- **The `show ip …` spellings an operator actually types, and one honest refusal.** `show ip
  access-lists` was an unknown command even though `show access-lists` answered a full table, so the
  IOS-shaped spelling now returns the same table. `show ip dhcp snooping` is the opposite case: the
  feature is **not modelled**, and the command says so instead of borrowing a nearby answer — it
  explains that a switch here forwards DHCP as an ordinary broadcast, that nothing inspects, filters or
  rate-limits DHCP messages per port, that there is no trust state or binding table to show, and which
  two commands do answer something real (`show mac address-table` for the port a client is on, and
  `show ip dhcp binding`, which exists only on a device that is a DHCP server). A refusal that points
  at the wrong device's table was the older behaviour; this one names the gap. See
  [docs/CLI.md](docs/CLI.md).

- **`show interfaces switchport [<port>]` — the whole switch's L2 state in one answer.** The only way
  to ask a port what it was configured to be was `show interfaces <port>`, whose summary column said
  `switchport` and stopped there. The new view prints one block per port, or one block for the port you
  name (and refuses a second port: *"show interfaces switchport [<port>] takes one port at most"*), with
  `Administrative Mode`, `Operational Mode`, `Access Mode VLAN`, `Voice VLAN`, `Port Security` and
  `Description`. A trunk swaps the access lines for the ones that matter on a trunk —
  `Trunking Native Mode VLAN: 10`, `Trunking VLANs Enabled: ALL`, `Administrative private-vlan: none` — so
  an access port and a trunk port do not answer with the same six rows. See [docs/CLI.md](docs/CLI.md).

- **`show ip traffic` — and the same answer says what it does not count.** IOS prints a per-protocol
  breakdown (ICMP/TCP/UDP/ARP totals); this model counts **frames per port**, so the command reports
  per-port totals (`Received`, `Sent`, `Dropped`) and then says so in its own words: *"a per-protocol
  breakdown … is not counted. This model counts frames per port, so `show interfaces counters` is the
  same numbers with the ports kept apart."* A command that invents a protocol split it does not have
  would be worse than the missing command, so the gap is printed rather than filled. See
  [docs/CLI.md](docs/CLI.md).

- **`?` at a value slot completes from the device.** `interface Fa?` answered *"Nothing after `interface`
  starts with `Fa`"* while the device held eight such ports: the placeholder was completed from the help
  table, which holds the word `interface` and no device's ports. It now completes from the device, with a
  second column saying what each one is (`Fa0/1  switchport, VLAN 1, up, 1G`), `interface vlan ?` explains
  the slot it is asking for ("the switch's own address in that VLAN (an SVI)"), and a fragment that fits
  nothing is still refused. See
  [docs/CLI.md](docs/CLI.md).

- **`terminal length`, `terminal width` and `show terminal` — and a `#` line is told which mark comments.**
  `terminal length 0` opens half the pasted transcripts on the internet and `show terminal` is the question
  "what is this session set to"; both answered `% Unrecognized command` and `% Invalid show command`.
  Now `terminal length <0-512>` (0 = no pager), `terminal width <40-512>` and `show terminal`, which reports
  length, width, that there is no pager and which exec level the session is at. The answer says plainly that
  the setting changes nothing anybody can see — there is no pager to pause, so every line a view prints is
  printed — rather than pretending a page break exists; an out-of-range number is refused with the range and
  a word after the number is refused rather than dropped. A `#` line is still a command here (there is no
  `#` comment), but the refusal names the mark that works: `!` — **in exec mode only**. Measured on one
  switch, the same line in the two modes:

  ```
  SW1#         # x   ->  % Unrecognized command: # x
                         % A comment line starts with "!" - a line beginning with "#" is read as a command
  SW1(config)# # x   ->  % Unrecognized config command: # x
  ```

  `! x` is accepted silently in config mode. So a pasted configuration that uses `#` comments is refused
  without the hint that would fix it, because the config-mode parser has no equivalent sentence. See
  [docs/CLI.md](docs/CLI.md).

- **`ip nat inside source static …` and `… list <acl> interface <if> overload` are commands now.**
  The rules had a data path — `engine/nat.js` translates static, dynamic and PAT, and the translations
  show up in `show ip nat translations` — but the only way to write one was the topology JSON. Static
  and PAT are configurable from the console: `ip nat inside source static 10.0.0.5 203.0.113.5` answers
  `NAT rule added on R1: static 10.0.0.5 -> 203.0.113.5` and lands in `show running-config`, and the
  PAT form refuses an addressless interface (`% eth0 has no address - "overload" translates onto that
  address`) or a missing ACL rather than writing a rule that can never match. A **pool** rule is still
  JSON-only: `ip nat pool …` is refused with `% This model translates inside source addresses ("ip nat
  inside source …"), not "pool"`. See [docs/CLI.md](docs/CLI.md).

- **`switchport voice vlan <id>`, and a voice VLAN that is finally read.** `voiceVlan` had been in the
  port's VLAN shape since VLANs were modelled — kept by `normalizePortConfig()`, insisted-on by
  `validatePortConfig()`, listed by the switchport reset — and **nothing wrote it and nothing read
  it** (#1369): there was no command, `classifyEgress`/`classifyIngress` consulted the allowed list
  only (so a phone's tagged frames landed in the data VLAN), `show interfaces <port> switchport`
  printed `Voice VLAN: none` on every port in every lab, and `serialize()` dropped the field so a
  saved lab came back without one. Now: the command writes it and refuses a number that is wrong (the
  native VLAN, a VLAN the trunk does not allow, 0, 4095, a trailing word) while **leaving the port's
  mode alone** — a voice VLAN is a parameter, not a mode; the classifier carries it in both directions
  (always tagged on egress, including on an access port, where it is the one tag an access port
  understands); the L2 view and the inspector both name it; `show running-config` prints the line and
  a save restores it. See [docs/CLI.md](docs/CLI.md).

- **The console over HTTP is the console.** Three defects, all measured against
  `POST /api/topologies/:id/config/:devId` (#1335): the session was built on its own `Simulator`, so
  `/flows` counted traffic that `show interfaces` could not see and a `ping` counted nothing the
  payload published — one board, two accountings; the endpoint took no instant at all, so a lab the
  cable endpoint reported mid-convergence could not be asked about that moment; and `show
  spanning-tree` printed whichever tree a Simulator had written last, because a cached session never
  re-derived its planes after another request removed a cable. The console now runs on the
  topology's flow table and per-port counters, `atMs` is applied on **every** request (answered with
  `runAtMs`, `null` = settled, plus the `convergence` schedule), and the derived planes are keyed on
  the topology's revision so a cable removed through REST is in the next answer. See
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

- **A number that names something is not a time.** `show vrrp <group>` and `show ip ospf <process-id>`
  took their number as a convenience *instant*, so `show vrrp 1` on the group-1 master answered "VRRP
  at t=1 ms" from before the election, and `show ip ospf 99` answered about process 1 at t=99 ms —
  two different questions, one word apart, with nothing saying the argument had been dropped. The
  rule now: a trailing number is an instant only where the view has no other use for one. Both forms
  filter to what they name (`% No VRRP group 9 on R1` / `% No OSPF process 1 on R1` list the ones that
  do exist), `at <ms>` and `converged` stay instants everywhere, and the help page says
  `show vrrp [<group>]` / `show ip ospf [<process-id>]`. See [docs/CLI.md](docs/CLI.md).

- **`show tech-support` answers with the views that exist instead of "invalid command".** A model
  with no memory image, no register state and no log file cannot produce a support bundle, so the
  command says so and then names what does answer the same questions — `show version`,
  `show running-config`, `show interfaces`, `show ip route`/`show ip ospf`/`show ip bgp summary`,
  `show logging`, `show history`.

- **`show spanning-tree vlan <id>` asks about one VLAN, and refuses an absent one honestly** —
  `% No VLAN 20 on SW1 - nothing is configured for it and no port carries it`, followed by the VLANs
  that do exist. It no longer reports VLAN 1's tree for a VLAN nobody configured.

- **The `clear` family takes its keywords, and a bare word is read as an address, not a guess.**
  `clear counters bogus` answers `% No interface named bogus on SW1` with a hint at
  `show ip interface brief`, and `clear port-security …` refuses on privilege
  (`needs enable mode - type "enable" first`) before it argues about the interface.

- **An SVI is an address, not a port.** `no vlan 30` on a VLAN holding the switch's own address now
  answers `% VLAN 30 is this device's own address: Vlan30` and names the remedy
  (`Remove the interface first - "no interface vlan 30" - and the VLAN stays empty`) instead of
  offering `switchport` for something with no cable. `show vlan brief` marks the row `Vlan30 (SVI)`,
  and the two dependencies — the interface and the VLAN — are reported as two separate steps.

- **`traceroute` / `tracert`** — walks the path the routing tables select, hop by hop, with each
  hop's address, device and cumulative one-way delay. It deliberately does **not** send
  TTL-limited probes: ICMP errors are still unmodelled (no destination-unreachable, no
  time-exceeded), so there is nothing for a probe to learn that the table cannot say.

- **`show power inline`** — the PoE decision from both ends: the resolved budget and where it came
  from (`spec` / `research` / `model name` / `unknown`), per-port draw and status (`on` vs
  `denied (budget exhausted)`), and on the powered device what it requests and whether a PSE
  answered. A green port is no longer the only evidence that power was delivered
  (`docs/PHYSICAL_LAYER.md`).

- **`show ip dhcp pool` / `show ip dhcp binding`** — pool summary with addresses actually in use,
  and the lease as seen from the server *and* from the client (`docs/CLI.md`, "DHCP server").

- **`excluded-address` inside a DHCP pool, and two arguments are one range.** In `config-dhcp`,
  `excluded-address 10.0.0.100 10.0.0.110` used to read as two addresses the way a `network` line
  reads, so a client could still be handed an address from the middle of a range the operator had
  excluded. It is one range now: `show ip dhcp pool` prints `Excluded : 10.0.0.100-10.0.0.110` and the
  usable count drops from 253 to 242. Separate lines stay separate — adding `10.0.0.200` and
  `10.0.0.201` one at a time prints `10.0.0.100-10.0.0.110, 10.0.0.200, 10.0.0.201` and counts 240 —
  because concatenating two adjacent singles into a range would silently widen it when a hole between
  them was meant to stay.

  Both counts were re-measured on 2026-11-12 on a fresh `10.0.0.0/24` pool and are exactly those numbers, and
  the arithmetic is worth spelling out because neither count follows from the output alone: the `Range` is
  `10.0.0.1 - 10.0.0.254` (254 addresses), the router's own address is reported separately as
  `Not leased : 10.0.0.1 (this router)` and is why the baseline is **253**, the eleven addresses `100`-`110`
  take it to **242**, and the two singles take it to **240**. The line that carries it is
  `In use     : 0 of 242`.

- **`clear ip dhcp binding [*|<address>]`** — the binding table can be emptied, and says so when there
  is nothing to empty: `% R1 holds no DHCP bindings`. A device that is not a DHCP server refuses with
  its own line rather than reporting an empty table, which would read as "a server that has heard
  nothing".

- **`show ip dhcp server statistics`** — pools, automatic and manual bindings, leases given, renewed
  and expired, and failed requests. The footer states the unit, because it is not the obvious one:
  **one event per completed exchange**, not per DHCPDISCOVER/DHCPOFFER/REQUEST, so the numbers count
  exchanges and will never match a packet capture.

- **`show ip route` names every code it prints.** The legend is built from the table, so `O` (OSPF)
  and `B` (BGP) appear when - and only when - a row uses them, instead of rows the header never
  explained.

- **`nslookup <name> [type]`** — the record type argument (`A`, `AAAA`, `CNAME`, `MX`, `NS`, `PTR`,
  `SOA`, `TXT`, `SRV`). An unknown type is refused with the list rather than silently treated as
  `A`, and a type the name does not carry answers **empty NOERROR**, not NXDOMAIN - the distinction
  a resolver makes and the one worth showing in a lab.

- **`show running-config` round-trips the IPv6 router-advertisement policy** - `ipv6 nd ra
  enable|disable|managed|other-config|lifetime`, `suppress-ra` and advertised prefixes. A dump
  taken from one router and pasted into a fresh one reproduces byte-identically, VRRP `advertise`,
  DNS zones and SCION included.

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

- **Fibre Channel is a first-class link type** (#980). Four FC cages (`fc-sfp`, `fc-sfp28`,
  `fc-sfpdd`, `fc-qsfp28`), sixteen FC media across 2/4/8/10/16/32/64/128G, and the real rate
  ladder: a 32G port runs at 28.05 Gbit/s and a 64G port at 57.8, because FC frames its payload.
  Two FC ports link and negotiate down the ladder; an FC port cabled to an Ethernet port is refused
  with `E_PROTOCOL_MISMATCH` naming both protocols, since the optic seats and the frames never
  cross. Seven SAN switches moved from Ethernet cages to FC ones, including Dell DS-6630B, which
  was hiding 96 × 32G and 8 × 128GFC behind an SFP28 model. See [docs/FIBRE-CHANNEL.md](docs/FIBRE-CHANNEL.md).

- **SFP56 cage and 50GBASE-SR/LR**, so a 50G SFP-form port is neither understated as 25G nor given
  a QSFP connector.

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
  document defects as `DOCUMENTS BUG` and reference the issues that will flip them. Those were the
  numbers in `a3905789` (#52); the same file now reports **253 assertions** and **one** surviving
  `DOCUMENTS BUG` marker, because #41/#42/#43/#44/#54 and #240/#241 flipped four of the five. The
  entry keeps the original count as the record of that work and the current one as what the file
  says today — `node test/protocol-regression.test.js` is the measurement.

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

- **Three views that were hidden or misfiled now answer as the device they are on.** Measured on
  `generic-switch` (SW1) and `generic-router` (R1) at `480eaaf8`:

  | typed | answer |
  |---|---|
  | `show ip route ?` on SW1 | the row's own completions — `at, bgp, connected, converged, ospf, static, summary, <dest>` — instead of *"is a command here, but not on SW1: it does not forward between interfaces, so it has no routes or adjacencies"* |
  | `show ip route` on SW1 | the table, with its `Codes: C - connected, S - static` header (empty with no `ip default-gateway`; a host answers an empty table) |
  | `show ip bgp` on SW1 | `% SW1 is a layer 2 switch: no BGP process can run here` / *no neighbours and no BGP table* / `"show ip route" is the table this device does have` |
  | `show ip bgp` on R1 (no `router bgp`) | still the enablement advice — `% BGP is not enabled - "router bgp <as>" in config mode turns BGP on` — because on a router it works |
  | `show interfaces switchport` on SW1 | the per-port list, where the family form used to refuse a device whose ports all switch |

  The gate was reading the wrong word: a row was treated as a BGP verb when the word `bgp` appeared
  anywhere in it, which hid `show ip route [<dest>|connected|static|ospf|bgp|summary]` — a row that
  offers `bgp` as one of seven filters and is on the page above as eight completions. A row is a BGP
  verb when BGP is the verb. `test/view-capability.test.js` holds **48 assertions** and sweeps one
  device from each catalogue category, typing every `show` row its page hides: a hidden row that
  answers is a view an operator would never find. See [docs/CLI.md](docs/CLI.md).

- **The output filter has a help page, and its names abbreviate like every other keyword.** `?` inside a
  filter used to be treated as the text to search for, so asking for help got you a filter applied to a
  question mark. Measured on one switch, before and after `1337bf89`:

  | typed at the prompt | before | now |
  |---|---|---|
  | `show running-config \| include ?` | `(nothing in this answer matches "\| include ?" - the command printed 10 lines)` | the five-filter help page: `\| include <text>`, `\| exclude <text>`, `\| begin <text>`, `\| section <text>`, `\| count`, plus the note that `<text>` is plain text, case-insensitive, not a regular expression |
  | `show running-config \| i vlan` | `% There is no "\| i" here - this console filters with include, exclude, begin, section and count` | `vlan 10 VLAN0010` — `\| i` abbreviates to `\| include` |
  | `show running-config \| c` | `% There is no "\| c" here …` | `11 lines` — `\| c` abbreviates to `\| count` |

  The refusal was honest but useless: it named the five filters while refusing a spelling of one of them.
  Chaining is unchanged — `show running-config | include interface | count` answers `8 lines` before and
  after — so what this commit adds is the help page and the abbreviations, not the pipeline.
  `test/pipe-help.test.js` holds **30 assertions**. See [docs/CLI.md](docs/CLI.md).

- **A view asked at a moment says which moment.** The dispatcher prints the instant line *before* the
  handler runs, so a handler that returns its own array instead of appending to the one it was given
  drops the line on the floor — and the answer then reads as if no instant had been asked for. Measured
  on one switch, before and after `d334df94`:

  | typed at the prompt | before | now |
  |---|---|---|
  | `show spanning-tree at 50` | `STP at t=50 ms (control planes rebuilt for this answer)` | unchanged — it already appended |
  | `show spanning-tree summary at 50` | `Spanning tree enabled protocol ieee - summary for SW1` — no instant line | `STP at t=50 ms (control planes rebuilt for this answer)` then the summary |
  | `show spanning-tree root at 50` | `Root bridge for every VLAN (one tree): …` — no instant line | the instant line, then the root answer |
  | `show spanning-tree summary converged` | (same omission) | `STP at converged (control planes rebuilt for this answer)` |

  The other half of the rule was already true and still is: a view that cannot answer at an instant
  refuses it by name — `show vlan at 50` answers `% "vlan at 50" does not take an instant` and lists the
  families that do (`show ip route|ospf|bgp|arp|dhcp …`, `show mac address-table`, `show spanning-tree`,
  `show vrrp`, `show lldp`). So the pair is now symmetric: label it if you took it, refuse it if you did
  not, never answer the question you would have asked without it. `test/instant-label.test.js` holds
  **16 assertions**. See [docs/CLI.md](docs/CLI.md).

- **A MAC address finds the port, in all three spellings.** `show mac address-table address <mac>` is the
  one question a MAC table exists for, and the family answered it as a stray argument. Measured on a
  two-host switch, before and after `9480a8e3`:

  | typed at the prompt | before | now |
  |---|---|---|
  | `show mac address-table address 02:00:00:00:02:00` | `% show mac address-table takes one port, not "address 02:00:00:00:02:00"` | the row for that address, then `02:00:00:00:02:00 is behind Fa0/3 in VLAN 1 - traffic for it is forwarded out that port` |
  | `show mac address-table address deadbeef0000` | the same refusal | `% deadbeef0000 is not in the table on SW1` / `% 2 entries are learned, and a MAC entry appears only once traffic has been seen from it` |

  Dotted (`0011.2233.4455`), colon-hex and bare forms all resolve, and `vlan <id>`, `dynamic`, `static` and
  `count` narrow it too — `show mac address-table count` answers `Total: 2 dynamic, 0 static, 0 secure`.
  The same commit makes a number after a keyword the keyword's value rather than a stray argument, so
  `show interfaces Fa0/2 counters` (which used to answer `% "counters" is not an argument to "show
  interfaces Fa0/2"`) now prints exactly the row `show interfaces counters Fa0/2` prints. Guards:
  `test/mac-lookup-and-port-counters.test.js` (**29 assertions**) and `test/port-args.test.js`
  (**85 assertions**). See [docs/CLI.md](docs/CLI.md).

- **Five families stop dropping a word they do not take.** A word past the last argument used to be
  ignored silently, so the command answered as if it had not been typed. Measured on `f197e34e^` and
  again on `f197e34e`:

  | typed at the prompt | before | now |
  |---|---|---|
  | `ip dhcp pool lab zzzz` | `Created DHCP pool lab` | `% Unexpected argument "zzzz" - ip dhcp pool <name> takes one name` / `% A pool name has no spaces: "ip dhcp pool lab"` |
  | `router bgp 65001 zzzz` | `BGP enabled, local AS 65001` | `% Unexpected argument "zzzz" - router bgp <as> takes one AS number` |
  | `dns zone lab zzzz` | `DNS zone lab ready` | `% Unexpected argument "zzzz" - dns zone <name> takes one name` / `% The zone name is the apex, e.g. "dns zone lab.example"` |
  | `ipv6 gateway 2001:db8:9::1 zzzz` | gateway set | `% Unexpected argument "zzzz" - ipv6 gateway <addr> takes one address` |
  | `ip helper-address 10.0.0.1 zzzz` | `Helper address 10.0.0.1 on Gi0/0 …` | `% Unexpected argument "zzzz" - ip helper-address <addr> takes one address` / `% A second server is a second line: repeat "ip helper-address <addr>"` |

  Three slots stay free text and are listed rather than guessed at — `description lab zzzz` answers
  `Description set on Gi0/0: "lab zzzz"`, `hostname` takes "the whole rest of the line, spaces included",
  and `vlan 10 name foo bar` answers `VLAN 10 created (name: foo bar)`. A refusal also changes nothing:
  `no ipv6 gateway zzzz` refuses and `show ipv6 route` still prints `S ::/0 254 2001:db8:9::1`.
  `test/stray-argument.test.js` types every configuration row on one device from each of the 25
  catalogue categories with a junk word appended — **26 assertions**, all passing. See
  [docs/CLI.md](docs/CLI.md).

- **`copy startup-config running-config` no longer says it applied lines it only read.** The two halves
  of the answer could contradict each other, and a count is not a report. Measured on a router whose
  saved copy was already in force, before and after `0cb9bd5d`:

  | | answer |
  |---|---|
  | before | `Copied … on R1: 5 lines applied` / `the running configuration did not change - the saved copy was already in force` |
  | now | `Copied … on R1: 5 lines read` / `none of them changed anything - the saved copy was already in force` |

  When the copy does change something it names the lines instead of printing a count — after saving with
  `hostname R1` and then renaming to `R9`, the copy back answers
  `Copied … on R9: 5 lines applied` / `1 line added, 1 line removed (this is a merge: lines the saved copy
  does not mention are kept)` / `+ hostname R1` / `- hostname R9`. The merge semantics are unchanged;
  what changed is that the sentence can no longer disagree with itself, and the diff is shown rather than
  counted. `test/modes-and-roundtrip.test.js` holds **14 assertions**. See [docs/CLI.md](docs/CLI.md).

- **A number is decimal digits, and a word after a port is no longer dropped.** `parseInt` reads `1e3`
  as `1`, `0x10` as `16` and `12abc` as `12`, so a line could configure a value nobody typed and answer
  as if it had worked. Measured in one session, before and after `6367b8bb`:

  | typed | before | now |
  |---|---|---|
  | `vrrp 1e3 ip 10.0.0.1` | `VRRP group 1 on Gi0/0 owns 10.0.0.1` — a group created from a word that is not 1 | `% Invalid virtual router id: 1e3 (1-255)` |
  | `vrrp 1 ip 10.0.0.1 priority 0x10` | `VRRP group 1 on Gi0/0 owns 10.0.0.1`, tail silently dropped | `% Invalid priority: 0x10 (1-255)` + `% Nothing was changed` |
  | `interface Fa0/1 zzz` | block entered, `zzz` dropped | `% Unexpected argument "zzz" - interface <port> takes one port` |
  | `interface GigabitEthernet 0/1` | — | `% Interface not found: GigabitEthernet 0/1`, quoted in full so the port reads as the wrong part |

  The documented VRRP tail is now read and applied instead of ignored:
  `vrrp 1 ip 10.0.0.254 priority 150 preempt advertise 2` answers
  `VRRP group 1 on Gi0/0 owns 10.0.0.254 (priority 150, preempt on, advertise 2 s)`, and the whole tail
  is judged before the group is created, so a refused line leaves nothing behind. `1.5` remains legal
  where a dot means something: `router bgp 1.5` answers `BGP enabled, local AS 65541 ("1.5" is asdot for
  65541)`. One helper, `_decimal`, now decides whether a word is a number. `test/strict-numbers.test.js`
  holds **60 assertions**. See [docs/CLI.md](docs/CLI.md).

- **`no ospf` takes three shapes, and each removes only what it names.** The handler ignored everything
  after `no ospf`, so an area id that cannot exist, a router id it never had, and one area all answered
  the same way: the whole process went away. Measured in a single session on a router with
  `ospf router-id 1.1.1.1` and `ospf area 10`, before and after `50383420`:

  | command | before | now |
  |---|---|---|
  | `no ospf area -1` | `OSPF disabled` | `% "-1" is not an area id (0-4294967295, or a dotted quad like 0.0.0.1)` + `% Nothing was changed` |
  | `no ospf router-id 9.9.9.9` | `% Unexpected argument "9.9.9.9" - no ospf router-id takes no more` | `% OSPF on R1 does not use 9.9.9.9` + `% It uses 1.1.1.1` |
  | `no ospf area 10` | `OSPF disabled` | `OSPF area 10 removed - the process is back in the default area 0` |

  The old behaviour made an ordinary lab step destructive: a router in `ospf area 10` could not be put
  back into area 0 without losing its router id and its interfaces. A dotted-quad area is the form the
  RFC prints and is accepted the way the display names it — in area 1, `no ospf area 0.0.0.1` answers
  `OSPF area 1 removed - the process is back in the default area 0`. A removal that names the current
  area on a process that is *not* in it refuses and hands back the state
  (`% OSPF on R1 is not in area 99` / `% It is in area 10`), and bare `no ospf` still disables the
  process, now saying what it took with it: `OSPF disabled (it was in area 10, with 2 interfaces in it)`
  — the count is interfaces actually participating, which means an address alone is not enough; they
  need `ip ospf 1 area 10`. `test/ospf-removals.test.js` holds **40 assertions**. See
  [docs/CLI.md](docs/CLI.md).

- **A row the page shows is a row the parser runs — the mirror of the capability gate.** The gate had only
  ever been tested one way: a row the page *hides* must be refused by the parser. The other direction was
  never checked, and on a device that cannot route it was broken in both halves. Measured on
  `apc/NetBotz NBRK0750` (`host`, `cli`, `http-server`, `dhcp-client`), where `ipv6 ?` used to offer four
  completions:

  ```
  ipv6 ?          was: Completions for "ipv6" (4): gateway, nd, route, unicast-routing
                  now: Completions for "ipv6" (2): gateway, route
  ipv6 unicast-routing   -> % PC1 does not route - … forwards no IPv6          (refused either way)
  ipv6 nd ra enable      -> % PC1 cannot advertise: it has no l3-forward capability …   (refused either way)
  no ipv6 unicast-routing
                  was: IPv6 unicast routing disabled on PC1 - this device now forwards no IPv6 packet
                       (its own addresses still answer)
                  now: % PC1 - it does not forward IPv6, so it can neither route it nor advertise a prefix
  ```

  Two rows the page promised and the parser refused are gone from the page; the third case is the worse
  one — the **removal** was accepted and reported a change, so a device that forwards nothing was told its
  forwarding was now off. The IPv6 routing and advertisement families follow the capability in both
  halves and on both sides (`ipv6 unicast-routing`, `ipv6 nd …`, `ipv6 router …` and their `no` forms),
  while `ipv6 address` and `ipv6 route` deliberately stay: a host has addresses and carries its way out
  as a route, exactly as it does for IPv4. The same pass gated the NAT *role* removal, so
  `no ip nat inside` is no longer offered where `ip nat inside` never was.

  **The guard now asks both questions of the same catalogue sweep** — a row the page hides must be
  refused (0 accepted) and a configuration row the page shows must not speak in a capability
  the device lacks (0 broken promises) — with exec views exempt on purpose, because `show
  vlan` on a router is offered and answered with a sentence explaining what the device keeps. The suite
  reads **153 passed, 0 failed**, and prints the two counts it swept: **2,941** rows refused and **3,574**
  typed on 2026-11-12, against 2,906 and 3,564 when this was written. Both climb with the catalogue, so run
  it rather than quoting them — the two figures that carry the guarantee are the zeros. See
  [docs/CLI.md](docs/CLI.md).

- **The interface block asks the capability question too, and a NAT role needs a device that translates.**
  The previous pass wired the gate into the configuration dispatcher only, so the same families still
  answered inside an interface block, and `ip nat inside` was granted on a box that rewrites nothing.
  Measured before and after `c15a8547`, on `advantech/ICR-3231` (port `eth0`) and
  `arista/7050SX3` (`l2-forward`, `l3-forward`, `cli` — it translates nothing, port `Et1`):

  ```
  no spanning-tree cost     was: Spanning tree cost on eth0 is already the speed-derived default
                            now: % PC1 - it runs no spanning tree, because it has no bridged domain to protect
  ip nat inside   (on SW1)  was: Interface Et1 is NAT inside
                            now: % SW1 does not translate addresses, so no port on it can be a NAT inside or
                                 % outside interface - it routes, but it rewrites nothing
  no ip nat inside          was: Interface Et1 is no longer NAT inside
                            now: % Interface Et1 is not a NAT interface - there is no role to remove (and SW1
                                 % does not translate addresses at all)
  ```

  A host gets its own wording, because it fails the routing test first: `ip nat inside` on `generic-pc`
  answers `% PC-PC1 does not route - NAT rewrites addresses between two routed interfaces, and this
  device has none`. Note which device is which, because the catalogue decides it and this entry called
  `ICR-3231` a host: it is filed as a **router** with `l3-forward` and `nat`, so on 2026-11-12 it
  *accepts* the role — `Interface eth0 is NAT inside`, then `(no port is outside yet - translation waits
  for one)` — and only a real host refuses it. The `no spanning-tree cost` line above still holds on
  `ICR-3231` (`% … - it runs no spanning tree, because it has no bridged domain to protect`), because
  the capability that governs spanning tree is not the one that governs NAT: one device can fail the
  first question and pass the second.

  The refusals that were correct statements without a marker now carry `%`, so a transcript
  cannot read a refusal as success.

  **The guard for the family.** `test/capability-gate.test.js` now sweeps one device from each of the 25
  categories in exec, configuration and interface mode, typing every help row — including the rows the
  device is *not* shown, with placeholders filled — and fails when the capability oracle refuses a line
  the parser still takes. It reads **150 passed, 1 failed** on `c15a8547`: the sweep refuses 2,966 rows,
  and the disagreement is the IPv6 routing family on l2-only devices (`ipv6 route …` and
  `no ipv6 unicast-routing` answered on a `switch` and an `ont`).

  Two gaps stay open, measured, and documented rather than papered over: the NAT **rule** is still
  accepted on a box that cannot translate (`ip nat inside source static …` on `arista/7050SX3` answers
  `NAT rule added on SW1: …` and `show ip nat statistics` counts `rules 1 (static 1)`), and the IPv6
  routing disagreement above. See [docs/CLI.md](docs/CLI.md).

- **A verb family is refused by capability, before the syntax question — and the `no` half is gated too.**
  The `?` page was capability-filtered; the parser was not, so a device that bridges nothing, routes
  nothing and serves no DHCP still answered the removals of those families, and answered four of them
  with **nothing at all**. Measured on `apc/AP9641` (`host`, `cli`, `http-server`, `dhcp-client`) at
  `D1(config)#`, before and after:

  ```
  no spanning-tree vlan 10   was: Spanning tree bridge priority on D1 is already the default (32768)
                             now: % D1 - it runs no spanning tree, because it has no bridged domain to protect
  ip dhcp pool lab           was: Created DHCP pool lab
                             now: % D1 - it is not a DHCP server
  no router bgp 65001        was: (no output)
                             now: % D1 - it does not forward between interfaces, so it has no routes or adjacencies
  no ospf area 10            was: (no output)
                             now: % D1 - it is not a router, so no routing protocol can run on it
  no router ospf 1           was: (no output)
                             now: % D1 - it does not forward between interfaces, so it has no routes or adjacencies
  no ip dhcp pool lab        was: (no output)
                             now: % D1 - it is not a DHCP server
  ```

  In that transcript `D1` is the device's **name** — the string the lab gives it — so every `%` line is
  verbatim as quoted. The long form appears only when a device was built without a name: `Device` falls back
  to `label + '-' + id` (`engine/device.js:114`), and the same refusal then reads `% APC Network Management
  Card 3 (UPS NMC)-D1 - it is not a DHCP server`. Both were measured on 2026-11-12; only the part before
  ` - ` moves, and the sentence after it is what to diff.

  A pool on a DHCP **client** and a bridge priority on a box with no bridge were the two that answered
  confidently; a silent success on a removal that removes nothing is the one answer a refusal must not
  give. Two rules came out of it: **the capability is answered before the syntax question** — `no router
  ospf 1` on a host is two questions at once, and on a router, where the capability exists, the extra
  word keeps its own refusal — and **the `no` half is the same capability**, because the filter matched
  `ip dhcp …` and not `no ip dhcp …`.

  Left alone on purpose: the positive forms, which already refuse in more specific words, and `ip route`,
  which a host uses for its way out (`Route added: 10.9.0.0/24 via 10.0.0.9` — labs configure it); the
  verb that refuses there is `ip routing`, which answers `% D1 is not a router: it has no interfaces to
  route between` and then `% A host uses "ip default-gateway <gw>" for the one router it sends everything
  to`. A new suite, `test/capability-gate.test.js`, holds **153 assertions** and passes. See
  [docs/CLI.md](docs/CLI.md).

- **A `/` between two placeholders is one value, not a choice.** The help grammar reads `/` as "or" —
  `configure terminal / conf t` is two spellings of one command — which is right between words and wrong
  inside one: `<prefix>/<len>` was lexed as two placeholders, so the page offered a slot the command does
  not have, and nothing was refused for it. `ipv6 nd prefix ?` answered `<prefix>` and then `<len>`;
  `ipv6 address <addr>/<len>` duplicated the same way. Both are one value and one slot now:

  ```
  R1(config)#ipv6 nd prefix ?
  Completions for "ipv6 nd prefix" (1):
    a prefix to advertise (SLAAC)
    Next: <prefix/len>

  R1(config)#ipv6 address ?
  Completions for "ipv6 address" (2):
    a static IPv6 address, or one learned from a router
    Next: autoconfig, <addr/len>
  ```

  The typed forms still work: `ipv6 address 2001:db8::1/64` answers
  `IPv6 address 2001:db8::1/64 on Gi0/0`, and `ipv6 nd prefix 2001:db8::/64` advertises with
  `L=1 A=1, valid 2592000s, preferred 604800s`. The same sweep found a row whose *first* token was a
  value — `clear ip dhcp binding * | <address>` produced a phantom row that was nothing but
  `<address>`, so the page offered a value slot where a verb goes and no completion could reach it. It
  is `*` and `<address>`, two rows, now. `test/placeholder-rows.test.js` pins the whole family: every
  documented row with a value in it is filled in from a table of values and typed, and must be a command
  the console takes.

- **A keyword the `?` page offers is taken at its shortest spelling.** The console completes a keyword
  from the help rows, and the parser accepted only longer spellings of the same word, so its own page
  contradicted it: `switchport p?` answers `port-security  more options`, and then `sw p` was refused.
  All three causes are closed — the global-config veto that protects `router ospf 1` in router mode was
  also firing on lines that merely looked like a config command, and returned "no expansion" when
  neither page could spell the line back; an ambiguity was erased by the respelling step and came out as
  a typo; and a word missing from the device's filtered page stalled the expansion half-way through a
  line. An ambiguity now answers the way IOS does, naming the candidates rather than pretending the
  input was wrong:

  ```
  Router-d1#li
  % Ambiguous command: "li"
  % Candidates: link, links

  SW1(config-if)#sh
  % Ambiguous command: "sh"
  % Candidates: shutdown, show
  ```

  Two smaller ones from the same sweep. `show` with nothing after it used to print the model's own
  empty-string artifact, `% Invalid show command: (empty)`; it is now the IOS answer with the words that
  can follow, counted from the same page `show ?` reads — `% Incomplete command.` and
  `% "show" needs a word after it - it takes version, clock, logging, ip, interfaces, history,
  terminal, arp and 12 more ("show ?" lists them all)` (8 named, 20 in total). And one help row offered
  a word that is not a word: `no switchport mode | no switchport access vlan | no switchport trunk ...`
  was whole commands
  separated by `|` with a literal `...` where the trunk forms go, so the page completed to something
  untypeable. It is five rows now, one per removal, and the VRRP and numbered-list rows got the same
  treatment.

  The proof is `test/shortest-abbrev.test.js`: every documented row in seven modes is abbreviated to its
  shortest unique prefix and typed, and the answer must not be `% Unrecognized`, `% Invalid` or
  `% Incomplete` — an ambiguity passes only when the refusal names two or more candidates that exist on
  that page. Measured on this tree, in `(config-if)#` on a switch — the mode is part of the
  reproduction, because at the exec prompt `sw p` is `% Unrecognized command: sw p` and `l r` is
  `% Invalid input: link r - expected up, down or state`, neither of which is the point being made:
  `sw p` answers `Port security enabled on Fa0/1` and then two lines describing the defaults it just
  applied (`Maximum 1 secure address, violation mode shutdown (IOS defaults)` and the line about the
  first source to arrive being learned), `l r` answers `LLDP receive on Fa0/1 is already on - the port
  is listening` in full, and `router-i 1.1.1.1` inside `router ospf 1` still sets the router id
  rather than being read as a global command — the veto still does its job, it just no longer
  does it to abbreviations. See [docs/CLI.md](docs/CLI.md).

- **A `no` that names a part no longer removes the whole thing.** `no vrrp 1 ip 10.0.0.99` deleted the
  **group** — including a working virtual gateway — and answered `VRRP group 1 removed`, so a typo in an
  address took the gateway down and the transcript agreed it had been asked for. The id is now read
  together with what follows it, and each part has its own removal: `no vrrp <vrid> ip [<address>]`,
  `no vrrp <vrid> priority`, `no vrrp <vrid> preempt`, and `no vrrp <vrid>` for the group itself. An
  address the group does not own is refused instead of obeyed, and the refusal hands back the state it
  was checked against:

  ```
  Router-d1(config-if)#no vrrp 1 ip 10.0.0.99
  % Group 1 on Gi0/0 does not own 10.0.0.99
  % It owns: 10.0.0.254, 10.0.0.253
  % "no vrrp 1" removes the group itself
  ```

  The bare form clears the addresses rather than naming one, and since the group is a virtual address it
  now goes with the last one (see the entry below); `no vrrp 1` remains the direct way to remove it. One
  cosmetic wart left in place: `no vrrp 1 priority` answers `priority back to the default 100 (was 100)`
  even when the value never moved.

- **A VRRP group is a virtual address, so the last address takes the group with it.** A group that owns
  no virtual address is not a state a router can be in, and this console could produce one: `no vrrp 1 ip`
  answered `VRRP group 1 on Gi0/0 no longer owns 10.0.0.254 - the group is still configured` and left a
  `Backup` group in `show vrrp` that no election could ever elect — with no configuration line that
  reproduced it. Removing the **last** address now removes the group and says why; removing one of several
  keeps it:

  ```
  Router-d1(config-if)#no vrrp 1 ip 10.0.0.253
  VRRP group 1 on Gi0/0 no longer owns 10.0.0.253
  Router-d1(config-if)#no vrrp 1 ip 10.0.0.254
  VRRP group 1 on Gi0/0 removed - 10.0.0.254 was its only virtual address
  Router-d1(config-if)#no vrrp 2 ip
  VRRP group 2 on Gi0/0 removed - it owned 10.0.0.100 and a group with no virtual address has nothing to be master of
  ```

  With the last group gone, the view says so instead of printing a header over nothing: `% VRRP is not
  configured - "vrrp <id> ip <addr>" inside an interface block adds a group`. Naming a group that does
  not exist is refused the same way for both forms (`% No VRRP group 2 on Gi0/0`, then `% "show vrrp"
  lists the groups configured on this device`). The refusal for an address the group does not own is
  unchanged and still hands back the state it was checked against.

- **`no vrrp 1 preempt` is configuration, not a reset.** Preempt is **on** by default, so the removal is
  how it is turned off — but it was read as "back to the default", which switched it back on, and because
  the dump only writes non-defaults nothing was written at all: a configured `preempt off` was lost on
  every save and reload. It now turns preempt off and says so in both directions:

  ```
  Router-d1(config-if)#no vrrp 1 preempt
  VRRP group 1 preempt off - a higher-priority router will not take the virtual address back
  Router-d1(config-if)#no vrrp 1 preempt
  VRRP group 1 preempt was already off
  ```

  and `show running-config | include vrrp` carries `no vrrp 1 preempt` afterwards. The rule the VRRP block
  follows: a default is not configuration, and a removal that changes a setting is.

- **A next hop has to be an address that can answer.** `ip route 10.9.0.0 255.255.255.0 127.0.0.1`
  was accepted, printed `Route added: 10.9.0.0/24 via 127.0.0.1`, appeared in `show ip route` with the
  `*` that means *installed*, and forwarded nothing — `ping 10.9.0.9` answered
  `Success rate is 0 percent (0/4)`. `ip helper-address` and `ip default-gateway` accepted the same
  five classes separately. One classifier now serves all three commands, so the refusal names the class
  and the command keeps its own tail:

  ```
  Router-d1(config)#ip route 10.9.0.0 255.255.255.0 224.0.0.5
  % 224.0.0.5 is a multicast group address (class D), so no neighbour can answer for it
  % A static route forwards to one next-hop address: a host on a connected subnet
  % Usage: ip route <network> <mask> <next-hop> [<interface>]
  Router-d1(config-if)#ip helper-address 127.0.0.1
  % 127.0.0.1 is a loopback address (this host, always), so nothing can answer a relayed request sent to it
  % A helper target is one unicast address: the server that will answer
  Router-d1(config)#ip default-gateway 224.0.0.1
  % 224.0.0.1 is a multicast group address (class D), so it cannot be a default gateway
  % A gateway is one unicast host on a directly connected subnet
  ```

  The five are `0.0.0.0` (zero address), `255.255.255.255` (limited broadcast), `224.0.0.0/4`
  (multicast), `127.0.0.0/8` (loopback) and `240.0.0.0/4` (reserved). Address **ranges** are refused
  as the class they belong to rather than as one address per rule, which is why `240.0.0.1` reads
  "reserved address (class E)" instead of being enumerated.

  A link-local IPv6 next hop is refused for a different reason, and the refusal gives the form that
  fixes it: `% fe80::1 is a link-local address, so it names a neighbour on one wire and not which
  wire` / `% Give the route its egress interface: "ipv6 route 2001:db8:9::/64 fe80::1 <port>"`.

  What the classifier is **not** is a reachability check: `ip route 10.9.0.0 255.255.255.0 1.2.3.4`
  is accepted and written to `show running-config`, because a unicast address is a legitimate next
  hop even when nothing answers it yet. Reachability is the separate report below.

- **An installed route with a next hop the router cannot reach is reported under the table.** `*` means
  *installed by administrative distance*, which an operator reads as "the way out", so a static route
  pointing into a subnet this router has no route to looked live. It is still accepted — a recursive
  next hop that another route covers is legitimate — but the table now says so:

  ```
  Router-d1#show ip route
  Codes: C - connected, S - static
    *  Prefix         AD  Gateway       Interface
    *  C 10.0.0.0/24  0   -             Gi0/0
    *  S 10.8.0.0/24  1   192.168.99.1  -

  % 1 installed route has a next hop this router cannot reach:
  %   10.8.0.0/24 via 192.168.99.1 - not on a connected subnet, and no route covers it
  ```

  The distinction is the model's own lookup rule: *not on a connected subnet* **and** *no route covers
  it*. A next hop that a default route covers is recursive, works, and is not reported.

- **`vlan 1` no longer claims to create anything.** VLAN 1 exists before the first command is typed,
  is never written to a saved copy and cannot be removed, but the command answered "VLAN 1 created".
  It now says what is true, and where to go instead:

  ```
  Switch (L2)-d2(config)#vlan 1
  VLAN 1 is the default VLAN - every port starts in it and it cannot be created or removed
  A VLAN you create gets its own id: "vlan 10 name users"
  ```

- **A DHCP pool's exclusions are removable one at a time.** `no excluded-address` could only clear the
  lot, so dropping one reservation meant deleting every exclusion and retyping them. It now takes
  `[<address> [<address>]]`: naming one removes that one, the bare form still clears everything and says
  how much (`All 2 excluded ranges removed`), and an address that is not an exclusion is refused with the
  list and the way out:

  ```
  Router-d1(config-dhcp)#no excluded-address 10.9.0.105
  % Not an exclusion here: 10.9.0.105
  % Excluded: 10.9.0.100-10.9.0.110, 10.9.0.200
  % "no excluded-address" removes them all
  ```

  That last transcript is the trap worth reading twice: `10.9.0.105` **is** excluded — it sits inside
  `10.9.0.100-10.9.0.110` — but the command matches the address that was *stated*, not membership in a
  range, so removing part of a range means restating the range narrower. The count in `All 2 excluded
  ranges removed` is ranges, not addresses.

- **A VLAN a port names now exists, and `show vlan` no longer invents one.** Three commands could name
  a VLAN that was never created — `switchport access vlan 10`, `switchport voice vlan 20`,
  `switchport trunk native vlan 10` — and the result was two views of the same switch disagreeing:
  `show vlan` listed a bridge domain with a port in it while `show running-config` had no such VLAN, so
  a saved lab lost the membership it was displaying. IOS creates the VLAN at that moment and says so,
  and here that message is the only place an operator learns a VLAN now exists:
  `Access VLAN 10 on Fa0/1 (VLAN 10 did not exist and was created - "no vlan 10" removes it)` and
  `Voice VLAN 20 on Fa0/1 (tagged; the untagged traffic on this port stays in VLAN 10) - VLAN 20 did not
  exist and was created`. The other half is the read side: membership is not existence, so a VLAN that
  is **allowed on a trunk and nothing else** no longer appears as an active VLAN. `show vlan` now has
  three states instead of two — carried by a port (an access port, a native VLAN, a voice VLAN shown as
  `Fa0/1(v)`, or an SVI), declared and empty, or merely allowed — and it names the third out loud
  rather than dropping it silently:

  ```
  % 77 is allowed on a trunk but not configured, so it is not a VLAN on this device:
  %   vlan <id>                               creates it
  %   switchport trunk allowed vlan remove <id>  drops it from the allowed list
  ```

  See [docs/CLI.md](docs/CLI.md).

- **`wired-port-has-media` now asserts that every cabled port has a medium**, rather than guarding
  only the ones that already had one. 84 coax and 24 MCX ports had none, so the picker silently
  omitted them and no check noticed. `test/wired-port-has-media.test.js` still owns the question and
  prints `36 passed, 0 failed` on this tree - the 84 above is a count of coax ports, not of assertions, which
  is exactly the kind of thing that gets transposed when a page is repaired.

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

- An 8-wide faceplate group no longer clips port names mid-glyph.

- Palette search finds `MC220L` by `mc-220l`, `mc 220l` or `TL-MC220L`.

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

- The multi-vendor campus example lab cabled a 25G SFP28-only switch to 1G RJ45
  ports — physically impossible. Rebuilt with valid copper and 1G-fiber uplinks;
  the new validator now catches this class of error in CI.

### Devices

- Acer Nitro 5 AN515-57 added from hardware request #23.

### Known defects (filed, not fixed)

Checked against the tree as it stands, so that the list does not outlive the defects. Where a defect no
longer reproduces, the measurement is recorded beside it and the entry is kept for the record.

**As of this pass, none of the five reproduces**, and each rests on a measurement rather than a reading of
the code: #41 (three routers, iBGP split horizon), #42 and #43 (two OSPF speakers, `show ip route`
on both sides), #44 (three neighbours on one segment, costs flipped) and #54 (`flowKeyOf()` keys on both
`insideLocal` *and* `insideGlobal`, and two hosts behind one overload pool get `:1024` and `:1025`). Nothing
here is a claim about today; the entries stay as the record of what was filed.

Re-run once more on this tree, from the console rather than from the code: #42, #43 and #44 rebuilt as live
labs (two routers cabled port to port; then three L3 switches fanned off the eight-port L2 switch so one
segment really is shared), and #54 read straight off `flowKeyOf()` at `nat.js:563-568`, which now joins
`insideLocal` *and* `insideGlobal` into the key. All four answers were the same as below.

Re-run again on 2026-11-12, because "no longer reproduces" is a claim that decays: the two-router lab gave the
route table quoted below **line for line** (`C 10.0.0.0/30`, `C 10.1.0.0/24`, one `O 10.2.0.0/24` via
`10.0.0.2`), `show ip ospf` gave `Gi0/0 10 0 active` beside `Gi0/1 10 0 passive`, and the neighbour installed
`O 10.1.0.0/24` — #42 and #43. The three-router lab over the eight-port `generic-switch` (`portTemplate`
`Fa0/`, 8 ports) put all three on one segment — both peers `FULL` in `show ip ospf neighbor` — and R3's prefix
table read **20** for R1's LAN and **110** for R2's with costs 10/100, then **110** and **20** with the costs
swapped - #44, chosen by interface cost and not by id order. `flowKeyOf()` is at `nat.js:563` and joins
`[proto, insideLocal, srcPort, dstIp, dstPort, insideGlobal]`, so #54's key has both addresses in it. The two
transcripts below are excerpts, not full output: `show ip route` also prints its `Codes:` and
`Prefix / AD / Gateway / Interface` header lines first, which is worth knowing before diffing a run against
them. And the trap recorded below is real — `ip ospf cost 10` before OSPF is enabled answers
`% OSPF is not enabled - "ospf router-id <ip>" in config mode turns OSPF on`, exactly the courtesy that
stopped the first attempt at #44 from becoming a false report.

#54 re-measured on the current tree, because the traffic and VLAN work has since touched both
`simulator.js` and `cli.js`: two hosts in different subnets behind one
`ip nat inside source list 1 interface Gi0/2 overload`, one flow each to `203.0.113.9:80`, and
`show ip nat translations` reports them apart — and this is the interesting part — although **both flows
were refused** (`400 E_REFUSED`, nothing listening on the far port):

```
tcp  203.0.113.1:1024  192.168.1.10:49152  203.0.113.9:80  203.0.113.9:80  pat
tcp  203.0.113.1:1025  192.168.2.10:49152  203.0.113.9:80  203.0.113.9:80  pat
```

Both inside locals share source port `49152`, which is exactly the case a key on the port alone would
collapse. A refused flow still leaves no *record* — `GET …/flows` on the board is empty and `GET …/flows/flow-1`
is `404` — while the translation above survives, which is documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Re-measured end to end on the current tree, since the DHCP work has since touched both `cli.js` and
`simulator.js` — the two transcripts worth keeping, because they are the ones that could quietly invert:

```
Router-d1#show ip route                      (R1, an OSPF speaker, 10.0.0.1/30 + 10.1.0.1/24)
  *  C 10.0.0.0/30  0    -         Gi0/0
  *  C 10.1.0.0/24  0    -         Gi0/1
  *  O 10.2.0.0/24  110  10.0.0.2  Gi0/0     <- only the neighbour's network, as `O`

Router-d1#show ip ospf                        (after `ip ospf passive` on the LAN port)
    Gi0/0      10    0     active
    Gi0/1      10    0     passive

Router-d2#show ip route 172.16.1.0            (a second two-router lab, R1's LAN now passive)
  Matched      172.16.1.0/24  (OSPF, AD 110)  <- a passive interface is still advertised
```


- #41 BGP re-advertises an iBGP-learned route to another iBGP peer; next hop becomes the relayer.
  **No longer reproduces** — re-measured on the current tree with the same three routers in AS 65001 and
  no full mesh: `R2` learns `10.1.0.0/30` from `R1` over iBGP (`show ip bgp` on R2 lists
  `*>  10.1.0.0/30  10.2.0.1  -`), and `R3` never receives it — its table holds only R2's own connected
  `10.2.0.0/30` and its own `10.3.0.0/30`, and `show ip route` on R3 shows `B 10.2.0.0/30  200  10.3.0.1`
  with no route to `10.1.0.0/30`. Both of R2's sessions are `Established`/`iBGP` in
  `show ip bgp summary`, so the route was available to re-advertise and was not. iBGP split horizon
  holds; the sentence that used to be here said the opposite.

- #42 OSPF installs a route for its own connected network, at transit cost. **No longer reproduces** —
  `show ip route` on an OSPF speaker shows `C` and only `C` for its own two subnets, no `O` row for
  either, and the neighbour learns them instead.

- #43 OSPF does not advertise a passive interface's network at all. **No longer reproduces** — with
  `ip ospf passive` on the LAN port (`show ip ospf` reports its state as `passive`), the neighbour still
  installs `O 172.16.1.0/24`, which is what a passive interface is supposed to do: no adjacency, stub
  network still advertised.

- #44 OSPF keeps the more expensive advertisement for a shared network, chosen by id order.
  **No longer reproduces** — built the lab: R1, R2, R3 all FULL neighbours on one segment, R1's segment
  port `ip ospf cost 10` and R2's `100`. R3's route to R1's LAN came out at cost **20** and to R2's LAN at
  **110**; flipping the two costs flipped the routes to **110** and **20**. Each router's own interface
  cost is used, so nothing is being chosen by router-id order. The figure is read from the prefix table of
  `show ip ospf database`, which is the only view that prints a cost - `show ip route <prefix>` answers
  `Matched 10.1.0.0/24 (OSPF, AD 110)` and stops there, so a check of "the route is fine" cannot be redone
  from that command alone. Built again the same way it still reads 20 and 110, then 110 and 20 with the
  costs swapped. (The lab also has to enable OSPF before
  setting interface costs — `ip ospf cost` is refused with *"% OSPF is not enabled"* otherwise, which is
  how the first attempt at this measured a flat 20 everywhere and nearly became a false report.)

- #54 NAT `flowKeyOf()` omits the inside source, so two hosts behind one PAT pool collide.
  **No longer reproduces** — `flowKeyOf()` now keys on both `insideLocal` and `insideGlobal`, and two
  hosts behind one overload pool get separate translations (`203.0.113.2:1024` for `10.0.0.10`,
  `203.0.113.2:1025` for `10.0.0.11`), both pinging the far side `4/4`.


## 0.1.0 - 2026-11-07

*This entry describes the initial commit `562b7b4c` (2026-11-07), and its numbers are that commit's: 91 JSON
specs across seventeen vendor directories under `devices/` (`git ls-tree --name-only 562b7b4c devices/` lists
eighteen entries — the seventeen plus `registry.js`), which is a census of the first day rather than of today's
1,661. Two items on the CI line have since left the tree: `codeql.yml` and `release.yml` existed at that commit
and `.github/workflows/` was later removed in favour of `.forgejo/workflows/ci.yml`, so the present tense there
is historical — see [docs/CI.md](docs/CI.md) for what runs now. The registry publish it describes keyed on `v*`
tags, and this repository has never carried one (`git tag` is empty), so no image was ever pushed from it. The
version number lives in three places, not two — this heading, `package.json`, and a literal inside the
console: `show version` ends `Simulator  : PacketForge 0.1.0` because `engine/cli.js:9314` pushes that
string rather than reading the manifest, so a bump has to be typed there as well or the CLI and the API
will disagree about what is running (`server/index.js:304-307` does read `package.json`); `[Unreleased]` is
the file's only link reference.*

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

[Unreleased]: https://git.jayw.uk/jaylouisw/packetforge/compare/main...HEAD
