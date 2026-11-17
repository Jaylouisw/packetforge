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
  A hop with no address prints three stars; a probe refused with an ICMP destination-unreachable prints the letter
  for its code (see below).
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

## The refused hop: a letter in every probe column, for that ICMP code

**Question.** When a `traceroute` probe is refused with an ICMP destination-unreachable, what does a box print in
that probe's column - and with three probes sent at that TTL, once or three times? (This was left open above as
"how three probes against an unreachable destination are spelled" and "which letter code 0 deserves".)

**Verdict: known, and adopted.** The column carries a **letter for the ICMP code**, one per probe, with no words
beside the address; a router with no route answers code 0, and code 0 is `!N`.

| Source | Says |
| --- | --- |
| [Trace Route !N !N !N (Cisco community, td-p/3025719)](https://community.cisco.com/t5/network-security/trace-route-n-n-n/td-p/3025719) | a full IOS capture: `1 10.3.133.2 0 msec 0 msec 0 msec` … `4 172.30.36.131 !N !N !N`, answered in the thread as "`!N` means network unreachable", with the trace ending at that hop. Three probes at that TTL, three letters - and they sit in the columns the figures would have used |
| [ICMP, Ping, and Traceroute (xkln.net)](https://xkln.net/blog/icmp-ping-and-traceroute--what-i-wish-i-was-taught/) | an IOS transcript under the same rule for the host code: `4 10.4.5.2 !H !H !H`, "`R5` no longer has a path (route) to our final destination" |
| [CCNA lab notes, troubleshooting methodology (GitHub)](https://github.com/GARJE-01/cisco-ccna-lab-notes/blob/main/modules/13-Cisco-Troubleshooting-Methodology.md) | the mixed form, which fixes that the letter is **per probe** and not one mark per hop: `2 10.10.20.2 !H * !H` |
| [Understand Ping and Traceroute Commands (Cisco, doc 12778)](https://www.cisco.com/c/en/us/support/docs/ios-nx-os-software/ios-software-releases-121-mainline/12778-ping-traceroute.html) | the traceroute character table (`nn msec`, `*`, `A` administratively prohibited, `H` host unreachable, `N` network unreachable, `P` protocol unreachable, `U` port unreachable, `?` unknown packet type) and, on the same page, the ICMP type-3 code table: `0 = net unreachable, 1 = host unreachable, 2 = protocol unreachable, 3 = port unreachable` |
| [Use the Traceroute Command on Operating Systems (Cisco, doc 22826)](https://www.cisco.com/c/en/us/support/docs/ip/ip-routed-protocols/22826-traceroute.html) | the same letter list in one block (`N -- network unreachable`, `H -- host unreachable`, `? -- unknown (any other ICMP message)`), and the same type-3 code list |
| [Cisco Secure Firewall Threat Defense Command Reference, `traceroute`](https://www.cisco.com/c/en/us/td/docs/security/firepower/command_ref/b_Command_Reference_for_Firepower_Threat_Defense/tz.html) | the letters spelled with the mark: `!N` ICMP network unreachable, `!H` ICMP host unreachable, `!P`, `!A`, `?` unknown ICMP error |

Two things follow, and both are now in the engine rather than inferred by a reader:

1. **The letter is the code's.** `_forwardL3()` sends `ICMP_DEST_UNREACH` **code 0**, and RFC 792 / the Cisco type-3
   table both name code 0 *network* unreachable - so the mark is `!N`. The console printed `!H  host unreachable`,
   which was the wrong code's letter plus two words no box prints. Codes 1, 2 and 3 map to `!H`, `!P`, `!U`, and
   admin-prohibited (13) to `!A`; any code the table does not name keeps `?`, the table's own word, rather than a
   letter this note cannot attest.
2. **It is per probe.** Three probes at one TTL that all meet the same refusal print three letters; a probe that
   timed out among them is a `*` in its own column, which is the `!H * !H` form. The engine already sent three
   probes and already stored each probe's own `code`, so this needed no new measurement - only the printer.

```
  1  10.0.1.254  0.002 msec  0.002 msec  0.002 msec
  2  10.0.1.254  !N  !N  !N
```

`test/traceroute-hop-line.test.js` locks the shape (`!N  !N  !N`, three letters, no `msec`, no words) and the
mapping for all six cases; nothing here is asserted that the transcripts above do not show.

## The hop-number field: settled, and it was wrong here

This note used to leave the field width open - "no transcript found shows hop 10 beside hop 9, so whether the
number is right-aligned is not settled". Two captured IOS-XE traces settle it: the hop number is a fixed
**three-character field, right-aligned**, so a single digit carries two leading spaces and a two-digit hop one,
and the address begins in the same column on both.

| Source | The lines that settle it |
| --- | --- |
| [Tachashi/ansible_ios_traceroute_module, sample result](https://github.com/Tachashi/ansible_ios_traceroute_module) (raw `README.md`, JSON strings, so the spaces are the device's) | `"  1 192.168.173.43 186 msec 16 msec 13 msec 11 msec"` ... `" 10 108.224.66.161 62 msec"` ... `" 15 172.174.88.165 77 msec 60 msec 61 msec 63 msec"`; a second path in a multipath hop is a continuation line beginning `"    18.232.93.1 63 msec"` - four spaces, which is where the first line's address starts |
| [malgebary/Azure-Route-Server-MicroHack, README](https://github.com/malgebary/Azure-Route-Server-MicroHack) (raw `README.md`, lines 2377-2388) | `  1 10.1.1.4 [AS 65515] 3 msec 2 msec 3 msec` through ` 12 10.1.1.4 [AS 65515] 25 msec 30 msec 27 msec` - hops 1-9 carry two leading spaces, hops 10-12 carry one |

Both are code/JSON text rather than rendered HTML, so a page's whitespace collapsing cannot explain the pattern,
and the two captures agree on it independently. The second also shows the IOS-XE `[AS ...]` annotation between the
address and the first time; that is a separate, unmodelled detail.

**What changed.** `engine/cli.js` printed `' ' + hop.ttl + '  '` - a space and then the number - so hop 10 was one
character wider than hop 9 and pushed its address, and every probe column behind it, one character right: a trace
long enough to cross ten routers stopped lining up in the one view that is read down a column. The number now goes
through `hopNumberField()`, a three-character right-aligned field, which is exactly `'  1'` and `' 10'`.
`test/traceroute-hop-line.test.js` section 10 builds an eleven-router chain (with return routes, or the hops past
the first are silent) and asserts that hops 9, 10 and 11 put their addresses at the same column; the earlier
sections' expected lines were re-spaced to the new field, and `docs/CLI.md`'s transcripts likewise.

**What is deliberately unchanged.** The separator *after* the number, and the two spaces between the address and
the first time and between probe cells, stay as they were. Both captures print one space after the number and one
between probe cells, but a single-space shape is the one this console has locked since the hop-line work (the
`2 10.10.20.2 !H * !H` transcript in the evidence table above is single-spaced too), and re-spacing every column
is a second question with its own evidence trail. Only the field width was asked here.

## What remains unresolved

* **What follows the refused hop.** A real box ends the trace at the `!N` line and prints nothing after it; this
  console still adds its own `% destination not reached after N hops`. That sentence is this console's answer to a
  question a box leaves to the reader, and whether to keep it is a separate decision from the hop line.
* **The first probe after a cold ARP.** Real traces often show the first probe several times slower than the second
  and third while address resolution runs. ARP is explicitly not modelled in the latency figures, so no such
  pattern appears here - the model is not wrong, it is narrower, and this is where that shows.
* **Names in the target.** Settled since this note was written: `traceroute <name>` resolves through the lab's DNS
  and prints the lookup line and the `name (address)` target line a box prints -
  `research/traceroute-name-target.md` carries the transcripts and the rule.
* **Column width for two-digit hops.** Settled in November 2026 by two captured traces (see "The hop-number
  field" above): the number is a three-character right-aligned field, and the engine now prints it that way. What
  is still open is the separator *inside* the line - one space on the device, two here.

## What evidence would settle them

The two-digit hop capture is no longer outstanding - "The hop-number field" above carries two. Still outstanding: a
`traceroute <unresolvable-name>` transcript, to settle which `%` sentence a box prints when the lookup itself
fails - the successful name path is implemented, and `research/traceroute-name-target.md` records it.
