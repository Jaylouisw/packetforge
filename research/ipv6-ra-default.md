# Before any config: does a Cisco router advertise IPv6 prefixes, or wait to be told?

**Question (one, narrow).** An IPv6-capable port has an address on it and nothing
else has been configured. Does the box put router advertisements on that link by
itself, or is advertising something an operator switches on - and what is the
command that owns the state, `ipv6 nd ra enable` or `ipv6 nd ra suppress`?

**Verdict: advertising is on by default, and there is no enable step.** Every
vendor document below states the default in the same terms, and the `show ipv6
interface` samples print an advertising interval on a port that had only been
given an address. PacketForge modelled the opposite: `config.ra` was `null` until
touched, `normalizeConfig(null).enabled` was `false`, `show ipv6 nd` answered
`Advertise : disabled  (ipv6 nd ra enable to start)`, and a host with `ipv6
address autoconfig` got nothing until somebody typed a command no Cisco box has.
The default is now on; `ipv6 nd ra disable` and `ipv6 nd suppress-ra` are the two
ways off, and only an explicit off is written to `show running-config`.
`test/ipv6-ra-default.test.js` pins all four faces of that rule.

## What the vendor documents say

| Source | Says |
| --- | --- |
| [Cisco IOS IPv6 Command Reference, `ipv6 nd ra suppress`](https://www.cisco.com/c/en/us/td/docs/ios/ipv6/command/reference/ipv6_book/ipv6_07.html) | **Command Default**: "IPv6 router advertisements are automatically sent on Ethernet and FDDI interfaces if IPv6 unicast routing is enabled on the interfaces. IPv6 router advertisements are not sent on other types of interfaces." The command "only suppresses periodic unsolicited RAs. It does not suppress RAs sent in response to a router solicitation." |
| [Catalyst 1200/1300 IPv6 Commands, `ipv6 nd ra suppress`](https://www.cisco.com/c/en/us/td/docs/switches/campus-lan-switches-access/Catalyst-1200-and-1300-Switches/cli/C1300-cli/ipv6-commands.pdf) | **Default Configuration**: "LAN interface - IPv6 router advertisements are automatically sent. Point-to-Point interface - IPv6 router advertisements are suppressed. NBMA interface - IPv6 router advertisements are suppressed." |
| [CBS 250/350 IPv6 Commands (same publisher, small-business line)](http://www.cisco.com/c/en/us/td/docs/switches/lan/csbms/CBS_250_350/CLI/cbs-350-cli-/ipv6-commands.pdf) | The same three-line default table - so the rule is not one platform's habit. |
| [IPv6 Addressing and Basic Connectivity Configuration Guide, IOS XE 3S - IPv6 Stateless Autoconfiguration](https://cisco.com/c/en/us/td/docs/ios-xml/ios/ipv6_basic/configuration/xe-3s/ip6b-xe-3s-book/ip6-statlss-auto-xe.html) | `show ipv6 interface gigabitethernet 0/0/0` on a port with two global addresses prints `ND router advertisements are sent every 200 seconds` / `ND router advertisements live for 1800 seconds`, with no RA command in the surrounding configuration. |
| [IPv6 Configuration Guide, IOS 15.2M&T - IPv6 Neighbor Discovery](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipv6/configuration/15-2mt/ip6-15-2mt-book/ip6-neighb-disc.html) | The same `show ipv6 interface` sample, `FastEthernet 1/0`, same two lines: "sent every 200 seconds", "live for 1800 seconds". |
| [RFC 4861 §6.2.1](https://www.rfc-editor.org/rfc/rfc4861) | A router configures itself to send unsolicited advertisements "on all interfaces on which it is configured to send Router Advertisements", and duplicate-address detection is the only reason to delay. There is no defined enable state in the protocol - only suppression. |

The one thing the documents split on is the *link type*: Ethernet/FDDI/LAN
advertise by default, point-to-point and NBMA do not until `no ipv6 nd ra
suppress` is given. PacketForge has no tunnel/NBMA interfaces, so the LAN half is
the whole of the modelled case.

## What PacketForge did, measured before the change

```
R1(config)# interface Gi0/0
R1(config-if)# ipv6 address 2001:db8::1/64
R1(config-if)# exit
R1# show ipv6 nd
  Advertise   : disabled  (ipv6 nd ra enable to start)
```

and the config printer wrote `ipv6 nd ra enable` for a device that had only
typed the enable, because `enabled` started `false` in `normalizeConfig`. Two
things followed from that: the lab needed a command no vendor console teaches
before SLAAC would work at all, and `ipv6 nd suppress-ra` - the command a real
config carries - described a suppression of something the box was not doing.

## What changed

* `engine/ra.js` - `normalizeConfig` reads `enabled: c.enabled !== false`, so a
  missing or old config means "advertising" rather than silence.
* `engine/simulator.js` - `_sendRa` refuses to build an advertisement on a port
  that carries no IPv6 address. `linkLocal6()` derives a link-local from any MAC,
  so without this an IPv4-only router would have advertised on every cable the
  moment the default flipped - measured as a spurious untagged frame on a
  router-on-a-stick lab (`test/acl-vlan-interface.test.js` caught it).
* `engine/cli.js` - `ipv6 nd ra enable` on an advertising box now answers that it
  is already the default (and `no ipv6 nd ra disable` is the form that restores
  it); `show ipv6 nd` prints `enabled  (the default; …)`; the config printer
  writes `ipv6 nd ra disable` only when advertising was actually turned off.
* `test/ipv6-ra-default.test.js` (19 checks) - a fresh router advertises, a host
  autoconfigures without any RA command, the report names the default, the off
  switch survives a save, an unaddressed port is silent, and `suppress-ra` still
  answers a solicitation.

Two suites changed a premise rather than a number: `test/ipv6-slaac.test.js`
asserted `normalizeConfig(null).enabled === false` and `test/config-completeness.test.js`
expected `ipv6 nd ra enable` in the printed config.

## What is unresolved

* **The interval.** The vendor prints "sent every 200 seconds" (MaxRtrAdvInterval,
  RFC 4861 default 600 s, Cisco default 200 s). This model sends one advertisement
  at the start of a run and never repeats it, so there is no interval to print and
  no `ipv6 nd ra interval` command. Whether a simulator should advance a periodic
  timer is a design question, not a wording one.
* **Prefixes are still declared, not derived.** A box puts a prefix option in the
  RA for each global address on the interface; PacketForge advertises only the
  prefixes typed with `ipv6 nd prefix`, and warns when one matches no interface.
  With advertising on by default, the remaining gap is visible: a router with an
  address and no `ipv6 nd prefix` now sends an RA that carries a default router
  and no prefix, so hosts learn a gateway but form no address. That is one
  question on its own (which prefixes a box puts in an RA, and what lifetimes it
  uses) and is not settled by the sources above.
* **`ipv6 nd ra suppress all`** - the keyword that also silences answers to
  solicitations. This console's `suppress-ra` models only the periodic half,
  which is the default (non-`all`) behaviour of the vendor command.
* **`ipv6 unicast-routing`** is not a command here: `l3-forward` stands in for it,
  so "advertising needs unicast routing" is a capability check rather than a
  config line an operator can read back.
