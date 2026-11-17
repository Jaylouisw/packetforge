# `traceroute <name>`: what a box prints before and on the target line

**Question (one, narrow).** When a Cisco-style box is given a *name* to trace rather than an address, what does it
print between the command and the first hop - and does the target line carry the name, the address, or both?

**Verdict: known, and adopted.** A name is resolved before the first probe goes out; the lookup is announced on a
`Translating "<name>"...domain server (<server>) [OK]` line **above** `Type escape sequence to abort.`; and the
target line carries **both** names, the typed name first and the resolved address in parentheses:

```
Router#traceroute google.com
Translating "google.com"...domain server (8.8.8.8) [OK]
Type escape sequence to abort.
Tracing the route to google.com (173.194.38.167)
1 59.90.253.1 16 msec 16 msec 12 msec
```

This console refused the name outright (`% Invalid traceroute target: srv.lab`), because `_traceroute()` put its one
argument through `net.isIp()`; `ping` beside it had resolved names since #1375, and the `help` index had claimed
`traceroute|tracert <address|name> [max <n>]` since the command landed. It now takes the name.

## What PacketForge did

```
h1#traceroute srv.lab
% Invalid traceroute target: srv.lab
```

There was no lookup line to get wrong: the resolver the product already has was never asked. `ping srv.lab` on the
same box printed the translation and five replies.

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 9600 Configuration Guide 26.x, Checking Port Status and Connectivity (Cisco)](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/26-x/configuration_guide/int_hw/b_26x_int_and_hw_9600_cg/checking_port_status_and_connectivity.html) | the resolved-name target line, from the vendor's own book: `Tracing the route to ABA.NYC.mil (26.0.0.73)`, then `1 DEBRIS.CISCO.COM (192.180.1.6) 1000 msec 8 msec 4 msec`. Name first, address in parentheses - and the hop line carries the hop's own resolved name the same way. (Cited from the same page in `research/traceroute-hop-line.md`; the extractor returns this page's first chapters only.) |
| [Cisco Community: "Issues with two WAN connection"](https://community.cisco.com/t5/routing/issues-with-two-wan-connection/td-p/1942285) | the full three-line paste, `Router#traceroute google.com` -> `Translating "google.com"...domain server (8.8.8.8) [OK]` -> `Type escape sequence to abort.` -> `Tracing the route to google.com (173.194.38.167)` -> `1 59.90.253.1 16 msec ...`. This source fixes the **order**: the lookup is announced before the abort line, with no intervening line. (The page answers HTTP 403 to the extractor; the transcript is the passage the search index returns for it.) |
| [Cisco Community: "Changing bandwidth on leased line router"](https://community.cisco.com/t5/routing/changing-bandwidth-on-leased-line-router/td-p/414811) | a second, independent paste of `Tracing the route to google.com (216.239.37.99)` - the same name-and-address shape from a different box and IOS generation. |
| [Cisco Community: "Enabling Traceroute in ASA"](https://community.cisco.com/t5/network-security/enabling-traceroute-in-asa/td-p/2362439) | `Tracing the route to www.google.com (173.194.117.50)`, then hops printed as `www.google.com (173.194.117.50) ...` - the form survives on a different platform (ASA), and shows that per-hop reverse names are a real part of a trace this lab cannot print (it holds no PTR records). |
| [Prevent Domain Translation Messages after an Invalid Command (Cisco, doc 46253)](https://www.cisco.com/c/en/us/support/docs/ios-nx-os-software/ios-software-releases-12-2-mainline/46253-dns-translation-msg.html) | already cited for `ping`: the `Translating "..."...domain server (...)` line, and the `[OK]` suffix that reports an answer. A lookup that fails prints the same line without `[OK]`. |

The name-and-address target line is the part with vendor-documentation backing. The *position* of the `Translating`
line relative to `Type escape sequence to abort.` rests on the community paste above, which is a weaker class of
evidence - a transcript, not a specification - but it is a full paste of one command's output and it agrees with how
`ping` orders the same two lines, which the vendor document does state.

## What changed

* `engine/cli.js`
  * `_traceroute()` now classifies its argument: an IPv4 literal (`isIpv4Literal()`, the same octet-range check `ping`
    uses, lifted to module scope so the two commands cannot answer "is this an address?" differently), a
    digits-and-dots typo (refused with `ping`'s parenthetical), or a name.
  * A name is resolved through `Simulator.resolveName()`; the lookup line is printed before
    `Type escape sequence to abort.`, with `[OK]` only when a name came back; the target line becomes
    `Tracing the route to <name> (<address>)`; the walk itself is the same call as for an address.
  * Two helpers extracted from `ping` so both commands share one rendering of one answer: `_translationLine()`
    (the lookup line) and `_resolveFailureLines()` (the NXDOMAIN/NODATA/SERVFAIL verdict and the advice beneath it).
    `ping`'s output is byte-identical, and its own tests still pass unchanged.
* `test/traceroute-name.test.js`, 23 assertions: the lookup line and the server address in it, `[OK]` only on
  success, the order of the three lines, the `name (address)` target line, the alias `tracert`, the typo and
  empty-target refusals, the IPv6 literal refused as an IPv4-only walk rather than sent to the resolver, and -
  the assertion that matters most - that every hop line, figure and verdict is
  **identical** to the trace the address form walks, so naming a host cannot change the path reported.
* `docs/CLI.md`: the command table row now reads `traceroute <address|name>`, a "Tracing a name" section carries the
  transcript and the two failure sentences, and the paragraph that said the index row was not real now says only the
  `max <n>` half is not real.

## What remains unresolved

* **The blank line.** A real box may print an empty line between `Translating ... [OK]` and
  `Type escape sequence to abort.` Some pastes show one; forum text routinely loses blank lines, and the one full
  paste above shows none. This console prints none, which is also what its `ping` does - consistency, not evidence.
* **The wording of a name that does not resolve.** Real IOS has its own sentence for this (a `%` line naming an
  unknown host or command); no transcript in hand shows which one a `traceroute` prints, as opposed to what exec mode
  prints for a bare word. This console prints **its own** resolver verdict (`% Could not resolve ...` and
  `% Nothing was sent. ...`), the same two sentences `ping` prints - a deliberate choice to share one rendering
  rather than invent a vendor string nobody here has seen.
* **Per-hop reverse names.** A real trace prints `4 auh-rb.ge-630.emix.net.ae (195.229.31.35)` when a PTR record
  exists. This lab holds no PTR records, so hop lines print addresses only; adding PTR would be a DNS model change,
  not a traceroute one.
* **`max <n>`.** Still indexed and still swallowed: `_traceroute()` reads `tokens[0]`, and `Simulator.traceroute()`'s
  `opts.maxHops` is never passed, so `traceroute 10.0.0.1 max 5` runs the default 30-hop walk. Whether a box that
  stops at the limit prints anything after its last hop is a separate question with its own evidence to gather.

## What evidence would settle them

A `traceroute <unresolvable-name>` transcript from a real box (one paste: does the abort line appear, and which `%`
sentence follows the failed lookup); a capture with its blank lines intact, to settle the spacing; and a
`traceroute <name> max 2` on a path longer than two hops, to see what a real box prints after its last hop.
