# A mask that is not a run of ones: `Bad mask 0XFF00FF00 for address 10.9.9.9`

**Question (one, narrow).** When a dotted mask typed after `ip address` is a legal IPv4 quad but not a run of
ones - `255.0.255.0`, `255.255.5.0`, `0.255.255.255` - what sentence does a real IOS-like box print, does the
line carry the `%` marker, and how is the mask spelled in it?

**Verdict: known in shape, and it was this console's own invention before.** A box refuses the mask with one
unmarked line that quotes the mask as a hex word and echoes the address that was typed:

```
R1(config-if)# ip address 192.168.1.254 255.255.5.0
Bad mask 0xFFFF0500 for address 192.168.1.254
```

This console answered `% Invalid mask: 255.0.255.0 - a netmask is a run of ones then zeros (255.255.255.0, or
24)` - a sentence no box prints, with a leading marker its neighbours do not carry, the mask in the decimal
spelling the box does not use here, and an explanation the box does not offer. The port door now answers in the
vendor's words. The hex word's **width** is the one detail still open, and it is an inference from the vendor's
own hex netmask format (below).

## What is known

One page prints the whole exchange verbatim, under the heading "Bad subnet mask", and follows it with the rule
in words ("A subnet mask is always a sequence of bit 1s followed by a sequence of bit 0s. A subnet mask in which
bits 1 and 0 appear alternately is an invalid subnet mask"):

> ```
> R1(config-if)# ip address 192.168.1.254 255.255.5.0
> Bad mask 0xFFFF0500 for address 192.168.1.254
> ```

* N-Study, "Cisco IP address Configuration and Verification Commands" -
  https://www.n-study.com/en/ip-addressing/cisco-ipaddress-configuration/

Three things that block establishes: the refusal is **one line**; it carries **no `%`** (the same page's overlap
refusal, printed two sections above it, does: `% 192.168.1.0 overlaps with FastEthernet0/0`); and the mask is
spelled in **hex**, with the typed address echoed after `for address`.

The mask is hex because that is how a box writes a netmask when it writes it in hex at all - "Network masks are
displayed in hexadecimal format, as indicated by the leading 0X (for example, 0XFFFFFF00)":

* Cisco IOS IP Addressing Services Command Reference, `ip netmask-format` -
  https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-i4.html
* IP Addressing: IPv4 Addressing Configuration Guide, "Specifying the Format of Network Masks" -
  https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_ipv4/configuration/xe-16/ipv4-ipv4-book/configuring_ipv4_addresses.html
  (the same paragraph appears in the 12.x, 15.0M, XE 16.x and XE 17.x editions)

A second, weaker witness is a forum thread whose *title* is the message family itself - "Bad mask 0XFFFFF" -
opened by a user asking why `255.0.0.0` works on an interface and `0.255.255.255` or `0.0.0.255` do not, on a
freshly booted router. The screenshot of the session is an image, not text, so the exact line cannot be read:

* Cisco Community, "Solved: Bad mask 0XFFFFF" - https://community.cisco.com/t5/routing/bad-mask-0xfffff/td-p/4564490

What that thread does establish is that the hex form is what a *user* sees for a mask whose first byte is zero -
the case the width question is about.

The family is familiar enough that Packet Tracer's own FAQ calls the message by name ("it says that the subnet
mask is a 'Bad mask'"), which is consistent with one sentence serving every non-contiguous mask:

* Packet Tracer FAQ / troubleshooting guide, item 7 -
  https://cisco-packet-tracer-help.yue.zone/default/faqTroubleShoot.htm

That the line carries no marker is also what the *sibling* refusal does: `Bad mask /24 for address
192.168.1.255` is printed unmarked in four independent pastes (research/ip-address-not-a-host.md). A marker on
one half of the `Bad mask` family and not the other would be this console's invention.

## What was wrong here, measured

One session on a `generic-router`, before the change:

```
Router(config)#interface GigabitEthernet0/0
Router(config-if)#ip address 10.0.0.1 255.0.255.0
% Invalid mask: 255.0.255.0 - a netmask is a run of ones then zeros (255.255.255.0, or 24)
```

and after it:

```
Router(config-if)#ip address 10.0.0.1 255.0.255.0
Bad mask 0XFF00FF00 for address 10.0.0.1
Router(config-if)#ip address 10.0.0.1 255.255.5.0
Bad mask 0XFFFF0500 for address 10.0.0.1
Router(config-if)#ip address 10.0.0.1 0.255.255.255
Bad mask 0X00FFFFFF for address 10.0.0.1
```

Nothing is applied in either case, which was already true: the port keeps the address and mask it held, and
`show running-config` never carries the refused line.

## What is inferred

* **Uppercase `0X`, uppercase digits.** The transcript prints `0x`, the forum title and the vendor's hex
  netmask documentation print `0X`. The vendor documentation is the only authority on how a box spells a
  netmask in hex, and it gives `0XFFFFFF00`; the transcript's lowercase is a re-typed page, not a paste. The
  model follows the documented spelling.
* **Eight hex digits, zero-padded.** `0XFFFFFF00` in that documentation is a full 32-bit word with no digits
  dropped, and a netmask is read as four bytes, so a mask whose first byte is zero keeps its leading zeros:
  `0.255.255.255` -> `0X00FFFFFF`. This is the weakest joint in the rule: the forum *title* prints something
  like `0XFFFFF`/`0XFFFFFF` for the same kind of mask, where an unpadded `%x` would be six digits. It is a
  title typed by hand, not a screenshot that can be read, so it is recorded here rather than adopted - but a
  single paste of `ip address 3.3.3.1 0.0.0.255` settles it either way.
* **The address is the one that was typed**, not a normalised form, and no prefix length is printed - the mask
  has no prefix length, which is the whole reason the box writes it as a word.

## What is unresolved

* **The width of the hex word** (padding), as above, and the case of the `X` on a live IOS XE image. Both are
  cosmetic, both live in one helper (`badMaskLine`), and both are one capture away from being settled.
* **What a box prints for a mask that is not a dotted quad at all** - `ip address 10.0.0.1 garbage`, or a
  prefix length out of range like `33`. The box's line quotes a mask word that does not exist, so nothing in
  hand says whether it is `Bad mask 0X...` (of what?), `% Invalid input detected at '^' marker.`, or something
  else. This console keeps its own `% Invalid mask: ...` sentence for those, which is the honest answer while
  the evidence is absent.
* **What the routing door prints for the same mask.** `ip route 192.0.2.0 255.0.255.0 10.1.1.9` is refused
  here with this console's sentence, because the only transcript in hand is an `ip address` line typed at an
  interface prompt. A static route's refusal for a non-contiguous mask is not witnessed by anything, so the two
  doors deliberately differ; one paste of the `ip route` line would tell.
* **Whether the sentence survives on IOS XE unchanged.** Every witness above is IOS 12.x/15.x-shaped; no XE
  paste was found.

## What would settle it

An unedited terminal paste (or a screenshot that can be read) of `ip address` with a mask whose first byte is
zero - `0.0.0.255`, `0.255.255.255` - on any IOS or IOS XE image, showing the exact line; the same for a junk
mask and for `ip route` with a non-contiguous mask. Without one, the padding and the routing door's sentence
stay as recorded here.
