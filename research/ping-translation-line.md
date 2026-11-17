# `ping <name>`: the lookup line, the server it names, and where it sits

**Question (one, narrow).** When an IOS-like box resolves a name for `ping`, what does the `Translating ...` line
actually say — which address appears in parentheses, when does `[OK]` appear, and where does the line sit relative
to `Type escape sequence to abort.`?

**Verdict: known, and adopted.** Three things in this console were not what a box prints, and the evidence for all
three is a vendor doc plus live console transcripts:

1. a device with **no `ip name-server`** printed `domain server (none)`. A box sends that lookup to the broadcast
   address and says so: `domain server (255.255.255.255)`.
2. the query line was printed **after** `Type escape sequence to abort.`. A box prints it first.
3. on success the console added a line a box never prints, `  name -> address`. The resolved address is already the
   target on the `Sending 5, 100-byte ICMP Echos to <address>` line.

The failure path was also printing the diagnostic without the lookup line; a box prints the query line (no `[OK]`)
and then the error.

## The vendor's own words

The broadcast address is documented, not inferred. Cisco's tech note on the translation messages:

> If no specific domain server has been configured on the router, the router issues a broadcast for the command to
> be translated into an IP address and the message "**Translating..... domain server (255.255.255.255)**" appears in
> the console.

* https://www.cisco.com/c/en/us/support/docs/routers/10000-series-routers/46253-ipdomain-lookup.html

Its own transcript, with an unrecognised command (user mode and enable mode, identical):

```
R1> xxxx
Translating "xxxx"...domain server (255.255.255.255)
% Unknown command or computer name, or unable to find computer address
```

So the parentheses hold the address the query was **sent to**, and a lookup that comes back with nothing carries no
`[OK]`. The same page's "verify" section shows the error with no lookup line at all — because `no ip domain lookup`
had been configured, i.e. no lookup was made. That is the distinction the console now keeps: query line printed
whenever a lookup happens, `[OK]` only when a name came back.

## Order, and `[OK]`, on a live box

A Catalyst 3750 transcript, pasted by the operator rather than written from documentation:

```
Switch#ping ip www.google.it source 192.168.0.1

Translating "www.google.it"...domain server (255.255.255.255) [OK]

Type escape sequence to abort.
Sending 5, 100-byte ICMP Echos to 209.85.135.106, timeout is 2 seconds:
Packet sent with a source address of 192.168.0.1
!!!!!
```

* https://community.cisco.com/t5/switching/problem-with-routing-catalyst-3750/td-p/1540438/page/2

Two facts are visible at once: the lookup precedes `Type escape sequence to abort.`, and there is **no**
`www.google.it -> 209.85.135.106` line anywhere in the output — the address appears as the target of the echo.

A second live failure, from a community thread about ping versus prompt:

```
Translating "www.google.com"...domain server (255.255.255.255)
% Unrecognized host or address, or protocol not running.
```

* https://community.cisco.com/t5/routing/now-that-i-have-my-1841-router-fully-online-through-double/td-p/3913550

No `[OK]`, and the query line is still there. That is the shape the console now prints.

A Cisco Learning Network thread on a broken IPv6 resolver shows the same two shapes and, incidentally, the
multi-server form: `Translating "ccc.ccc"...domain server (2000:0:0:2::3) (10.1.2.3) [OK]`, and a failure without
the `[OK]` after only one of them.

* https://learningnetwork.cisco.com/s/question/0D53i00000Kt7CaCAJ/dns-troubleshoot-2-ipv6

## What changed

`engine/cli.js`, `_ping()` and a new helper `_domainServersFor()`:

* the query line is built before `Type escape sequence to abort.` is pushed, for the IPv4 name path;
* the addresses in parentheses are the servers the query was sent to: the answering server when one is configured
  and answered, every configured name server otherwise, and `255.255.255.255` when the device has no
  `ip name-server` at all — because a box with no resolver configured broadcasts, and naming whoever chose to
  answer the broadcast would say the query was addressed to a host it was never addressed to;
* the `  name -> address` line is gone from the success path;
* the failure path prints the query line first, then the console's own diagnostic, and the advice now matches the
  address above it: with no name server configured it says so instead of telling the operator to "check the zone on
  255.255.255.255", which is advice about a host that cannot be one.

`test/dns-console.test.js` pins all of it (44 checks): ordering, absence of the invented line, the broadcast address
on both the success and the failure path, no `(none)` anywhere, and the advice sentence. `docs/CLI.md` examples are
updated to the output the console now prints.

## What is unresolved

* **Which servers a box lists when more than one is configured.** The learning-network transcript lists two
  (`(2000:0:0:2::3) (10.1.2.3)`) and appends `[OK]` after the last, which reads as "every server queried, in
  order". Whether a box stops printing at the server that answered is not shown by any transcript found here. The
  console prints the configured list in order when nothing answered, and only the answering address when something
  did — the one case the evidence settles. A packet capture of a two-server box would settle the rest.
* **The error sentence on the failure path.** A box says `% Unrecognized host or address, or protocol not running.`
  for `ping` (and `% Unknown command or computer name, or unable to find computer address` for an unrecognised
  exec command). This console prints its own sentence, `% Could not resolve "<name>": <RCODE> - <reason>`, which
  distinguishes NXDOMAIN from NODATA from SERVFAIL and names the fix. That is a documented design decision
  (`docs/CLI.md`), not an oversight, so this run did not replace it — it only put the real lookup line in front of
  it.
* **`traceroute` still takes no name.** `traceroute www.google.it` is refused as an invalid target, where a real box
  translates the name first exactly as `ping` does. Adding that would be new behaviour rather than fidelity, so it
  is left for its own increment.
