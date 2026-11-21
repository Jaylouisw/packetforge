# Does `ipv6 address` take a fe80::/10 address?

**Question (one, narrow).** On an IOS-like box, what happens when a link-local
address is typed into the **global** form of the command —
`ipv6 address fe80::1/64` (or `fe80::1`) — with no `link-local` keyword? And what
does the box answer when the keyword is present but the address is a global one
(`ipv6 address 2001::2 link-local`)?

Measured here because this console took the first form and stored `fe80::1/64` as
the interface's **global** address:

```
r1(config-if)# ipv6 address fe80::1/64
IPv6 address fe80::1/64 on Gi0/0            <- this console, before
r1# show ipv6 nd
  Prefixes    : 1   (1 from an interface address)
    fe80::/64   1  1  2592000  604800  interface address
```

The last two columns are the L and A flags of a prefix information option: the
router was telling every host on the wire to form a link-local address from
`fe80::/64`. No box does that, and RFC 4291 §2.5.6 is the reason.

**Verdict: the box refuses it.** The global form takes a global prefix; a
link-local belongs to `ipv6 address <addr> link-local`, and IOS answers the
mix-up in its own words, captured character for character:

```
R01(config-if)#ipv6 address FE80::1/64
% Link local requires link-local keyword
```

```
R01(config-if)#ipv6 address 2001::2 link-local
% Invalid link-local address
```

The engine now prints those two sentences and stores nothing. It has no manual
link-local state (the address is derived from the MAC, `Device.linkLocal6()`) and
does not add one: the `link-local` keyword form is answered with a line saying so
and naming the derived address, rather than silently treating a link-local as a
global address. `ra.addressPrefixes()` also drops a link-local prefix it is
handed, so a board saved before this change cannot put `fe80::/64` back on the
wire.

## Evidence

