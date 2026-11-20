# Proxy ARP before anyone configures it: on or off at the factory?

**Question (one, narrow).** On a Cisco box taken out of the box, with an address on an interface and nobody having
typed `ip proxy-arp`, does the box answer an ARP request for a target on *another* subnet - i.e. is proxy ARP on by
default - and which view prints the answer?

**Verdict: not one rule; it is a platform-family rule, and the families disagree.** On the IOS and IOS XE
*enterprise* families - routers, and the Catalyst L3 switches from 3560 through 3850/9500/9600 - proxy ARP is
**enabled** by default and `show ip interface` says so in one line. On NX-OS and IOS XR it is **disabled** by
default, and one IOS XE switch family (IE3x00/ESS3300, release 26.2.1) was changed to **disabled** in a security
release. One vendor page states both defaults inside a single chapter, and Cisco's own explainer now carries a
hedge rather than a default. **Nothing in `engine/` was changed**: PacketForge does not implement proxy ARP at all
(`docs/SIMULATION.md` lists it under *Absent*), so there is no default to correct and applying one would mean
building the feature - a data-plane addition, not a fidelity fix.

## What the sources say

| Source | Says | Which family |
| --- | --- | --- |
| [Cisco IOS XE 3SE IP Addressing Services Command Reference (Catalyst 3850)](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-xe-3se-3850-cr-book/ipaddr-xe-3se-3850-cr-book_chapter_01.html) | `ip proxy-arp` - **Command Default: Enabled**. The same chapter's `ip arp proxy disable` reads **Command Default: "Proxy ARP is enabled."** and "The `default ip arp proxy` command returns proxy ARP to the default behavior, which is enabled." | IOS XE, campus L3 switch |
| [Catalyst 3750 Configuration Guide 12.2(25)SEA, Configuring IP Unicast Routing (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3750/software/release/12-2_25_sea/configuration/guide/3750scg/swiprout.pdf) | "By default, the switch uses proxy ARP to help hosts learn MAC addresses of hosts on other networks or subnets." and, in the defaults list, "Proxy ARP is enabled by default. To enable it after it has been disabled, see the 'Enable Proxy ARP' section." | IOS, campus L3 switch |
| [Catalyst 9600 Configuration Guide 17.9, Configuring IP Unicast Routing (PDF)](https://cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/17-9/configuration_guide/rtng/b_179_rtng_9600_cg/configuring_ip_unicast_routing.pdf) | Default-settings table row: **"IP proxy ARP - Enabled."** | IOS XE, campus L3 switch |
| [Cisco, *Understand Proxy ARP* (doc 13718, revised 2026)](https://www.cisco.com/c/en/us/support/docs/ip/dynamic-address-allocation-resolution/13718-5.html) | The mechanism (a router answers with its own MAC and routes the packet), "Proxy ARP is defined in RFC 1027" - and a hedge that was not in older revisions: "Proxy ARP is available on multiple Cisco IOS and Cisco IOS XE platforms. **Feature availability, default behavior, and command support can vary by platform and software release.**" | IOS / IOS XE, no default claimed |
| [Cisco Nexus 6000 NX-OS Unicast Routing Command Reference, I Commands](https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus6000/sw/command/reference/unicast/n6k-ucast-cr/n5k-l3_cmds_i.html) | `ip proxy-arp` - **Command Default: Disabled**; "The IP proxy ARP feature is disabled by default." | NX-OS |
| [Cisco IOS XR 8000, Proxy ARP and local proxy ARP](https://www.cisco.com/c/en/us/td/docs/iosxr/cisco8000/ipaddresses-and-services/configuration-guide/ip-addresses-and-services-config-cisco8000/address-resolution/proxy-arp-and-local-proxy-arp.html) | "**Proxy ARP is disabled by default.** The example enables it on interface HundredGigE0/0/0/0." | IOS XR |
| [Release Notes for Cisco Catalyst IE3x00 and ESS3300, Release 26.2.x](http://www.cisco.com/c/en/us/td/docs/switches/lan/cisco_ie3X00/software/26-x/release-notes/26-2-1-rn-ie3x00-ess3300.html) | Under the release's secure-by-default list: "**Proxy ARP is disabled by default across all routed interfaces, SVIs, and subinterfaces** to reduce Layer 2 broadcast domains and prevent ARP spoofing. Configure the `ip proxy-arp` command explicitly if required." | IOS XE, industrial switch - default *changed* |
| [Catalyst 1200/1300 CLI Guide, IP Addressing Commands](https://cisco.com/c/en/us/td/docs/switches/campus-lan-switches-access/Catalyst-1200-and-1300-Switches/cli/C1300-cli/ip-addressing-commands.html) | The page contradicts itself twice: `ip proxy-arp` reads "**Default Configuration: ARP Proxy is enabled**", while the chapter's own `show ip arp` sample prints `Interface configuration:` / `VLAN 1:` / **`ARP Proxy: disabled`**. Its `ip arp proxy disable` entry reads "Default: Disabled by default", which is a default about the *disable* command, not about proxy ARP. | IOS XE, small-business switch |
| [Extreme SLX-OS 20.4.2, `ip proxy-arp`](https://documentation.extremenetworks.com/slxos/sw/20xx/20.4.2/commands/GUID-849DFAAE-D1F8-440F-A019-1D83A24D5C0E.shtml) | "**Command Default: Proxy ARP is disabled.**" | third vendor - "disabled" is not an IOS habit either |
| [RFC 1027](https://www.rfc-editor.org/rfc/rfc1027) | The protocol itself: a router may answer an ARP request for a target it can reach by a *different* interface, so a host with no default gateway still sends its off-subnet traffic to a MAC that will route it. | the rule, not a default |

## The line that reports it

`show ip interface <port>` carries the answer in the block, not in a separate command. Two independent samples of
the same view, one from a lab walkthrough and one from a CCNA explainer, print the identical sentence in the
identical position between "Inbound access list is not set" and "Security level is default":

```
  Inbound access list is not set
  Proxy ARP is enabled
  Security level is default
```

(<https://courseiva.com/commands/cisco/show-ip-interface>, <https://www.networkacademy.io/ccna/ethernet/arp-features>)

Cisco's own explainer sends a reader to exactly that view and that line: "Run `show ip interface <interface>` in
order to verify that the output reports Proxy ARP as enabled" (doc 13718). On the *disabled* side the same slot
reads `Proxy ARP is disabled`; NX-OS has a second line under it for the local variant (`Local Proxy ARP is
disabled`), and IOS XR reports it through `show arp idb <interface>` - "Proxy arp is configured, is enabled" /
"Local Proxy arp not configured" - which is a different view with a different shape.

## What PacketForge does today

Measured by running the engine (ASR 1001-X, one port addressed, no other configuration):

* **The command does not exist.** `ip proxy-arp` and `no ip proxy-arp` in interface mode both answer
  `% Unrecognized interface command: ip proxy-arp`. That is the console's plain refusal, not a vendor sentence, and
  it is honest: `docs/SIMULATION.md` §3.2 lists proxy ARP under **Absent**, beside gratuitous ARP and DAI.
* **The view does not exist either.** `show ip interface <port>` is refused as a view, and bare `show ip interface`
  falls through to the `show interfaces` listing. So there is no `Proxy ARP is enabled` / `disabled` line anywhere,
  and no line to be wrong.
* **The data plane matches the "disabled" families.** A request for an address nobody owns is unanswered
  (`docs/SIMULATION.md` §3.2: "A request for an address nobody owns is simply unanswered, so the ping times out").
  A host with no gateway therefore gets silence - the symptom of proxy ARP being off, which is what a real NX-OS or
  26.2.1 IE3x00 would also give, and *not* what a factory 2960/9300 would give.

That last bullet is the useful consequence, and the reason no code moved: the model's observable is already one of
the two vendor answers, so correcting "the default" here is not a wording fix but a decision to make one segment of
hosts reach another without a gateway - a routing behaviour with its own evidence, its own drop accounting and its
own tests.

## Known, inferred, unresolved

**Known.** The command's *default* is family-dependent: Enabled on the IOS/IOS XE enterprise families (3850, 3750,
9600 references above), Disabled on NX-OS and IOS XR, Disabled on IE3x00/ESS3300 from 26.2.1, and Disabled on
Extreme SLX. The reporting line is `Proxy ARP is enabled` inside the `show ip interface` block on IOS/IOS XE. When
proxy ARP is on, the answer is not unconditional: it replies only when the target is not on the receiving
interface's subnet *and* the route to it leaves by another interface (RFC 1027; Cisco 13718, and IOS XR's page says
the same in one sentence).

**Inferred.** That the three campus-switch pages and the 3850 command reference describe the same default, i.e.
that a factory 9200/9300 also answers - none of the pages in hand is a `show ip interface` capture from one, they
are configuration guides and a command reference. Also inferred: that `no ip proxy-arp` is the only line that
appears in `show running-config`, because IOS does not print defaults and the ICND-style captures show the negative
form only. No capture in hand proves that from a factory box.

**Unresolved, and what would settle it.**

1. **What a factory campus switch prints.** One `show ip interface gigabitethernet1/0/1` from a default-configured
   C9200 or C9300 (or a `show run all | include proxy`) would turn the "Enabled" inference into a capture. This is
   the single observation the whole question turns on.
2. **Whether the SVI differs from a routed port.** The Catalyst 1200/1300 chapter prints `VLAN 1: ARP Proxy:
   disabled` in its own sample while calling the default enabled - so "enabled" may describe routed ports only, or
   the sample may be scrubbed. A capture with both a routed port and an SVI on one box settles it.
3. **Whether the default is per-interface or global on IOS XE.** `ip arp proxy disable` is a *global* command whose
   default is "enabled", and it overrides the per-interface `ip proxy-arp`. Which of the two the model would have to
   carry first (to be able to print the block's line truthfully) is a design question this note does not answer.
4. **What the refusal looks like when routing is off.** The Catalyst 1200/1300 guide says the command "is supported
   only when IP Routing is enabled" but prints no error for the case; no capture in hand shows what a switch with
   `no ip routing` answers to `ip proxy-arp`. Not needed by this model, which refuses the command outright.

**Why nothing was changed.** The loop's rule is that thin or contradictory evidence does not reach the engine, and
this is contradictory at the level of the vendor's own pages (3850 says enabled; NX-OS says disabled; one IOS XE
release flipped it; one chapter says both). Implementing proxy ARP would also be a new data-plane behaviour rather
than fidelity of an existing one. The note records the rule, the per-family split and the one capture that would
close it, so the increment that does implement it starts from evidence instead of from a guess.
