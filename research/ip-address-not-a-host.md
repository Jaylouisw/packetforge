# `Bad mask /24 for address 192.168.0.0` — the addresses a box will not let a port hold

**Question (one, narrow).** When `ip address` names an address that cannot be a host *under the mask it was
typed with* — the subnet's network address or its broadcast address — does a real device refuse the command,
and in exactly what words? And which prefix lengths, if any, are exempt?

**Verdict: known, and adopted.** The command is refused, and the sentence is `Bad mask /<prefix> for address
<address>`: the prefix length of the mask that was typed, and the address echoed exactly as typed. A `/31` is
the documented exception — both of its addresses are host addresses (RFC 3021) — and is accepted. A `/32` and
a `/0` are **not** decided here, because the evidence for them is one thread and no more; the model leaves
them as they were and this note says why.

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

## What the model does now

`_ipHostRefusal(ip, dotted)` in `engine/cli.js` runs on `ip address <address> <mask>`, after the mask's own
contiguity check and **before** the overlap check:

* prefixes 1–30 compute the subnet's network and broadcast address from the dotted mask the command will store,
  so `ip address 10.0.0.0 24` prints `/24` and not `/8`;
* an address equal to either returns `Bad mask /<bits> for address <address>` and returns before anything is
  stored, so `iface.ip`, `iface.mask` and the DHCP flag are untouched and `show running-config` never carries
  the refused line;
* prefixes 0, 31 and 32 are not examined, and a non-contiguous mask keeps its own message
  (`% Invalid mask: …`) because that check runs first.

`test/ip-address-not-a-host.test.js` — 23 checks: the exact line for the network and broadcast address, the
prefix in the line for a `/22`, the bare-prefix spelling (`10.0.0.0 24`), a `/30`'s two usable addresses, a
`/31`'s two usable addresses on two devices, the port's previous address surviving a refusal, `show ip
interface brief` and `show running-config` after a refusal, a subinterface refused like its parent, the mask
error still winning, and a `/32` left as it was.

## What is unresolved

* **A `/32` on a physical port.** One thread reports `ip add 192.168.1.1 255.255.255.255` taken on a loopback
  and `ip add 192.168.2.1 255.255.255.255` refused on a physical interface with
  `Bad mask /32 for address 192.168.2.1` —
  https://learningnetwork.cisco.com/s/question/0D53i00000KswrtCAB/subnet-mask-255255255255 — and the replies
  in it are opinion, not a second transcript. This model has no loopback interfaces, so the distinction cannot
  be reproduced faithfully even if the physical-port refusal is real; a `/32` stays accepted.
  **What would settle it:** two console pastes, `/32` on a routed port and on a loopback, on the same IOS.
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
