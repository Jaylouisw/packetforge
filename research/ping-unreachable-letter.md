# `ping`: the letter a probe that drew an unreachable gets

**Question (one, narrow).** When an echo is answered not with a reply but with an ICMP
*destination-unreachable*, what does an IOS-like box put in the marks line - and is the letter chosen per ICMP
code, the way `traceroute` chooses `!N`/`!H`/`!P`/`!U`/`!A`?

**Verdict: known, and this console could only spell the timeout.** A box prints `U`, for any destination-unreachable
code; `.` means the server timed out and nothing else. The engine had the answer all along - `_handleIcmp` records
every received ICMP error per `seq` in `this.icmpErrors` - but no caller read it back, so `ping` built its reply
from the echo-reply table alone. A probe a router had answered "no route" was reported exactly like a probe into a
dead cable: `..`, two `Request timed out` lines, and the same success rate. The reply now carries the error
(`unreachable`, `unreachableFrom`, `errorType`, `errorCode`) and the view prints `U`, in
`engine/simulator.js` (`ping()`) and `engine/cli.js` (`_pingReplyLines`), with
`test/ping-unreachable-letter.test.js` (18 checks).

## What PacketForge did before, and after

R1 has a static route to 192.0.2.0/24 via R2; R2 has no route to it, so R2 answers each echo with ICMP type 3
code 0. Before this change:

```
R1# ping 192.0.2.10 3
Type escape sequence to abort.
Sending 3, 100-byte ICMP Echos to 192.0.2.10, timeout is 2 seconds:
...
Success rate is 0 percent (0/3)
Request timed out (seq 0)
Request timed out (seq 1)
Request timed out (seq 2)
% Echoes lost: 3 drops ("no route to 192.0.2.10 (dropped by r2)" x3)
```

After:

```
R1# ping 192.0.2.10 3
Type escape sequence to abort.
Sending 3, 100-byte ICMP Echos to 192.0.2.10, timeout is 2 seconds:
UUU
Success rate is 0 percent (0/3)
% Echoes lost: 3 drops ("no route to 192.0.2.10 (dropped by r2)" x3)
```

The per-echo `Request timed out` line is gone for these probes, because a box prints no per-echo sentence for a
`U` at all (see the capture below) and a timeout line under a `U` mark is the block contradicting itself. The
`% Echoes lost:` sentence is this console's own explanatory voice and stays: it is what names the box that could
not route.

## Evidence

