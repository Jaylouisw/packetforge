# `Bad mask /24 for address 192.168.0.0` — the addresses a box will not let a port hold

**Question (one, narrow).** When `ip address` names an address that cannot be a host *under the mask it was
typed with* — the subnet's network address or its broadcast address — does a real device refuse the command,
and in exactly what words? And which prefix lengths, if any, are exempt?

**Verdict: known, and adopted.** The command is refused, and the sentence is `Bad mask /<prefix> for address
<address>`: the prefix length of the mask that was typed, and the address echoed exactly as typed. A `/31` is
the documented exception — both of its addresses are host addresses (RFC 3021) — and is accepted. A `/32` is
refused too, with the same sentence, and that half of the rule took a second look: the first note left it
undecided on one thread, four more sources agree with that thread, and the model now refuses it (see
*[The `/32`](#the-32-one-address-is-not-a-link)*). A `/0` is **not** decided here; the model leaves it as it
was and this note says why.

## The evidence

The same sentence, from four independent console transcripts, for both ends of a subnet:

| Typed | Printed | Source |
|---|---|---|
| `ip address 192.168.1.255 255.255.255.0` (broadcast of the /24) | `Bad mask /24 for address 192.168.1.255` | https://community.cisco.com/t5/switching/why-not-use-broadcast-subnet/td-p/2137545 |
| `ip addr 172.30.0.0 255.255.255.0` (network of the /24) | `Bad mask /24 for address 172.30.0.0` | https://community.cisco.com/t5/switching/bad-mask/td-p/1972424 |
| `ip address 192.168.0.0 255.255.255.0`, then `192.168.1.0`, then `192.168.2.0`, then `192.168.10.0` | four lines, `Bad mask /24 for address <what was typed>` | https://learningnetwork.cisco.com/s/question/0D53i00000KsxldCAB/ip-address |
| `ip address 192.168.4.0 255.255.255.0` on `interface vlan 603` | `Bad mask /24 for address 192.168.4.0` | https://community.cisco.com/t5/switching/bad-mask-24/m-p/2128552 |

Four things are established by those transcripts rather than inferred from them:

1. **The network address and the broadcast address get the same sentence.** Nothing distinguishes them in the
   output; both are simply not host addresses.
2. **The prefix length is the mask that was typed**, not the classful one — `/24` for a `/24` typed inside
   10/8 or 172.16/12.
3. **The address is echoed as typed**, not the subnet's network address. `192.168.1.255` prints `.255`.
4. **Nothing is applied.** The first thread's author goes on to configure a usable address in the same session,
   and the second and third show the box simply waiting at the same prompt.

The rule is stated plainly by Cisco's own teaching material and by a course page that names the command's
purpose: "A Cisco router will only allow a host address to be configured on a Layer 3 interface. (The only
exception is a /31 Subnet Mask ...)" — https://www.connecteddots.online/resources/cisco/bad-mask-for-address —
and by the RFC-level explanation in Cisco's IPv4 addressing guide, which subtracts exactly two addresses per
subnet because "the all 0's host address ... is the same as the network address" and the all-ones address is
the broadcast (https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_ipv4/configuration/15-s/ipv4-15-s-book/configuring_ipv4_addresses.html).

## The one disagreement: the leading `%`

Every transcript above prints the sentence **bare**, with no `%` marker. One page prints it marked — the page
whose title is `% Bad mask /xx for address X.X.X.X`, showing
`% Bad mask /30 for address 172.20.100.96` for `ip address 172.20.100.96 255.255.255.252`
(https://www.connecteddots.online/resources/cisco/bad-mask-for-address).

The model prints it bare, and that is a judgement rather than a fact:

* four raw pastes of `Bad mask …` carry no marker, one carries it;
* the sibling refusal from the same address parser is also bare in a raw paste —
  `Not a valid host address - 0.0.0.1` for `ip add 0.0.0.1 255.255.255.0`
  (https://community.cisco.com/t5/switching/what-is-the-lowest-prefix-possible-and-the-lowest-ip/td-p/1214384) —
  so a marker on one message and not the other would be this console's inconsistency, not the device's;
* a marker is easy for an author to add when tidying a transcript up, and the bare form is what a copy-paste
  preserves.

**What would settle it:** one screenshot, or a `show logging`-style capture, of the refusal on a current IOS.
If a box does print `% Bad mask`, the fix is one string in `_ipHostRefusal()` and one expectation in
`test/ip-address-not-a-host.test.js`.

## The exemption: a `/31`

RFC 3021 gives the two addresses of a 31-bit prefix to the two ends of a point-to-point link, and Cisco's
configuration guide says it in as many words — "the use of a 31-bit prefix ... allows the all-zeros and
all-ones IP addresses to be assigned as host addresses on point-to-point networks" — with
`ip address 192.168.100.4 255.255.255.254` as the worked example
(https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_ipv4/configuration/15-s/ipv4-15-s-book/configuring_ipv4_addresses.html).
A support document shows the all-zeros address of a `/31` taken directly —
`R1(config-if)#ip address 192.168.1.0 255.255.255.254` —
https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/13788-3.html

The same guide says classless addressing must be on first ("You must have classless IP addressing configured
... before you configure an IP address with a 31-bit prefix"), and adds that it "is enabled by default in many
versions of Cisco IOS". This model has no `ip classless` command and no classful mode to be in, so the
exemption is unconditional here; a device whose `ip classless` were off would refuse the same `/31`, and that
is not modelled because nothing in this model can turn it off.

## The `/32`: one address is not a link

A 32-bit mask leaves no host space at all — the address *is* the subnet — so it describes a link with one
endpoint. Cisco's own guide states both the rule and where the value belongs:

> A subnet mask of 255.255.255.255 (a /32 subnet) describes a subnet with only one IPv4 host address. These
> subnets cannot be used to assign address to network links because they always need more than one address per
> link. The use of /32 is strictly reserved for use on links that can have only one address. The example for
> Cisco routers is the loopback interface.

(https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/13788-3.html)

And a box refuses it on a port with the same sentence the network and broadcast addresses get — three
independent transcripts, on three different platforms:

| Platform | Typed | Printed | Source |
|---|---|---|---|
| GRE tunnel, IOS 12.x | `R1(config-if) address 10.0.0.1 255.255.255.255` | `Bad mask /32 for address 10.0.0.1` | https://community.cisco.com/t5/routing/tunnel-interface-32-host-mask/td-p/2134221 |
| 2811 ISR, 15.0(1)M10, serial | `ip add 123.123.123.123 255.255.255.255` | `Bad mask /32 for address 123.123.123.123` | https://www.reddit.com/r/ccna/comments/8ett29/assign_32_to_an_interface/ |
| 4331, IOS XE, routed port | `ip address 12.0.0.1 255.255.255.255` | `Bad mask /32 for address 12.0.0.1` | https://community.cisco.com/t5/routing-and-sd-wan/subnet-mask-255-255-255-255-by-dhcp/td-p/4091332 |

The accepted answer on the tunnel thread states the rule from the other side: "You cannot directly configure a
/32 address on tunnel (or other physical interface). You need to configure it on a loopback interface and
assign it as `ip unnumbered loop<>`." And the thread this note originally found alone has the split in one
paste — `Bad mask /32 for address 192.168.2.1` on the physical port, the same mask taken on a loopback
(https://learningnetwork.cisco.com/s/question/0D53i00000KswrtCAB/subnet-mask-255255255255).

So the earlier reading of that thread — "one thread, opinion in the replies, nothing to reproduce it with
because this model has no loopbacks" — was too cautious on the first half and right on the second. The refusal
is reproducible without loopbacks: it is what the model's ports do. What it could not reproduce is the
*vendor's exception*, and it still cannot, because no device in the catalogue declares an interface of type
`loopback`. The check is written against the interface's type rather than its name, so the exception is stated
where it belongs and a loopback interface, if one is ever built, keeps its `/32`.

**What remains open here:** whether a `/32` is refused on *every* IOS-generation port. All three transcripts
are of routed L3 ports (tunnel, serial, GigabitEthernet); none is of a switch SVI or a port-channel, and the
model treats all of its ports alike. One paste of `ip address x.x.x.x 255.255.255.255` on an SVI would settle
whether that is one rule or several.

## What the model does now

`_ipHostRefusal(iface, ip, dotted)` in `engine/cli.js` runs on `ip address <address> <mask>`, after the
mask's own contiguity check and **before** the overlap check:

* a prefix of 32 returns `Bad mask /32 for address <address>` unless the interface's type is `loopback`, which
  is the vendor's exception and a type no catalogue device declares;
* prefixes 1–30 compute the subnet's network and broadcast address from the dotted mask the command will store,
  so `ip address 10.0.0.0 24` prints `/24` and not `/8`;
* an address equal to either returns `Bad mask /<bits> for address <address>` and returns before anything is
  stored, so `iface.ip`, `iface.mask` and the DHCP flag are untouched and `show running-config` never carries
  the refused line;
* prefixes 0 and 31 are not examined, and a non-contiguous mask keeps its own message
  (`% Invalid mask: …`) because that check runs first.

`test/ip-address-not-a-host.test.js` — 27 checks: the exact line for the network and broadcast address, the
prefix in the line for a `/22`, the bare-prefix spelling (`10.0.0.0 24`), a `/30`'s two usable addresses, a
`/31`'s two usable addresses on two devices, the port's previous address surviving a refusal, `show ip
interface brief` and `show running-config` after a refusal, a subinterface refused like its parent, the mask
error still winning, and a `/32` refused on a port and on a subinterface with the held address and the
running-config untouched.

## What is unresolved

* **Whether a `/32` is refused on every kind of port.** Three transcripts cover a tunnel, a serial port and a
  routed GigabitEthernet, all L3; none covers an SVI or a port-channel, and this model refuses on all of them.
  **What would settle it:** a paste of `ip address x.x.x.x 255.255.255.255` on a switch SVI, and one on a
  port-channel.
* **The loopback exception, which this model cannot show.** A loopback takes the same `/32` that a port
  refuses, and no catalogue device declares one, so the exception is written against `iface.type` and has no
  device to demonstrate it. **What would settle it:** a catalogue device entry with a loopback interface, which
  is a feature, not a fidelity fix.
* **A `/0`.** The network address and the broadcast address are the same address, so the rule cannot say which
  it is, and nothing in hand shows what a box prints for `ip address 0.0.0.0 0.0.0.0`. Unchanged.
  **What would settle it:** one transcript of that command.
* **Which check runs first on a box.** `ip address 10.0.0.0 255.255.255.0` on a port while `10.0.0.1/24` sits
  on another port is both "not a host address" and "overlaps". This model answers the host-address question
  first, because the address is wrong on its own terms. Nothing in hand shows the order.
* **The old classful zero-subnet case.** On IOS 11.1 a 2520 answered `Bad mask /24 for address 10.0.0.1` for
  a perfectly ordinary host address, because `ip subnet-zero` was off and `10.0.0.0/24` was then the zero
  subnet of 10/8 (https://community.cisco.com/t5/switching/bad-mask-24-for-address-10-0-0-1/td-p/2341615).
  The sentence is therefore "this address is not a legal host under this mask **and this box's classful
  rules**", and the second half of that is not modelled at all: there is no `ip subnet-zero`, so no command
  here can produce the classful refusal. Worth remembering before anyone reads `Bad mask` as proof of a
  network or broadcast address on an old image.
* **The sibling family, `Not a valid host address - <address>`.** `ip add 0.0.0.1 255.255.255.0` and
  `ip add 0.0.0.2 …` are refused with that line, and `127.0.0.2 255.255.255.0` on a loopback with the same
  (https://community.cisco.com/t5/switching/what-is-the-lowest-prefix-possible-and-the-lowest-ip/td-p/1214384,
  https://learningnetwork.cisco.com/s/question/0D53i00000KsviSCAR/ping-127001-in-router-failed). Which ranges
  a box treats that way — 0/8 and 127/8 at least, and whether 224/4 and 255.255.255.255 join them — is a
  separate question, with its own message, and is **not** implemented here. This model still accepts
  `ip address 224.0.0.1 255.255.255.0` and `ip address 0.0.0.1 255.255.255.0`. That is the next question, not
  this one.
