# What a real `traceroute` prints on a hop line: how many probes, and how each is timed

**Question (one, narrow).** When a Cisco-style box prints one hop of a `traceroute`, how many probe results does
that line carry, in what unit, and how is a probe that never came back marked?

**Verdict: known, and adopted.** A hop line is the address followed by **three** results, one per probe, each a
round-trip time in **`msec`**; a probe that timed out is printed as a single `*` in its own column. This console
printed one address per hop and **no figures at all**, so the command whose whole purpose is "how long does the path
take to each hop" reported none of it - while `ping`, over the same latency model, on the same wire, one command
earlier in the same ticket, printed the round trip.

## What PacketForge did

```
PC1#traceroute 10.0.3.9
Type escape sequence to abort.
Tracing the route to 10.0.3.9
 1  10.0.0.1
 2  10.0.0.2
 3  10.0.3.9  destination reached
```

One probe per TTL, one number-less line per hop, and two clauses the vendor does not print (`destination reached`,
`no reply`). `Simulator.traceroute()` said why in a comment: `_roundTripFor()` times an echo request/reply pair, and
"an ICMP error is a different kind of frame". That is true of the *pair* - it is not a reason for a hop to carry no
time, because the return leg of a time-exceeded hop is simply a different type on the same wire.

## Evidence

| Source | Says |
| --- | --- |
| [Understand Ping and Traceroute Commands (Cisco, doc 12778)](https://www.cisco.com/c/en/us/support/docs/ios-nx-os-software/ios-software-releases-121-mainline/12778-ping-traceroute.html) | `Router1#traceroute 172.16.34.4` → `1 172.16.12.2 4 msec 4 msec 4 msec`, `2 172.16.23.3 20 msec 16 msec 16 msec`, `3 172.16.34.4 16 msec * 16 msec`; the character table: `nn msec` = "the round-trip time in milliseconds for the specified number of probes", `*` = "the probe timed out" |
| [Use the Traceroute Command on Operating Systems (Cisco, doc 22826)](https://www.cisco.com/c/en/us/support/docs/ip/ip-routed-protocols/22826-traceroute.html) | the extended dialog asks `Probe count [3]`; the walk prints `4 10.1.4.2 4 msec * 0 msec` - a lost probe is one `*` among the three, not a missing column |
| [Catalyst 2960-X Configuration Guide 15.2(5)E (Cisco)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_5_e/configuration_guide/b_1525e_consolidated_2960x_cg/b_1525e_consolidated_2960x_cg_chapter_01000101.html) | `traceroute ip 192.0.2.10` → four hops, three times each, and the sentence: "the round-trip time in milliseconds for each of the three probes that are sent" |
| [Catalyst 9600 Configuration Guide 26.x (Cisco)](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/26-x/configuration_guide/int_hw/b_26x_int_and_hw_9600_cg/checking_port_status_and_connectivity.html) | the resolved-name form `Tracing the route to ABA.NYC.mil (26.0.0.73)`, then `1 DEBRIS.CISCO.COM (192.180.1.6) 1000 msec 8 msec 4 msec` - three results on every hop, including the destination |
| [HowToNetwork: the IOS generic troubleshooting toolkit](https://www.howtonetwork.org/tshoot/module-2/the-cisco-ios-generic-troubleshooting-toolkit-part-1/) | the unreachable spelling `R1-Tu0-Interface (200.1.1.1) !A * 0 msec`: the letter stands **in a probe's column**, not beside the address |

The three-probe count is not a detail of one platform: it is the extended command's own default (`Probe count [3]`)
and both configuration guides describe it in prose.

## What changed

* `engine/simulator.js`: `traceroute()` now sends `probes` (default 3) probes at every TTL, through a new
  `_traceProbe()`, and each hop carries `probes[]` with one entry per probe and its own `rttMs`. The hop's own
  `rttMs` is the first probe that answered. `_echoLegs()` takes `id === null` to mean "any id", which is what lets a
  time-exceeded leg be found: an ICMP error quotes the original **sequence** number but carries a **fresh id**
  (`_icmpErrorTo()` stamps one), so a match on id would find no leg and report no time.
* `engine/cli.js`: `_traceroute()` prints the address and one result per probe (`probeCells()`), in `msec`, using the
  same `formatRttMs()` the echo reply lines use; the invented words `destination reached` and `no reply` are gone.
  A hop with no address prints three stars; a destination-unreachable keeps its `!H  host unreachable` words.
* `test/traceroute-hop-line.test.js`: 27 checks. `test/icmp-errors-traceroute.test.js` updated (the three-probe x
  two-hop error count is now asserted as 6, not "at most 2"; the destination and silent-hop lines re-asserted).
* `docs/CLI.md`, `docs/SIMULATION.md`: the hop line, the unit, and the two non-claims below.

The figure on a hop is the same measurement `ping` reports for the same address - the test asserts that equality
for hop 1 and for the destination, which is the check that stops the two commands drifting apart.

## The deliberate divergence: three identical columns

A real box's three probes usually print three *different* numbers, because a real box has queueing, contention and
interrupt timing. This model has none of them, deliberately (`engine/latency.js`: "jitter - a number with no
distribution is a lie dressed as realism"). Three identical probes on an unchanged deterministic path really do
take the same time, so the three columns agree to the last digit and the test asserts that they agree. Adding a
spread would be inventing exactly the number the command exists to report.

## What remains unresolved

* **How three probes against an unreachable destination are spelled.** The letter stands in a probe column when one
  probe gets one error (`!A * 0 msec`). Whether a box prints `!H` once, `!H * *`, or three letters for three
  unreachable probes is not settled by any transcript found, so this console keeps one `!H  host unreachable` line
  and gains no probe columns. Guessing here would put more invented columns in the output than the change removed.
* **Which letter code 0 deserves.** `_forwardL3()` sends `ICMP_DEST_UNREACH` **code 0**, which RFC 792 defines as
  *network* unreachable (`!N`), while the CLI prints `!H` (*host* unreachable). The evidence needed is a capture of
  a router with no route in its table; the letter mapping is left as it was rather than changed on inference.
* **The first probe after a cold ARP.** Real traces often show the first probe several times slower than the second
  and third while address resolution runs. ARP is explicitly not modelled in the latency figures, so no such
  pattern appears here - the model is not wrong, it is narrower, and this is where that shows.
* **Names in the target.** A real trace resolves `traceroute ABA.NYC.mil` and prints `Tracing the route to ABA.NYC.mil
  (26.0.0.73)`. This console refuses a name (`% Invalid traceroute target`) although `ping` resolves one; the help
  index claims `address|name` for both. That is a separate question with its own evidence to gather.
* **Column width for two-digit hops.** No transcript found shows hop 10 beside hop 9, so whether the number is
  right-aligned is not settled; the columns here are single-space separated and were left as they were.

## What evidence would settle them

A console capture (or `debug ip icmp` with timestamps) of a `traceroute` to an address that provokes a
destination-unreachable, showing all three probe columns of that hop; the same for a two-digit hop number; and a
`traceroute <name>` transcript along with the `Translating ...` line that precedes it.
