# Does a router advertise the /64 it holds as an interface address?

**Question (one, narrow).** On an IOS-like router with `ipv6 address 2001:db8:1::1/64`
and **no** `ipv6 nd prefix` line, does the router advertisement carry a prefix
information option for that /64 — and if so with which lifetimes and flags — or
does it only announce a default router? Measured here because a host on the wire
had a gateway and no address:

```
r1# show ipv6 nd                     (before)
  Prefixes    : none - hosts would learn a default router only
  Interfaces  : Gi0/0 (default router only)
h1# show ipv6 address                (after the exchange)
  (nothing: h1 is configured for autoconfig and heard no prefix)
```

**Verdict: yes, it is advertised by default.** Cisco's `ipv6 nd prefix` reference
states it in its Usage Guidelines and gives the parameters the box uses when
nothing was configured: valid lifetime 2,592,000 s (30 days), preferred 604,800 s
(7 days), on-link and autoconfiguration flags set. The engine built the
advertisement from its `ipv6 nd prefix` list alone, so this default was missing;
it is now derived from each interface address, and `show ipv6 nd` reports the
same list with a `source` column so the report cannot promise a prefix the wire
would omit.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco IOS IPv6 Command Reference, `ipv6 nd prefix`](https://www.cisco.com/c/en/us/td/docs/ios/ipv6/command/reference/ipv6_book/ipv6_07.html) | "By default, prefixes configured as addresses on an interface using the **ipv6 address** command are advertised in router advertisements." Also: "All prefixes configured on interfaces that originate IPv6 router advertisements are advertised with a valid lifetime of 2,592,000 seconds (30 days) and a preferred lifetime of 604,800 seconds (7 days)." And, further down: "If you configure prefixes for advertisement using the **ipv6 nd prefix** command, then only these prefixes are advertised." |
| [Cisco IOS XE IPv6 Command Reference, `ipv6 nd prefix` (PDF, p. 71)](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipv6/command/ipv6-cr-book/ipv6-i3.pdf) | The same Command Default and lifetimes. Usage Guidelines: "By default, prefixes configured as addresses on an interface using the **ipv6 address** command **and additional prefixes configured using the ipv6 nd prefix command** are advertised in router advertisements." The next sentence is the "only these prefixes are advertised" one. |
| [Cisco ASA 9.1, *Configuring IPv6 Neighbor Discovery* (PDF)](https://cisco.com/c/en/us/td/docs/security/asa/asa91/configuration/general/asa_91_general_config/route_ipv6_neighbor.pdf) | "By default, prefixes configured as addresses on an interface using the **ipv6 address** command are advertised in router advertisements." Default lifetimes restated as 2,592,000 / 604,800 s. |
| [Cisco CBS 250/350 IPv6 Commands, `ipv6 nd prefix` (PDF, p. 20)](http://www.cisco.com/c/en/us/td/docs/switches/lan/csbms/CBS_250_350/CLI/cbs-250-cli/ipv6-commands.pdf) | The clearest statement of the mechanism: "Advertise all prefixes that are configured as addresses on the interface using the parameters defined by the **ipv6 nd prefix default** command (or the default value if the command has not been configured) except prefixes that are placed in the Prefix table (changed … by the **ipv6 nd prefix** command). Advertise all prefixes configured by the **ipv6 nd prefix** command without the **no-advertise** keyword." |
| [RFC 4861 §4.6.2](https://www.rfc-editor.org/rfc/rfc4861#section-4.6.2) and [RFC 4862 §5.5.3](https://www.rfc-editor.org/rfc/rfc4862#section-5.5.3) | The prefix information option carries the prefix length, the L and A flags and the two lifetimes; a host forms a SLAAC address only from an A=1 prefix whose length is 64. |

## What is known

1. The default is to **advertise**: four vendor documents say so, across IOS,
   IOS XE, ASA and the small-business switch line, spanning more than a decade.
2. The parameters when nothing is configured are 2,592,000 s valid, 604,800 s
   preferred, L=1, A=1 — the same numbers this engine already uses for an
   explicit `ipv6 nd prefix` line (`engine/ra.js`, `DEFAULTS`).
3. A host needs **both** A=1 and a /64 to form an address (RFC 4862 §5.5.3), so
   the case that matters is exactly the /64 an interface usually holds.

## The one contradiction, and the reading adopted

Three of the pages above also print the sentence "If you configure prefixes for
advertisement using the `ipv6 nd prefix` command, then only these prefixes are
advertised", which, read literally, would withdraw **every** automatic prefix as
soon as one unrelated entry is configured. The Cisco IOS XE page contradicts
itself one sentence earlier ("…and additional prefixes configured using the
ipv6 nd prefix command are advertised"), and the CBS reference describes the
mechanism as a prefix table: automatic entries, plus configured entries, with a
configured entry changing its own prefix.

This run adopts the **additive with override** reading:

* an interface's /64 is advertised with the defaults;
* a configured `ipv6 nd prefix` entry for that same prefix replaces its
  parameters (lifetimes, flags) and only that prefix;
* a configured entry for another prefix is advertised in addition, still subject
  to the existing rule that a prefix only leaves a port that holds an address
  inside it.

Why not the literal "only these": on the literal reading, adding one prefix for
a different link would silently withdraw the on-link /64 that every host on the
first wire needs, which is the kind of quiet breakage this catalogue treats as a
defect. The sentence that supports the additive reading is on the same page as
the sentence that opposes it, so neither can be read as a precise algorithm; the
CBS page is the only one that describes the prefix table in steps.

## What changed

* `engine/ra.js` — `addressPrefixes(addresses)` derives a prefix information
  option from each `/64` interface address, with the vendor's default lifetimes
  and L=A=1; `mergePrefixes(automatic, explicit)` applies the override rule.
* `engine/simulator.js` — `_sendRa()` builds its prefix list from those two
  helpers instead of the configured list alone, so the option really goes on the
  wire and the host's existing SLAAC path forms the address.
* `engine/cli.js` — `_showIpv6Nd()` prints the same merged list, adds a `source`
  column (`interface address` / `configured`) and a count of how many rows came
  from an address, and uses the merged list for the per-interface mapping.
* `test/ipv6-ra-advertises-interface-prefix.test.js` (31 checks): the default
  announcement, the encoded option (prefix, /64, L, A, both lifetimes), the
  host's address and lifetimes, the report and its provenance, the override, the
  additive case, withdrawal, a router with no IPv6 address, a /48 (not
  advertised, so no address forms) and a host's own report.
* `docs/CLI.md` — the IPv6 section states the default and the override rule, and
  the worked example no longer needs an `ipv6 nd prefix` line.

## What remains unresolved

* **The exact IOS behaviour when an explicit prefix for an unrelated link is
  configured on the same interface.** The additive reading is adopted on the
  strength of the CBS reference and the IOS XE sentence; a capture of
  `show ipv6 interface <port>` (which lists ND advertised prefixes) on a box
  with `ipv6 address 2001:db8:1::1/64` plus `ipv6 nd prefix 2001:db8:9::/64`
  would settle it.
* **Suppressing an automatic prefix.** A real box does it with
  `ipv6 nd prefix <prefix>/<len> no-advertise`; this console's prefix grammar has
  no `no-advertise` keyword, so the automatic /64 cannot be withdrawn while the
  address stays. Adding the keyword is a new command form, not a fidelity fix to
  an existing one.
* **Non-/64 interface prefixes.** Cisco's text says "all prefixes configured as
  addresses … are advertised", and also that all of them get the A bit — but
  RFC 4861 §4.6.2 requires A=0 when the prefix length is not 64. This run
  advertises /64 only, because that is the only length a host can use; whether a
  box advertises a /48 with A=1 (violating the RFC) or A=0 was not captured, and
  nothing in this model depends on the answer yet.
* **Per-interface configuration.** This console stores `ipv6 nd prefix` once per
  device and filters by address containment; a real box stores it per interface.
  That limitation predates this run and is unchanged - it is why the "additive"
  case can only add a prefix that contains an address on the port in question.
* **`show ipv6 nd` is this console's own report**, not a vendor view: IOS's
  closest commands are `show ipv6 interface` and `show ipv6 routers`. The
  `source` column is therefore the console's, not a column any box prints.
