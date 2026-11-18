# How many links can one EtherChannel carry, and what happens to the ports that do not fit?

**Question (one, narrow).** Every `channel-group` line in this console puts a port into a bundle, and the
bundle was as wide as the operator's patience: ten lines made a ten-member `Po1`, every member read `(P)`
bundled, and the frame hash was taken across all ten. A real IOS-like box states a number in every chapter
that documents EtherChannels. What is it — for `mode on`, for `active`/`passive`, and for the members that do
not fit?

**Verdict: eight links carry, and they are the eight the hardware picks.** `mode on` (non-negotiating) holds
eight members and no more; LACP holds sixteen, of which **eight are active and the rest are hot-standby**,
printed `(H)` in `show etherchannel summary` — the letter this console has printed in its key since the table
was written and could never print in a row. PacketForge now caps the active set at eight everywhere the set is
used (the table, the receipt, the data plane), parks the LACP overflow as hot-standby, refuses a ninth `mode on`
member and a seventeenth LACP member, and promotes a hot-standby member when an active link goes away.

## What PacketForge did before this

`C2960X-24TS-L`, ten cables to a second 2960-X, ten `channel-group 1 mode active` lines at each end:

```
sw1#show etherchannel summary
1      Po1(SU)         LACP      Gi1/0/1(P) Gi1/0/2(P) Gi1/0/3(P) Gi1/0/4(P) Gi1/0/5(P) Gi1/0/6(P)
                                  Gi1/0/7(P) Gi1/0/8(P) Gi1/0/9(P) Gi1/0/10(P)
```

Ten active links, ten links of hash, and a table that agreed with the configuration rather than with the
hardware. `selectMember()` had no notion of a capacity: its eligible list was "every member that can carry a
frame", so a ten-member bundle moved ten links' worth of traffic. The key above the same table already read
`H - Hot-standby (LACP only)` and nothing in the engine could ever produce one.

## Evidence

