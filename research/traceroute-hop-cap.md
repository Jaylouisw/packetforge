# The `traceroute` hop cap: what the number is called, what it may be, and what the box prints at the end

**Question (one, narrow).** When a Cisco-style box is told to stop a `traceroute` at a given number of hops,
(a) what is the cap called on the command line, (b) what range does it accept, and (c) what, if anything, does the
box print after the last hop when the cap - not the destination - ended the walk?

Two facts made this the increment: `help` has advertised `traceroute|tracert <address|name> [max <n>]` since
#1484, and `docs/CLI.md` recorded in as many words that the hop limit was "indexed and not implemented" -
`_traceroute()` read `tokens[0]` and nothing else, so `traceroute 10.0.0.1 max 5` ran the default thirty-hop walk
and swallowed `max 5` without a word. `Simulator.traceroute()` has accepted `opts.maxHops` since the three-probe
work (and its tests exercise `maxHops: 1`, `2`, `3`, `5`); nothing on the console ever passed it.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco, *Understand the Extended Ping and Extended Traceroute Commands*, doc 13730](https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/13730-ext-ping-trace.html) | the interactive field table: `Maximum Time to Live [30]:` — "The largest TTL value that can be used. The default is 30. The **`traceroute`** command terminates when the destination is reached or when this value is reached." No closing line is described, and the worked capture ends at the last hop (`4 10.1.4.2 4 msec * 0 msec`). |
| [Cisco, *IP System Management Commands*, CBS 250/350 CLI reference (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/csbms/CBS_250_350/CLI/cbs-350-cli-/ip-system-management-commands.pdf) | an IOS-like inline grammar with a one-value cap: `traceroute ip {ipv4-address \| hostname} [size packet_size] [ttl max-ttl] [count packet_count] [timeout time_out]`; `ttl max-ttl` is `(Range: 1–255)`, default 30; "The **traceroute** command terminates when the destination responds, when the maximum TTL is exceeded, or when the user interrupts the trace with Esc." |
| [Cisco, *ASA Series Command Reference, T–Z*](https://cisco.com/c/en/us/td/docs/security/asa/asa-cli-reference/T-Z/asa-command-ref-T-Z/m_tl-tz.html) | the two-value form: `traceroute destination_ip \| hostname [...] [ttl min_ttl max_ttl] [...]`; `max-ttl` — "The largest TTL value that can be used. The default is 30. The command terminates when the traceroute packet reaches the destination or when the value is reached." |
| [Cisco, *Enterprise NFV Infrastructure Software Command Reference*, Networks and Bridges](https://www.cisco.com/c/en/us/td/docs/routers/nfvis/command/b-nfvis-command-ref/b-nfvis-command-ref_chapter_0101.html) | a Cisco reference whose keyword is exactly `max`: `traceroute {ip-address \| host-name} interface interface-name [source source-ip-address] [max max] [min min] [probes probes] [waittime waittime]`; "`max max` (Optional) Specifies the maximum time-to-live (TTL) used in the outgoing probe packets. The default value is 30." Its output shape is Linux's (`traceroute to 198.51.100.1 (198.51.100.1), 30 hops max, 60 byte packets`), not IOS's. |
| [Cisco, *ASR 5000 Exec Mode Commands (T–Z)* (PDF)](http://www.cisco.com/c/en/us/td/docs/wireless/asr_5000/21-20_6-14/Mode_E-F-CLI-Reference/21-20-cli-reference-e-f/21-17-CLI-Reference-E-F_chapter_010010.pdf) | the range in words: "`maxttl max_ttl` Specifies the maximum time to live for the route tracing packets as an integer from 1 through 255. ... Default: 30"; and the same "must be greater than `min_ttl`" rule for the two-value form. |

## Verdict

* **The cap exists on every IOS-family form, defaults to 30, and accepts 1–255.** Three independent references
  state the default; two state the range in as many words (CBS `(Range: 1–255)`, ASR "1 through 255").
* **The keyword is not one word.** The IOS-like inline grammars use `ttl` — one value on the CBS 250/350, a
  `<min> <max>` pair on the ASA — while a Cisco platform with a Linux-shaped traceroute uses `max` (NFVIS) and
  StarOS uses `maxttl`/`minttl`. Classic IOS has no inline spelling at all: its privileged `traceroute` is
  interactive and asks `Minimum Time to Live [1]:` / `Maximum Time to Live [30]:`.
* **Nothing is printed after the last hop.** Every reference describes the cap as *termination* and none
  documents a closing sentence; the captures in doc 13730 and the ASA/CBS pages end at the last hop row. This
  console's `% destination not reached after N hops` is its own summary of an unfinished walk, already documented
  for a trace a pulled cable stopped (`docs/CLI.md`, "A trace that stops where the cable did"), and it is printed
  for a capped trace too.

## What changed

* `engine/cli.js`, `_traceroute()`: parses `max <n>` after the target; refuses a missing value, a non-numeric or
  out-of-range value (`% Hop limit must be a whole number from 1 to 255 (asked for 300)`), a second `max` and any
  other word after the target (`% Unrecognized "5" (traceroute <address|name> [max <1-255>])`), and passes
  `{ maxHops: n }` to the walk it was already able to take. A refusal sends no probe.
* `engine/simulator.js`: `traceroute()`'s `maxHops` clamp was `64`, so a console that accepted `max 255` would have
  been cut at 64 - the accepted value and the used value would have been two different numbers. The clamp is now
  the vendors' 255.
* The unfinished-walk sentence is singular for one hop (`after 1 hop`), which `max 1` makes the ordinary case.
* `help` now reads `[max <1-255>]`; `docs/CLI.md` gains "The hop limit" and stops calling the row half-implemented.
* `test/traceroute-max-hops.test.js`: 34 assertions - the cap stops the walk and the probes (`6` at TTL 1-2, none
  at TTL 3), the summary counts the hops walked, `max 30`/`max 255` print exactly what the bare command prints, the
  `tracert` alias and `MAX` take the cap, a 255-hop routing loop really walks 255 hops, and eight malformed lines
  are refused with no probes sent.

## What remains unresolved

* **Which keyword an IOS-faithful console should offer.** `max` is kept because it is what this console's own index
  advertises and a real Cisco reference's keyword (NFVIS); `ttl <max-ttl>` (CBS) and `ttl <min> <max>` (ASA) are the
  IOS-like spellings and are *not* implemented. Adding a second grammar is a different question from completing
  this one.
* **The lower bound (`min`).** The ASA and StarOS forms also take a starting TTL, which suppresses known hops and
  makes the printed hop numbers start above 1. Whether a box numbers the first row `5` or `1` when it starts at TTL
  5 is not shown by any capture in hand, so the `min` half is not modelled.
* **A closing line after a capped, silent tail.** All references say the command terminates; none shows a capture
  whose cap was hit while the last hop was also silent. If a box prints anything there, this console does not.
* **`probe` and `timeout`.** The ASA/CBS grammars also take a probe count and a timeout; this console fixes the
  probe count at three (`research/traceroute-hop-line.md`) and has no timeout knob. Out of scope here.

## What evidence would settle them

A captured `traceroute ... ttl` (or `max`) run on IOS/IOS XE whose cap is reached, with the prompt line after the
last hop included, so the absence of a closing sentence is a transcript rather than an inference from its absence
in the documentation; and a run of the two-value form with `min 5` on a path longer than five hops, to see whether
hop numbers start at 5.