| Source | Says |
| --- | --- |
| [Fast Reroute, "Configure, Verify, and Troubleshoot IPv6 Addressing"](https://fastreroute.com/configure-verify-and-troubleshoot-ipv6-addressing/) | A live IOS session. `R01(config-if)#ipv6 address FE80::1/64` → `% Link local requires link-local keyword`, under the prose "IOS will also prevent typing in an address in the link-local prefix range without a link-local keyword." Then `R01(config-if)#ipv6 address 2001::2 link-local` → `% Invalid link-local address`, under "Addresses in any other than link-local range cannot be used with the keyword." The page's `show running-config interface Gi3` keeps `ipv6 address FE80::1 link-local` - the keyword form carries **no** prefix length. |
| [Cisco Community, "% Link local requires link-local keyword" (td-p/3038567)](https://community.cisco.com/t5/ipv6/link-local-requires-link-local-keyword/td-p/3038567) | A C887VAM-K9 on IOS 15.5(3)M5: `R887VAM(config-if)#ipv6 address link-local FE80::/10 eui-64` → `% Link local requires link-local keyword`. Same sentence, a different platform and release, from an operator who expected the documented grammar to work in that word order. |
| [Cisco Community, "SD-WAN: Configure link-local IPv6 address with Interface Templates?" (td-p/4678356)](https://community.cisco.com/t5/sd-wan-and-cloud-networking/sd-wan-configure-link-local-ipv6-address-with-interface/td-p/4678356) | A template push refused by the device: `ipv6 address fe80::1234/16` → `% Invalid input detected at '^' marker.`, with the component response quoting `% Link local requires link-local keyword`. Same rule at the other end of the range (`/16`, not `/64`), and the two renderings side by side - see "unresolved" below. |
| [Cisco IOS IPv6 Command Reference, `ipv6 address` and `ipv6 address link-local`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipv6/command/ipv6-cr-book/ipv6-i1.html) | The two commands are separate grammar: `ipv6 address {ipv6-prefix/prefix-length \| prefix-name sub-bits/prefix-length}` for the global form, and `ipv6 address ipv6-address/prefix-length link-local [cga]` for the manual link-local, whose `ipv6-address` "overrides the link-local address that is automatically generated for the interface". The Usage Guidelines state: "IPv6 link-local addresses must be configured and IPv6 processing must be enabled on an interface by using the ipv6 address link-local command." |
| [RFC 4291 §2.5.6](https://www.rfc-editor.org/rfc/rfc4291#section-2.5.6) | "Link-Local addresses have the following format: \| 10 bits \| 54 bits \| 64 bits \| \|1111111010\| 0 \| interface ID \|" - i.e. `fe80::/10` is link-local and not a global unicast prefix. |
| [PacketLife, "IPv6 Link-Local Addresses"](https://packetlife.net/blog/2011/apr/28/ipv6-link-local-addresses/) | The reverse rule, with a transcript: `ipv6 address fe90::1 link-local` and `ipv6 address febf::1 link-local` are taken (both inside `fe80::/10`), and `ipv6 address 2001:db8:0:12::1 link-local` → `% Invalid link-local address`. Also fixes the block's upper bound at `febf::`. |
| [Cisco Community, "Seeking clarification in IPv6 Link & Site local addresses please" (td-p/854688)](https://community.cisco.com/t5/switching/seeking-clarification-in-ipv6-link-site-local-addresses-please/td-p/854688) | The same sentence for the reverse rule on a switch: `Router(config-if)#ipv6 ADDress 2001:A::1 LInk-local` → `% Invalid link-local address`. |

## What is known

1. `fe80::/10` is link-local (RFC 4291 §2.5.6); the top of the block is
   `febf::`, so `fe7f::` is an ordinary global address and `febf::` is not.
   PacketLife's transcript shows `fe90::1` and `febf::1` accepted as link-local
   and a `2001:db8::` address refused as one, which pins both edges.
2. The global form refuses a link-local address, and the sentence is
   `% Link local requires link-local keyword` - two independent captures, two
   platforms (a CSR-style router on IOS 15.x, a C887VAM on 15.5(3)M5), plus the
   SD-WAN template push.
3. The keyword form refuses a non-link-local address with
   `% Invalid link-local address` - two independent captures (PacketLife's
   router, the Cisco Community switch thread).
4. The keyword form takes the address **without** a prefix length: PacketLife's
   `ipv6 address fe80::1 link-local` and Fast Reroute's running-config both show
   it, and Fast Reroute's prose says "For link-local addresses, no prefix-length
   needs to be specified, as it has a fixed format."
5. Only one link-local exists per interface; a second keyword form replaces the
   first (Fast Reroute shows `FE80::1` replaced by `FE80::2` in the config).

## What is inferred

* **The second line this console adds** (`This console derives the link-local
  from the port's MAC (Gi0/0 is fe80::...); it has no manual form.`) is not a
  vendor sentence. It exists because the box's first answer ("requires
  link-local keyword") points at a form this model cannot keep: it has no
  per-interface link-local state, and the address it does have is derived from
  the MAC. Refusing the keyword form without that line would send the operator
  round a loop; accepting it silently would be the defect this run removes.
* **`ra.addressPrefixes()` skipping `fe80::/10`** is the same rule stated once
  on the send side as `canAutoconfigure()` already states on the receive side
  ("a link-local prefix is never global"). It is not a capture; it is the
  RFC 4291 rule applied to the prefix list, and it only matters for a board
  saved before the door was closed.

## What remains unresolved

* **Which line the operator actually sees.** The SD-WAN page shows both a caret
  line (`% Invalid input detected at '^' marker.`) and the sentence; the other
  two captures show only the sentence. This run prints the sentence alone,
  because the caret's column depends on the parser's token boundaries and the
  captures that show it lost their spacing. A capture of the raw terminal, with
  the caret's column preserved, would settle whether both lines are printed and
  where the caret sits.
* **A prefix length after the keyword** (`ipv6 address fe80::1/64 link-local`).
  A Stack Exchange transcript of IOS 15.x shows a caret error for `/11`, `/10`
  and `/10`
  ([networkengineering.stackexchange.com/q/29997](https://networkengineering.stackexchange.com/questions/29997/why-is-cisco-enforcing-xxxxx-for-link-local-addresses-when-the-standard-say)),
  which is consistent with "no prefix length on a link-local" but does not
  preserve the caret's column. This console answers with its own "no manual
  link-local" line for that input; it does not claim the box's sentence.
* **A trailing word that is neither `link-local` nor part of the address**
  (`ipv6 address 2001:db8::1/64 bogus`) is still ignored by this console. The
  box's answer is a caret marker; the general trailing-word rule for config
  commands is a separate question from this one and is not changed here.
* **Whether a manual link-local should be modelled.** The catalogue has no
  per-interface link-local field; adding one touches `Device.linkLocal6()`,
  `ipv6Addrs()`, the ND source address, `show running-config` (which would have
  to print the keyword back) and the RA source address. That is a feature, not a
  fidelity fix to an existing command, and is deliberately out of scope.
* **Other vendors.** Juniper accepts a link-local in the ordinary address
  statement
  ([edge-cloud.net, "Using IPv6 link-local addresses as default gateway"](https://www.edge-cloud.net/2013/08/07/ipv6-link-local-addresses-as-default-gateway/)),
  so the rule implemented here is the IOS one. The console's grammar is IOS's,
  so that is the right rule for it; a vendor-agnostic simulator would have to
  branch on the platform, and this model does not.

## What changed

* `engine/cli.js` — `_ipv6Iface()` refuses a `fe80::/10` address in the global
  form with `% Link local requires link-local keyword` plus one console line
  naming the derived link-local; refuses `link-local` with a non-link-local
  address with `% Invalid link-local address`; answers the `link-local` keyword
  with the console's "no manual link-local" line. Nothing is stored in any of
  the three cases, so `show running-config`, `show interfaces` and
  `show ipv6 nd` cannot report an address that was never taken.
* `engine/ra.js` — `addressPrefixes()` skips a link-local address, so a
  pre-existing board cannot advertise `fe80::/64` as a SLAAC prefix.
* `test/ipv6-address-link-local.test.js` (41 checks): the sentence and the
  console line, the empty config, the report, the advertisement, both edges of
  `fe80::/10`, the keyword form both ways, the unchanged global form, the prefix
  list filter, and a host on the wire that forms no address.
* `docs/CLI.md` — the IPv6 section says which form takes which address.
