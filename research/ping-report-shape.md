# What a `ping` prints after the marks: one rate, and no sentence per echo

**Question (one, narrow).** When a Cisco-style box has finished a `ping`, how is each echo *reported* - and does
the report end with a `Reply from <address>: bytes=<n> time=<t> ms` line for every echo that came back?

**Verdict: known, and the engine was wrong.** A box reports each echo as **one character of the marks line** and
closes the run with `Success rate is ... percent (n/m)` - the round trip rides on that line as
`, round-trip min/avg/max = a/b/c ms`, or the line stops at the rate when nothing came back. There is no per-echo
sentence, in either direction: no `Reply from ...` for an answer, no `Request timed out (seq N)` for a loss.
The `Reply from <address>: bytes=100 time<1ms TTL=126` shape is **Windows** `ping`'s, so this console was printing
one operating system's output on another operating system's prompt.

## What the vendor publishes

| Source | Says |
|---|---|
| [`ping` (privileged), Cisco IOS command reference](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/ping.htm) | The worked session is `Sending 5, 100-byte ICMP Echos to 192.168.7.27, timeout is 2 seconds:` / `!!!!!` / `Success rate is 100 percent, round-trip min/avg/max = 1/2/4 ms` and stops. The field table defines `!` as "Each exclamation point indicates receipt of a reply" and `.` as the timeout - the *character* is the report of a reply. No reply field, no per-echo row. |
| [Understand Ping and Traceroute Commands (Cisco, doc 12778)](https://www.cisco.com/c/en/us/support/docs/ios-nx-os-software/ios-software-releases-121-mainline/12778-ping-traceroute.html) | Every transcript on the page (six of them, different latencies and one 4/5 loss) is the same three parts: send line, marks, rate. The failure sections show `U.U.U` / `Success rate is 0 percent (0/5)` with nothing between. |
| [Troubleshooting the Cisco IOS Software, Catalyst IE2000 15.0(2)EB (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/cisco_ie2000/software/release/15_0_2_eb/configuration/guide/scg-ie2000/swtrbl.pdf) | `Switch# ping 172.20.52.3` / `Type escape sequence to abort.` / `Sending 5, 100-byte ICMP Echoes to 172.20.52.3, timeout is 2 seconds:` / `!!!!!` / `Success rate is 100 percent (5/5), round-trip min/avg/max = 1/2/4 ms` / `Switch#` - the prompt is the next thing printed. Table 47-2 then explains the characters. |
| [Troubleshooting the Software Configuration, Catalyst IE3500 26.1.1 (PDF)](http://www.cisco.com/c/en/us/td/docs/IIOT/switches/ie35xx/sw-config-guide/26-1-1/ie3500-262x-cg/troubleshooting_the_software_configuration.pdf) | The same session and the same character table, ten years later on a current image - the shape is not a 12.x artefact. |
| [Cisco Learning Network, "outputs of ping command" (article 000006413)](https://learningnetwork.cisco.com/s/article/outputs-of-ping-command) | Says it in words, and draws the line this note is about: "There are 4 types of ping outputs in a **host** (not in routers and switches) and they are 1. Reply from <destination ip> ... Request time out". Then: "output of ping on router and switch is entirely different from host. there are 3 types of output ... `!!!!!` / `Success rate is 100 percent (5/5)`, `.....` / `Success rate is 0 percent (0/5)`, `U.U.U` / `Success rate is 0 percent (0/5)`." |
| [Cisco Live BRKTRS-2811, "Overview of Packet Capturing Tools" (PDF)](https://www.ciscolive.com/c/dam/r/ciscolive/global-event/docs/2023/pdf/BRKTRS-2811.pdf) | The provenance of the line this console printed: Cisco's own deck switches between a host and the IOS boxes, and the host run is `C:\>ping 10.10.30.27 -n 5 -l 100` / `Pinging 10.10.30.27 with 100 bytes of data:` / `Reply from 10.10.30.27: bytes=100 time<1ms TTL=126` - **`bytes=100` because `-l 100`**, which is exactly the field and the value the console was printing. |
| [Microsoft Learn, `ping`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/ping) | Defines the Windows form on its own page: `C:\>ping example.microsoft.com` / `Reply from 192.168.239.132: bytes=32 time=101ms TTL=124`, one line per echo, with the `TTL=` field this console never had. |
| [routelearn.net, "Ping"](https://routelearn.net/network-fundamentals/troubleshooting/ping) | The comparison in one table: Reply - "Windows: `Reply from … time=2ms`" / "Cisco IOS: `!`"; Timeout - "`Request timed out.`" / "`.`". |
| [motadata, "Ping Command Guide"](https://www.motadata.com/blog/ping-command) | Secondary, and plain: "Ping output on Cisco IOS routers and switches swaps full reply lines for single characters." |

The point of the windows-vs-IOS rows is not that Windows is wrong; it is that the two are **different formats for
different CLIs**, and the console had mixed them - IOS's marks line *and* the rate *and* then Windows' reply lines,
which is a shape neither platform prints.

## What PacketForge did, measured in this worktree

One generic switch, two hosts, `ping 10.0.0.2 5` on `h1`:

```
Type escape sequence to abort.
Sending 5, 100-byte ICMP Echos to 10.0.0.2, timeout is 2 seconds:
!!!!!
Success rate is 100 percent (5/5), round-trip min/avg/max = 0.103/0.103/0.103 ms
Reply from 10.0.0.2: bytes=100 time=0.103 ms
Reply from 10.0.0.2: bytes=100 time=0.103 ms
Reply from 10.0.0.2: bytes=100 time=0.103 ms
Reply from 10.0.0.2: bytes=100 time=0.103 ms
Reply from 10.0.0.2: bytes=100 time=0.103 ms
```

and a ping that lost everything, `ping 10.0.0.99 2`:

```
Type escape sequence to abort.
Sending 2, 100-byte ICMP Echos to 10.0.0.99, timeout is 2 seconds:
..
Success rate is 0 percent (0/2)
Request timed out (seq 0)
Request timed out (seq 1)
% Echoes lost: 2 drops (no ARP reply from 10.0.0.99 x2)
```

The loop that built the reply lines lived in `_pingReplyLines()` (`engine/cli.js`), one branch per reply, and both
address families shared it - which is why an IPv6 ping printed the same Windows-shaped lines. Nothing in the code
called them a deliberate divergence, and no page in `docs/` said a box does this; four separate increments had grown
tests asserting them (`test/ping-default-count.test.js` counted five, `test/ping-unreachable-letter.test.js` counted
two, `test/ping-round-trip-clause.test.js` parsed `time=` out of them), so the shape had become load-bearing by
habit rather than by evidence.

## What changed

* `engine/cli.js` - `_pingReplyLines(out, count, replies)` is the marks line and the success rate, full stop. The
  per-reply loop is gone; the unused `shownTarget` parameter went with it, and both call sites (`ping` and `ping6`)
  were updated. The comment above the function now says why there is no per-echo sentence, with the Windows
  provenance, and points here.
* `test/ping-report-shape.test.js` (29 checks) - the regression test for the rule: a three-echo success is exactly
  four lines (hint, send line, marks, rate); a total loss is the same four plus the console's `%` explanation; a fabricated
  4/5 run renders `.!!!!` and `Success rate is 80 percent (4/5), round-trip min/avg/max = 1.4/1.9/3.2 ms` and
  nothing else; IPv6 is the same four lines; and no `ping` of any kind prints `bytes=`.
* The tests that had measured the old shape now measure the rule instead: `ping-default-count` (five marks, no reply
  lines), `ping-ipv6` (five dots on total loss, no per-echo sentence), `ping-own-address`, `ping-loss-reason`
  (the `% Echoes lost:` sentence still carries the reason, and still comes after the marks), `ping-unreachable-letter`,
  `dns-console`, `convergence-timing` (a late ping's millisecond figure is read off the rate line), and
  `ping-round-trip-clause` (the clause is compared against the engine's replies, since the report no longer prints
  them one by one).
* `docs/CLI.md` and `docs/ARCHITECTURE.md` - every ping example drops the reply lines, and the ping section states
  the shape and cites this note. `research/ping-round-trip-clause.md` and `research/ping-default-repeat-count.md`
  carry a postscript pointing here, because they were written against the old shape.

## What is known, inferred, unresolved

**Known.** The report of a run on IOS/IOS-XE is: `Type escape sequence to abort.`, the `Sending ...` line, one
character per echo, and the success-rate line with the round-trip clause when at least one echo came back. The
characters are the report - `!`, `.`, `U`, `Q`, `M`, `?`, `&` are all defined in Cisco's own tables - and there is no
per-echo sentence in any of the transcripts above. The `Reply from ...: bytes=<n> time=<t>` form is the Windows host
form, `bytes=` included, and Cisco's own material prints it from a `C:\>` prompt.

**Inferred.** That the same silence holds for a *loss the console knows a reason for*: the engine's `% Echoes lost:`
sentence is this console's own explanatory voice, not vendor output, and it is kept for that reason - it is not in
any of the captures, because a box does not explain. That a `U` reply gets no sentence either is attested by
doc 12778's `U.U.U` example (already recorded in `research/ping-unreachable-letter.md`).

**Unresolved.**

1. **Whether any IOS-family platform prints an ICMP-error sentence.** Some hosts print `Reply from <router>:
   destination host unreachable` - the Learning Network article lists it as a *host* output, and no IOS transcript in
   hand shows it as router output. If a router image turns out to print it for a `U`, that is a new sentence to add,
   not a reason to restore the per-echo success lines.
2. **NX-OS and IOS-XR.** Both were spot-checked through command references in earlier notes and show the marks form,
   but this note's census is IOS/IOS-XE. A per-echo success line has not been seen on any of them either.
3. **The lost `time=<hops>` fallback.** When a path carried no modelled delay, the old reply line said `time=2 hops`
   instead of inventing milliseconds. With no per-echo line there is nowhere for that to go, so a ping across such a
   path now reports the rate with no figure - the same "not measured" honesty as `counters: not measured`. Whether a
   console *should* say something there is an open question, and it would be a `%`-prefixed sentence of the console's
   own if it did, not a vendor line.

**What would settle (1).** One capture from a Catalyst image of `ping` to an address behind a router with no route,
showing either `U` alone or a `Reply from ...: Destination host unreachable.` sentence under it.