| Source | Says |
| --- | --- |
| [Consolidated Platform Configuration Guide, Cisco IOS Release 15.2(3)E — *Configuring EtherChannels*, Catalyst 2960-X](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_3_e/consolidated_guide/b_1523e_consolidated_2960x_cg/m_lay2_ethchl_cg_2960.html) | "Each EtherChannel can consist of up to eight compatibly configured Ethernet ports." Then, in the `channel-group` step: "For a PAgP EtherChannel, you can configure up to eight ports of the same type and speed for the same group. For a LACP EtherChannel, you can configure up to 16 Ethernet ports of the same type. Up to eight ports can be active, and up to eight ports can be in standby mode." |
| Same chapter, *Configuring LACP Hot-Standby Ports* | "When enabled, LACP tries to configure the maximum number of LACP-compatible ports in a channel, up to a maximum of 16 ports. **Only eight LACP links can be active at one time.** The software places any additional links in a hot-standby mode. If one of the active links becomes inactive, a link that is in the hot-standby mode becomes active in its place." And the tie-break: "the software automatically decides which of the hot-standby ports to make active based on the LACP priority … LACP system priority, System ID … LACP port priority, Port number. In priority comparisons, numerically lower values have higher priority." Then: "**The hot-standby ports that have lower port numbers become active in the channel first.**" And the reporting: "You can use the `show etherchannel summary` privileged EXEC command to see which ports are in the hot-standby mode (**denoted with an H port-state flag**)." |
| [Layer 2 Configuration Guide, Cisco IOS Release 15.2(2)E — Catalyst 2960-X (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_2_e/layer2/configuration_guide/b_layer2_1522e_2960x_cg.pdf) | The same three sentences, so they are the platform family's rule and not one release's. |
| [Catalyst IE 4010 / IE 5000 Switch Software Configuration Guide, 15.2(4)EC — *How to Configure EtherChannels* (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/cisco_ie4010/software/release/15-2_4_EC/configuration/guide/scg-ie4010_5000/swethchl.pdf) | "You can use the `show etherchannel summary` privileged EXEC command to see which ports are in the hot-standby mode (denoted with an H port-state flag)." — the flag, stated as a property of the command rather than of one platform. Also: "If LACP is not able to aggregate all the ports that are compatible … all the ports that cannot be actively included in the EtherChannel are put in the hot-standby state and are used only if one of the channeled ports fails." |
| [Configuring EtherChannel and Link State Tracking, Catalyst 4500, IOS XE 3.8.0E (PDF)](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/XE3-8-0E/15-24E/configuration/guide/xe-380-configuration/channel.pdf) | "EtherChannel bundles up to eight individual Ethernet links into a single logical link that provides an aggregate bandwidth of up to 800 Mbps (Fast EtherChannel), 8 Gbps (Gigabit EtherChannel), or 80 Gbps (10 Gigabit EtherChannel)" — the aggregate is eight times the link, which is the same cap seen from the bandwidth side. `show etherchannel 25 summary` samples print the `H - Hot-standby (LACP only)` key line. |
| [Configuring EtherChannels, Catalyst 3850, IOS XE 3SE (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3850/software/release/3se/consolidated_guide/configuration_guide/b_consolidated_3850_3se_cg/b_consolidated_3850_3se_cg_chapter_011111.pdf) | The administrator can lower the count: "You can override the default behavior by specifying the maximum number of active ports in a channel, in which case, the remaining ports become hot-standby ports. For example, if you specify a maximum of five ports in a channel, up to 11 ports become hot-standby ports." |

## What is known

- **Eight active links per bundle.** Stated in words ("up to eight compatibly configured Ethernet ports",
  "Only eight LACP links can be active at one time") and in the aggregate-bandwidth sentence (8 Gbps
  Gigabit EtherChannel = 8 × 1 Gbps).
- **Eight members for a non-negotiating group.** "For a PAgP EtherChannel, you can configure up to eight
  ports of the same type and speed for the same group." PAgP and `on` are the two non-LACP modes; the console
  models `on`, and it takes the same eight.
- **Sixteen members for LACP, with the overflow hot-standby.** "Up to eight ports can be active, and up to
  eight ports can be in standby mode."
- **Standby is a state the operator can see**, `H` in the Ports column of `show etherchannel summary`, and the
  key prints that letter whether or not any row uses it. That key line was already in this console.
- **Standby is a take-over, not a drop.** "If one of the active links becomes inactive, a link that is in the
  hot-standby mode becomes active in its place."
- **Which links are active is decided by port number** once system priority and port priority are equal:
  "The hot-standby ports that have lower port numbers become active in the channel first" and "numerically
  lower values have higher priority".

## What is inferred

- **The active eight are the eight lowest-numbered members that can carry.** The priority order is system
  priority, system ID, port priority, then port number; this model has one system priority, no configurable
  port priority, and one port number per port, so the order collapses to port number. That is why the cap is
  applied *in port order* (`engine/iface-name.js` `comparePortNames`) while the hash still walks the bundle in
  its own name-sorted order — the choice of which links are in the channel is the hardware's, the choice of
  which one carries a given flow is this model's.
- **A member that cannot carry does not hold an active slot.** The vendor sentence is about links that are up;
  a member with its cable out is `(D)` here and its slot goes to the next standby, which is the "takes over"
  rule applied continuously rather than only at failure time.
- **The refusal wording is this console's.** Nothing read for this note shows the exact IOS line for a
  seventeenth `channel-group` or a ninth `mode on` member, so the console says what it did and why in its own
  sentence (`% Gi1/0/9 not added: channel group 1 already holds 8 members …`) rather than quoting a box.

## What is unresolved

1. **Whether a real box refuses the ninth `mode on` line or accepts it and leaves the port unbundled.** The
   configuration guideline says "you can configure up to eight ports … for the same group", which reads as a
   cap on the configuration; the 2960-X chapter's `channel-group` description does not say what the CLI does
   with the ninth. This console refuses, because accepting and then quietly not bundling is the silent-drop
   defect class the catalogue keeps fixing. **What would settle it:** a transcript of nine
   `channel-group 1 mode on` lines on one Catalyst, with `show running-config` afterwards.
2. **The same question for the seventeenth LACP member.** Sixteen is the documented maximum; the response to
   exceeding it (refusal, or an accepted line for a port that stays out of the group) is not in any document
   read here.
3. **`lacp max-bundle` is not modelled.** A 3850 (and IOS XE generally) lets the administrator lower the active
   count, and the rest become hot-standby. The console always runs eight, which is the default.
4. **Non-IOS platforms in the catalogue inherit IOS's number.** Some vendors aggregate 16 active links, and a
   few switch families cap lower. The cap belongs in a per-device capability (the catalogue already carries
   `capabilities`) rather than in one global constant; the global constant is the honest choice while the
   console speaks one IOS-like dialect, and a device entry that states a different maximum should override it.
5. **A ninth `mode on` member in a saved topology** (a hand-written lab, or a file from an older build) is
   shown `(s)` suspended rather than `(P)`: the port is up and is not in the channel. The key's `(s)` is
   "suspended", which is the nearest honest letter for a state no vendor sample was found for; `u` (unsuitable
   for bundling) is the other candidate. **What would settle it:** a `show etherchannel summary` from a box
   whose `on` group was given nine ports.
