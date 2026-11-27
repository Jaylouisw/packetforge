# A DHCP pool that names no mask: which subnet does the box serve?

**Question (one, narrow).** In `ip dhcp pool` configuration, `network <address>` may be written with no mask
or prefix length. Which mask does a real IOS-like box then apply - a fixed /24, or the mask implied by the
address's class - and therefore how large is the pool an operator has just created?

**Verdict: known, and adopted.** The vendor's command default is the *natural* mask of the address's class:
"Command Default: The natural mask is used", and in the same entry's usage guidelines, "If the mask or prefix
length is not specified, the class A, B, or C natural mask is used." PacketForge answered every bare `network`
with `255.255.255.0`. That is the natural mask only for a class C address, so two of the three classes were
wrong, and wrong in the direction that hides itself: `show ip dhcp pool` printed a coherent /24 table for a
pool a real box would have built as a /8 or a /16, and nothing in the console said the subnet had been
narrowed. `engine/dhcp.js` now derives the mask from the address (`naturalMaskFor`) and one normaliser feeds
every reader - allocation, capacity, the pool view and the validator. `test/dhcp-natural-mask.test.js` pins
the three classes at the console and `test/dhcp.test.js` pins the normaliser.

## What the vendor documents say

| Source | Says |
| --- | --- |
| [Cisco IOS IP Addressing Services Command Reference, IOS XE 3SE, `network` (DHCP)](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-xe-3se-3850-cr-book/ipaddr-xe-3se-3850-cr-book_chapter_00.html) | **Command Default**: "The natural mask is used." **Usage Guidelines**: "If the mask and prefix length are unspecified, DHCP examines its address pools. If no mask is found in the pool database, the Class A, B, or C natural mask is used." |
| [Same entry as PDF](https://www.cisco.com/c/en/us/td/docs/ios/ipaddr/command/reference/ipaddr-xe-3se-3850-cr-book/ipaddr-xe-3se-3850-cr-book_chapter_00.pdf) | Identical sentences, so the HTML is not a rendering artefact. |
| [IP Addressing: DHCP Configuration Guide, IOS 12.4](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_dhcp/configuration/12-4/dhcp-12-4-book/config-dhcp-server.pdf) | The same command in the task table with the same note: "If the subnet mask is not specified, a natural mask is assumed depending on the IP address." |
| [IP Addressing: DHCP Configuration Guide, IOS 15S](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_dhcp/configuration/15-s/dhcp-15-s-book/config-dhcp-server.html) | Step 4's worked example is written with no mask at all (`network 10.0.20.0`), which is the shape that triggers the rule. |
| [DHCP Commands reference (vendor book, `network (DHCP)`)](https://www.scribd.com/document/101612122/Dhcp-Config-Commands) | "If the mask or prefix length is not specified, the class A, B, or C natural mask is used", and, for the lease database's static entries, "If no mask is found in the pool database, the Class A, B, or C natural mask is used." |
| [HPE 5930 `network` (DHCP pool), same grammar borrowed from IOS](https://support.hpe.com/techhub/eginfolib/networking/docs/switches/5930/5200-4580_l3-ip-svcs_cr/content/490757478.htm) | "If no mask length or mask is specified, the natural mask will be used." Another publisher, same rule, so it is not one platform's quirk. |

The class table the rule needs is the ordinary one: 0-127 class A (/8), 128-191 class B (/16), 192-223 class C
(/24). The rule is stated in terms of the address class rather than the first octet, but the two agree on every
unicast range.

## What PacketForge did, measured before the change

```
r1(config)# ip dhcp pool P3
r1(dhcp-config)# network 172.16.4.9
r1(dhcp-config)# exit
r1(config)# end
r1# show ip dhcp pool
Pool P3 :
 Total addresses                : 254
 Current index        IP address range                     Leased/Excluded/Total
 172.16.4.1           172.16.4.1 - 172.16.4.254            0 / 0 / 254
```

A /16 was asked for and a /24 was built: 65,534 usable addresses became 254, and the first address offered
was 172.16.4.1 where the box would have offered 172.16.0.1. The same line printed `network 172.16.4.9` in
`show running-config`, so the three views agreed with each other and all three disagreed with the device.

## After the change

```
r1# show ip dhcp pool
Pool P3 :
 Total addresses                : 65534
 Current index        IP address range                     Leased/Excluded/Total
 172.16.0.1           172.16.0.1 - 172.16.255.254          0 / 0 / 65534
```

## The second half of the same line: a bare `network` replaces, it does not merge

`network` is a single configuration line, and the line states the pool's subnet in full. Re-entering
`network 10.20.30.0` after `network 10.20.30.0 255.255.255.0` therefore leaves the pool on the natural /8 -
the earlier mask is gone with the earlier line. PacketForge kept the stored mask when the new line did not
name one, which made the second line a no-op on half of itself and left the pool on a subnet neither line
had asked for. The console now clears the mask with the line and re-derives it. `network x/24` and
`network x 255.255.255.0` still name the subnet exactly and are unaffected.

This half is **inferred**, not read: no capture in hand shows the running-config after two such lines. It is
inferred because a config line is a whole statement of one fact, and the alternative - a pool whose mask
outlives the line that set it - is a state no single line could ever recreate after a reload, which is what
`show running-config` promises. What would settle it: a capture of `network 10.1.1.0 255.255.255.0`,
`network 10.1.1.0`, then `show running-config` and `show ip dhcp pool`.

## What remains unresolved

* **Class D/E addresses** (224.0.0.0 and up) have no natural mask, and no document above says what a box
  applies. PacketForge falls back to `255.255.255.0` for them. Whether a real box accepts such a pool address
  at all, and with what mask, is unknown; the fallback is this model's, and it is named in
  `naturalMaskFor()` so a later capture has one place to land.
* **Whether the box masks the address itself.** `network 172.16.4.9` is a host address inside the /16. The
  pool's served subnet is 172.16.0.0/16 (`show ip dhcp pool` prints that), but `show running-config` still
  prints the line as typed. A box may print `network 172.16.0.0 255.255.0.0` instead: the 12.4 guide's
  worked example writes `network 10.0.20.0 255.255.255.0` for a pool created from a bare `network 10.0.20.0`,
  which is consistent with either reading (10.0.20.0 is not a valid /8 network address, so a box that masked
  would have printed 10.0.0.0). Rendering was left alone: changing it is a separate question about
  `show running-config`, and no capture settled it here.
* **A `host` binding's inherited mask.** The command reference says a manual binding with no mask "examines
  its address pools" and falls back to the natural mask. PacketForge's `host` reservation carries no mask of
  its own; whether it should inherit one is a question about `host`/`hardware-address`, not about `network`.
* **127/8 and 0/8.** Both are class A by the table and both are unusable as DHCP pools. `naturalMaskFor()`
  treats them as class A; no document above discusses them, and no capture shows a box refusing them.