| Source | Says |
| --- | --- |
| [Understand Ping and Traceroute Commands, Cisco doc 12778, "Possible Output Characters From the Ping Facility"](https://www.cisco.com/c/en/us/support/docs/ios-nx-os-software/ios-software-releases-121-mainline/12778-ping-traceroute.html) (rev. 3.0, 2026-09-03) | The ping table: `!` "Each exclamation point indicates receipt of a reply." · `.` "Each period indicates the network server timed out as it waits for a reply." · `U` "**A destination unreachable error PDU was received.**" · `Q`, `M`, `?`, `&` for the rest. |
| Same page, "Troubleshoot Ping Failures" | The worked example: after R1 is given a route and R2 is not, `ping 172.16.34.4` prints `U.U.U` over `Success rate is 0 percent (0/5)`, and the `debug ip packet detail` beside it shows the frame R1 sent (type 8) and the one R2 returned: `rcvd 3` with `ICMP type=3, code=1` - **code 1, host unreachable, still a `U`**. |
| Same page, the traceroute table | The letters the console already implements for `traceroute`: `A` administratively prohibited, `U` port unreachable, `H` host unreachable, `N` network unreachable, `P` protocol unreachable. Two tables, on one page: `ping` says `U`, `traceroute` says which code. |
| [ping (privileged), Cisco IOS command reference (Table 67, "ping Test Characters")](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/ping.htm) | The same three characters with the same sentences, and the same `U` definition - so the letter is the command's, not one platform guide's. |
| [Consolidated Platform Configuration Guide, IOS 15.2(5)E, Catalyst 2960-L - Troubleshooting the Software Configuration (Table 5)](https://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960l/software/15-2_5_e/config-guide/b_1525e_consolidated_2960l_cg/b_1525e_consolidated_2960l_cg_chapter_01000100.html) | A current platform guide: `U` "A destination unreachable error PDU was received", plus "Ping returns one of these responses: … Destination unreachable—If the default gateway cannot reach the specified network, a destination-unreachable message is returned. Network or host unreachable—If there is no entry in the route table for the host or network, a network or host unreachable message is returned." |
| [Same guide, Catalyst 2960-X 15.2(5)E](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_5_e/configuration_guide/b_1525e_consolidated_2960x_cg/b_1525e_consolidated_2960x_cg_chapter_01000101.html) and [2960-XR 15.2(7)E](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15_2_7_e/configuration_guide/b_1527e_consolidated_2960xr_cg/m_sm_trbl_cg_c2k.html) | Both print the identical ping table and, below it, the per-code traceroute table - the contrast again. |
| [Cisco Learning Network, "outputs of ping command"](https://learningnetwork.cisco.com/s/article/outputs-of-ping-command) | Three outputs and when each appears: `!!!!!` when the ping succeeds, `.....` when it is unsuccessful, `U.U.U` "when ping to remote subnet from a router and neighbor router (next hop) don't have a route for that". |

## What is known

- `U` is the ping mark for a received destination-unreachable, and it is **not per code**: the vendor's own
  capture is a code-1 answer rendered `U.U.U`.
- `.` means the timeout expired, and only that. The two are different events and the vendor keeps two characters
  for them.
- Ping and traceroute spell the same ICMP error differently: `traceroute` prints `!H`/`!N`/`!P`/`!U`/`!A`,
  `ping` prints `U`. This console had already implemented the traceroute half (`unreachLetter`, from the same
  document) and had no ping half at all.
- Everything needed was already in the engine: `_handleIcmp` pushes `{dst, from, errorType, code, seq, step}` for
  every received type-3/type-11, and `_forwardL3` sends a type-3 code-0 when it cannot route. `ping()` simply
  never consulted it.

## What is inferred

- **One character per echo.** The marks line is one character per probe, so five unreachable probes are five
  characters. The vendor capture shows `U.U.U` for five probes: three `U`s and two dots, which cannot be "one
  character per probe" unless two of the five got no answer. The widely repeated explanation - ICMP
  unreachable messages rate-limited to one per 500 ms, so every second probe times out - is a blog-level claim
  (Ping Labz, "Cisco Extended Ping and Response Characters Explained"), and the capture's own debug timestamps
  are two seconds apart, which does not fit a 500 ms bucket. This engine is deterministic and has no unreachable
  rate limiter, so it prints `UUUUU`. That is a **rendering difference only**: the per-probe fact (an error came
  back, and it is a `U`) is the same one the vendor states.
- **No per-echo text line.** No capture in hand prints a sentence per `U`; the marks line is followed straight by
  the success rate, which is why the console prints nothing per unreachable probe.
- The engine's own `% Echoes lost:` sentence is this product's voice, not the vendor's, so it is kept - a lab
  needs to know *which* box refused, and a real box would have made the reader run `debug`.

## What is unresolved

1. **A box that cannot route the echo itself.** Cisco 12778's first failure case is exactly this - R1 has no route,
  `debug ip packet` shows five `unroutable` lines - but the marks line is swallowed by the interleaved debug
  output and only `Success rate is 0 percent (0/5)` survives in the capture. The table's wording ("a destination
  unreachable error PDU was **received**") suggests a locally failed lookup might print `.`, and the Learning
  Network note frames `U.U.U` as "the next hop has no route", i.e. a received error. So this console prints `.`
  there, and `test/ping-unreachable-letter.test.js` pins that choice so a future change has to be deliberate.
2. **ICMP time-exceeded in a ping.** The legacy chart gives `&` for "packet lifetime exceeded"; no modern capture
   in hand shows a ping whose echo expired in transit (a loop), so nothing is mapped and `.` is printed.
3. **Administratively-prohibited.** An ACL that answers with type 3 code 13 is "a destination unreachable error
   PDU" and should therefore be `U`; this engine's ACL path drops silently rather than answering, so there is no
   case to mark yet.

## What would settle it

- A clean capture (no `debug`, no `logging console`) of `ping` from a router with no route to the target. One
  screenshot of the marks line decides unresolved item 1.
- A capture with `ip icmp rate-limit unreachable 500` set and unset, pinging one unreachable destination: if the
  `U.U.U` alternation follows the rate limit, the inference above is right and the alternating form is a timing
  artefact to document rather than to reproduce.
