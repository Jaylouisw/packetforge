## Unreleased

### Fixed

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

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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

## [Unreleased]

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
