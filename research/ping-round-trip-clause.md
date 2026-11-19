# What a real IOS appends to `Success rate is ...`, and when it prints nothing

**Question (one, narrow).** When a Cisco-style box finishes a `ping`, what exactly follows the
`Success rate is N percent (n/m)` line - and under what condition is that tail omitted?

**Verdict: known, and adopted.** The line continues with
`, round-trip min/avg/max = <min>/<avg>/<max> ms` **if and only if at least one echo came back**. A ping that lost
every echo prints the rate and stops. PacketForge printed the rate and stopped in both cases, so the one number a
ping is asked for - how long the path took - was missing from the command whose whole output is about it.

## What PacketForge did

```
sw1#ping 10.0.0.2
Type escape sequence to abort.
Sending 4, 100-byte ICMP Echos to 10.0.0.2, timeout is 2 seconds:
!!!!
Success rate is 100 percent (4/4)
Reply from 10.0.0.2: bytes=100 time=0.103 ms
```

`engine/cli.js` `_pingReplyLines()` built the rate with `Math.round(ok / count * 100)` and never looked at
`sent.replies[i].rtt`, although the simulator has computed a real round-trip time for every reply since the latency
model landed (`_roundTripFor()`, `engine/simulator.js`): propagation in the medium, serialisation at every port, and
store-and-forward at every device, twice over.

## Evidence

| Source | Says |
| --- | --- |
| [Understand Ping and Traceroute Commands (Cisco, doc 12778)](http://cisco.com/c/en/us/support/docs/ios-nx-os-software/ios-software-releases-121-mainline/12778-ping-traceroute.html) | `Success rate is 100 percent (5/5), round-trip min/avg/max = 4/6/8 ms` for a good ping; `Success rate is 0 percent (0/5)` with **nothing after it** for every failure case in the page, including `encapsulation failed` and unanswered ARP |
| [Verify and Troubleshoot Basic NAT Connectivity (Cisco)](https://www.cisco.com/c/en/us/support/docs/ip/network-address-translation-nat/221481-8605-13.html) | Partial loss, the whole line: `Success rate is 80 percent (4/5), round-trip min/avg/max = 1/1/2 ms` |
| [ASR 1000 Software Configuration Guide, 17.1 (Cisco)](https://cisco.com/c/en/us/td/docs/routers/asr1000/configuration/guide/chassis/xe-17/asr1000-software-config-guide-17-1/mgmt-ether-asr.html) | The same 4/5 line from a different platform: `Success rate is 80 percent (4/5), round-trip min/avg/max = 1/1/1 ms` |
| [ASDM Book 2, ASA 9.2 (Cisco)](https://www.cisco.com/c/en/us/td/docs/security/asa/asa92/asdm72/firewall/asa-firewall-asdm/conns-trouble.html) | The pair in one place: `... 100 percent (5/5), round-trip min/avg/max = 1/1/1 ms` when it works, `Success rate is 0 percent (0/5)` when it does not |
| [IOS 12.1 ping/traceroute note](http://cisco.com/c/en/us/support/docs/ios-nx-os-software/ios-software-releases-121-mainline/12778-ping-traceroute.html) (same page, failure section) | `Q`/`U`/`.` marks with a zero rate still print the short form - the clause is about round trips, not about success |
| [Cisco Learning Network: outputs of ping command](https://learningnetwork.cisco.com/s/article/outputs-of-ping-command) | `U.U.U` / `Success rate is 0 percent (0/5)` - an ICMP unreachable is not a round trip |
| [edge-cloud.net: IPv6 link-local default gateway (live IOS transcript)](https://www.edge-cloud.net/2013/08/07/ipv6-link-local-addresses-as-default-gateway/) | `Success rate is 100 percent (5/5), round-trip min/avg/max = 0/0/0 ms` - **a real box prints zeroes** for a sub-millisecond round trip |

The two halves of the rule are therefore both vendor-attested, and the zero case is attested in both directions:
zero *loss* prints `0/0/0 ms`, zero *replies* prints no clause at all.

## What changed

* `engine/cli.js`: `roundTripClause(replies)` builds the tail from the replies that came back and returns the empty
  string when none did (or when no reply carried a modelled delay, which is a different "not measured"); `formatRttMs()`
  is now the one formatter for a round-trip figure, used by the reply lines and the clause.
* `test/ping-round-trip-clause.test.js`: 29 checks - the full line against the replies it summarises, the absent clause
  on total loss, 4/5 partial loss averaging only the four that returned, the precision rule, IPv6 parity, and a
  regression check that the rest of the report is byte-identical.
* `docs/CLI.md` and `docs/ARCHITECTURE.md`: every printed ping example now shows the clause it really prints.

## The deliberate divergence: units

A real box reports **whole milliseconds** and truncates: the 0/0/0 transcript above is a sub-millisecond path, and this
console's equivalent path measures 0.103 ms. This console prints three decimals below a millisecond and one above,
because the fractional rtt is the whole reason the latency model exists - a 1 m patch lead and a 40 km span differ at
the third decimal, and rounding both to `0/0/0` would erase exactly the distinction the model was built to show. So the
clause is the vendor's sentence with this console's figures - since `research/ping-report-shape.md` the per-echo line
that used to carry `time=0.103 ms` is gone, and the clause is the only place a run's figures appear, formatted by the
same `formatRttMs` a `traceroute` hop line uses. Printing `0/0/0 ms` there would be the vendor's spelling of the same
measurement, and the one thing an operator would report as a bug.

## Postscript: the per-echo lines this note measured against are gone

The example above shows the console as it stood when this rule was adopted, including the
`Reply from 10.0.0.2: bytes=100 time=0.103 ms` line. That line is not IOS output - it is Windows `ping`'s shape -
and a later run removed it, with the timeout lines beside it. The clause is unchanged and is now the report's last
line; `research/ping-report-shape.md` carries the evidence and `test/ping-report-shape.test.js` pins the shape.

## What remains unresolved

* **Truncate or round the average?** No transcript found prints a mean whose fractional part is visible, so the
  vendor's arithmetic for `avg` is not settled. The two rules differ only when the mean has a fractional part of .5 or
  more, which a whole-millisecond box reaches often (`1/2/4` has a mean of 2.33, so no help). This console averages the
  raw fractional rtt and then formats; a box that stores each reply as whole milliseconds would average the truncated
  values instead. That is a difference of at most one millisecond, and it is stated here rather than papered over.
* **Whether `avg` excludes the first reply after an ARP delay** on platforms where the first echo is delayed by
  address resolution. Cisco's own 4/5 transcripts show the lost echo as a `.`, not a slow `!`, so the model here -
  a lost echo simply is not in the set - is consistent with what is published.
* **Per-platform shape.** IOS-XR's `ping mpls` variants and NX-OS add a leading timestamp and, for MPLS, a
  `Total Time Elapsed` line. None of that is modelled and none of it is claimed.

## What evidence would settle the average rule

A vendor transcript (or a lab capture with a known per-echo delay spread) in which the individual round trips can be
reconstructed independently of the printed `min/avg/max` - a `ping` with `debug ip icmp` timestamps on both ends, or
two paths whose delays are known from the topology. Without that, the honest position is the one above: the clause is
the vendor's, the average is this console's.
