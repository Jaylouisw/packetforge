# Roadmap

PacketForge is a working foundation, not a finished product. Priorities below.

A box is ticked only where the code answers for itself — every shipped line names the module
and the suite that keeps it honest, so a tick is checkable rather than aspirational, and an
unticked line that survives here is a real gap.

The line numbers are hints, and they rot: `engine/cli.js` is edited every day, so a number that was
right last week can land on unrelated code this week. Treat the **symbol** as the citation — `_helperAddress`,
`_dhcpRelayFor`, the refusal text — and read the number as a place to start looking. Three citations on
this page had slid by 30 to 120 lines when this note was added; the symbols had not moved at all.
They track the **working tree**, which on this branch carries the writer's pending `engine/cli.js` edit: at
`_helperAddress` the worktree line is `:11781` and `HEAD`'s is `:11773`, so a citation checked against `git show`
will disagree by eight lines and neither number is wrong.

## Simulation engine

The absences on this page are checkable the same way the presences are, and they are the claims most
likely to rot — an absence needs re-measuring, because the day someone adds a congestion window the
paragraph that says there is none becomes a lie with no failing test behind it. Today, re-measured:

```sh
grep -nEi 'cwnd|congestion|sack|time_wait|timewait|window ?scale' engine/flow.js   # 3 hits, all comments
grep -rnEi '\btls\b|createServer|https?\.request|net\.Socket' engine/*.js        # no hits, exit 1
```

Read the exit codes with care: the second command exits **1**, which is grep saying "no line matched", not
grep failing. Under this repository's own shell `echo $?` prints `0` even after a failed command, so check the
outcome with `&&`/`||` — `grep … >/dev/null && echo MATCHED || echo NOMATCH` — rather than reading `$?`.

Re-run that way on 2026-11-12 the first command reports **MATCHED** and the second **NOMATCH**, and the three
hits are still at `engine/flow.js:19`, `:20` and `:29` — all three comments, two stating the absences and the
third explaining that MSS options "all eat into the same budget". A presence would look different: it would be
code. The same run shows why the advice matters: appending `; echo rc=$?` to that second grep prints `rc=0` for a
command that matched nothing, while the `&&`/`||` form beside it prints NOMATCH — same command, two answers, and
only one of them is about the repository.

So "no congestion window, no retransmission timer, no SACK, no TIME_WAIT, no window scaling, no ICMP
port-unreachable" and "sockets, HTTP and TLS remain absent" are still true, and the first line of evidence is
the module's own comment (`engine/flow.js:19-20`), which is the cheapest thing to keep honest: if a feature
lands, that comment is the first line to go stale and the first one a reader trusts.

- [x] **TCP/UDP transport** — `engine/flow.js` is a real transport layer, not a probe: the
      three-way handshake as three frames, an MSS derived from the path MTU, segmented data with
      cumulative ACKs, a four-way close, RST, and UDP datagrams with ephemeral ports
      (`test/flow.test.js`; flows are opened over `POST /flows`, never by a stray packet). What is
      **not** there, in the module's own words: no congestion window, no retransmission timer, no
      SACK, no TIME_WAIT, no window scaling, and no ICMP port-unreachable for a stray UDP datagram.
      Nothing above transport either — no HTTP request, no TLS handshake, no SSH banner. **Sockets,
      HTTP and TLS remain absent.**
- [x] **DHCP** (DORA exchange) — `engine/dhcp.js` is in the data path, with pools, ranges,
      exclusions and reservations (`test/dhcp.test.js`, `test/dhcp-in-path.test.js`). **Relay is
      modelled**: `ip helper-address <addr>` on an interface (`engine/cli.js:2158` calls `_helperAddress()`, defined at `:11781`) makes a router
      forward a client's request with `giaddr` set to that port's address, and the server answers from
      a pool that covers the *relay port's* subnet, not its own (`engine/simulator.js:1152`,
      `_dhcpRelayFor()`); `show ip dhcp binding` on the server then grows a closing line naming each
      relayed lease — `N bindings arrived through a relay: <ip> via giaddr <giaddr>`
      (`engine/cli.js:11720`) — and `test/dhcp-relay.test.js` (36 assertions) keeps all of it
      honest. Still absent: **snooping** (a switch
      forwards DHCP as an ordinary broadcast, and `show ip dhcp snooping` says so rather than
      pretending — `engine/cli.js:11653-11662`), Option 82's circuit-id/remote-id (only `giaddr` is
      carried), and DHCPv6, which appears solely as the reason a router's M flag sends a host there.
- [x] **DNS** for name resolution — NXDOMAIN / NODATA / SERVFAIL reported as distinct answers
      (`engine/dns.js`, `test/dns.test.js`, `test/dns-wire.test.js`).
- [x] **VLANs / 802.1Q** access, trunk and native VLANs with per-VLAN MAC tables
      (`engine/vlan.js`, `test/vlan.test.js`).
- [x] **Spanning Tree (802.1D)** with Listening/Learning timing in the convergence schedule
      (`engine/stp.js`, `test/stp.test.js`). RSTP fast convergence is not modelled.
- [x] **OSPF** adjacency + SPF, hello/SPF hold accounted for (`engine/ospf.js`,
      `test/ospf.test.js`, `test/ospf-wire.test.js`). **RIP** is still absent.
- [x] **NAT** — all three types (each translated in the
      data path: a dynamic rule hands out a pool address and a PAT rule rewrites the port
      (`engine/nat.js`, `test/nat.test.js`). The three spellings are `NAT_TYPES` — an object of three
      constants, `{ STATIC: 'static', DYNAMIC: 'dynamic', PAT: 'pat' }`, at `engine/nat.js:37-41` — with the
      array `TYPES` at `:43`; there is no `NAT_TYPES` list to grep for. Static and PAT rules are configurable from the console —
      `ip nat inside source static <local> <global>` and `ip nat inside source list <acl> interface <if>
      overload` — and **pool-based dynamic rules are not**: `ip nat pool …` is refused with
      `% This model translates inside source addresses ("ip nat inside source …"), not "pool"`, so a dynamic
      rule still comes from the topology JSON. The console reads the result two ways:
      `show ip nat translations` (the entries the data path wrote) and `show ip nat statistics`
      (`rules 1 (pat 1)`, `translations`, `dynamic entries`, `hits`).

      Two orderings the page owes a copy-paster, both measured on `examples/lab2-router-two-subnets.json`
      on 2026-11-12. **The ACL has to exist first**: `ip nat inside source list 10 interface Gi0/0
      overload` on a router with no list 10 answers `% Access list 10 does not exist - the NAT list says
      which addresses are translated, so it has to be built first` and `% Configured lists: (none)`, so
      `access-list 10 permit 10.0.1.0 0.0.0.255` comes before the rule; the rule then installs
      (`NAT rule added on Router-d3: pat list 10 -> Gi0/0 (10.0.1.1) overload`) with a warning that it
      needs one interface inside and one outside or it will match nothing. **And the roles are set in
      interface context, not global config**: bare `ip nat inside` at `(config)#` is
      `% Incomplete command` naming the two `inside source …` forms, and `ip nat outside` is refused as
      `not "outside"` — but `interface Gi0/0` then `ip nat inside` answers
      `Interface Gi0/0 is NAT inside` plus `(no port is outside yet - translation waits for one)`, which
      is the second half of the warning being honest.
- [x] **ACLs** — extended ACLs in the data path (`engine/acl.js`, `test/acl.test.js`,
      `test/acl-data.test.js`). The `firewall` capability itself is still inert; ACLs are what
      actually filters.
- [ ] **Wireless** 802.11 association state machine. The RF medium, band ceiling and
      association rate are modelled at the physical layer (`engine/media.js`), but the
      capability named `wireless` still does nothing.

## UI / UX

- [ ] Multi-select, copy/paste, alignment snapping, undo/redo.
- [ ] Curve / orthogonal link routing and link labels (IP subnets on hover).
- [ ] Per-interface tooltips with live ARP/MAC tables.
- [ ] Saved/exported PNG snapshot of the topology.
- [ ] Multi-tab topologies and a topology picker.
- [ ] Theme light/dark toggle and accessibility polish.

## Platform

- [ ] Per-vendor **CLI translators** (Juniper `set`, Huawei, MikroTik) over the
      unified config model.
- [ ] Authentication + per-user topologies. There is no login in `server/index.js`; where
      access control exists it is a reverse proxy in front of it
      ([PUBLIC-ACCESS.md](PUBLIC-ACCESS.md)).
- [x] Persistent storage for topologies — **file per board**, `data/topologies/<id>.json`, written
      atomically on every edit with no database and no dependency (`server/index.js`; `PF_DATA`
      relocates it for tests, and boards land in its `topologies/` subdirectory). What is still
      missing is a database, per-user storage, and a deletion that sticks: every board is global to
      the server, and `DELETE` forgets a board in memory without removing its file, so it returns
      on the next restart ([ARCHITECTURE.md](ARCHITECTURE.md)). The browser's import/export is a
      separate path.

      Measured on a throwaway `PF_DATA`, because the two halves disagree in a way worth knowing:
      `POST /api/topologies` writes **no file** — a board that is created and never edited is gone
      after a restart (201, then `topologies/` empty, then `{"ids":["default"]}`) — while adding one
      device writes `<id>.json` immediately (`server/index.js:43`), and `DELETE` on that board answers `{"ok":true}`,
      leaves the file in place, and the same id is back in the list after the next boot — not merely listed,
but answering `200` again, because the file it was deleted from is still there. So "the
      board is saved" is true of an edit, not of a creation, and the deletion only ever unloads.
      The `topo-` prefix is not part of the filename: it is the **default id** minted when the POST body omits
      `id` (`server/index.js:325`, `'topo-' + Date.now().toString(36)`), so a board created as `b3` is `b3.json`
      while an unnamed one is `topo-<base36>.json`. Sanitising the id is what the path helper at `:43` does.

      Re-measured end to end on 2026-11-12 with two servers on one `PF_DATA`, every step as described: the
      `topologies/` directory does not exist after `POST /api/topologies` (it is created by the first
      edit, not by the server), `POST …/devices` writes `b692.json`, `DELETE` answers `{"ok":true}` and
      the file stays, `GET` immediately afterwards is `404 {"error":"topology not found"}` while
      `GET /api/topologies` lists only `["default"]`, and a **second** server on the same directory lists
      `["default","b692"]` and serves that board `200`. So the 404 is true of the process and false of the
      disk, which is the whole reason the next boot can undo the delete.
- [ ] A **pcap export** of the simulated frames (replay in Wireshark).
- [ ] Embeddable build (single-file `dist/`) and a hosted demo.

## Project

- [x] Device models — **1,661 models across 247 vendors**, one JSON file each
      ([docs/DEVICE_REGISTRY.md](DEVICE_REGISTRY.md)). A community device-pack format is still
      an open question; today a "pack" is a pull request.
- [x] Unit tests for the simulator's edge cases — **well over a hundred suites**
      (`ls test/*.test.js | wc -l` gives today's number; the count moves with every PR, so run it
      rather than trusting a figure here) covering loops, ARP, TTL, convergence, link state,
      running-config round-trip, OSPF adjacencies and the catalogue invariants (`npm test`).
- [x] CI — Forgejo Actions on **pull requests to `main` and pushes to `main`**, plus manual dispatch
      (`.forgejo/workflows/ci.yml`, [docs/CI.md](CI.md)). Not "every branch": a push to a feature branch
      runs nothing until it is a pull request, and the dispatch entry exists because merging through the
      API does not arrive as a push event.

## Contributing

Pick any checkbox. The engine is pure JavaScript with no dependencies; `npm test` runs every
suite through one runner (`scripts/run-tests.js`), and `node test/engine.test.js` runs just the
engine suite. Keep the capability model — new protocol logic goes in `engine/simulator.js`,
new hardware goes in `devices/*.json`.
