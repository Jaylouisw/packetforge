# A channel group's number: one range for every box, or one per box?

**Question (one, narrow).** What is the highest `channel-group` number each platform in this catalogue
accepts, and does this console accept the same numbers? The id is the one field `channel-group` validates
on both its doors (`_channelGroupId()` in `engine/cli.js`, used by the set form and by `no channel-group`,
`research/no-channel-group-undo-grammar.md`), so it is a single rule with a single printed claim:
`a channel group is identified by a number, 1-4096`.

**Verdict: the range is a platform property, it differs by a factor of 680 across the platforms this
catalogue carries, and the console's single `1-4096` is the widest of them (NX-OS) applied to every
device.** On a Catalyst 2960 the console accepts `channel-group 7` and builds `Port-channel 7`; the same
line on the box is outside the documented range, which is 1 to 6. **Nothing was changed in this run**:
the number the check needs is per platform, and no device entry carries one (there is no OS key and no
limits field - `devices/cisco/catalyst2960.json` has `vendor`, `model`, `label`, `category`,
`description`, `capabilities`, `portTemplate`, `icon`, `color`). Replacing 4096 with any other global
figure would swap today's false acceptances on a 2960 for false refusals on an Aruba CX switch, whose
LAG ids run to 256 - so the fix is a schema question, not a one-line change.

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 2960 and 2960-S Software Configuration Guide 12.2(53)SE1, *Configuring EtherChannels*](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_53_se/configuration/guide/2960scg/swethchl.html) | "The number of EtherChannels is limited to six." / "Each EtherChannel has a port-channel logical interface numbered from 1 to 6." / in the `channel-group` step: "For *channel-group-number*, the range is 1 to 6." |
| [Catalyst 2960 Switch Software Configuration Guide (LAN Lite) 12.2(37)EY, same chapter](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_37_ey/configuration/guide/scg/swethchl.html) | The same 1-to-6 range, plus the administrator's form of it: "Do not try to configure more than 6 EtherChannels on the switch." |
| [Catalyst 2960-X Layer 2 Command Reference 15.2(2)E, `channel-group`](https://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_2_e/layer2/command_reference/b_Layer2_3_1522e_2960x_cr.pdf) | "Channel group number. The range is 1 to 24." (the same sentence in the 15.2(3)E reference, and in the 15.2(6)E configuration guide: "For channel-group-number, the range is 1 to 24") |
| [Catalyst 2960-XR Layer 2/3 Command Reference 15.2(7)E, `channel-group`](https://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15_2_7_e/command_reference/b_1527e_2960xr_cr/m_layer2_2960xr_cr.html) | "Channel group number. The range is 1 to 48." - the XR chassis carries twice the 2960-X's figure on the same command page layout |
| [Catalyst 9300 Command Reference, IOS XE Amsterdam 17.3.x, Layer 2/3 Commands](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-3/command_reference/b_173_9300_cr/layer_2_3_commands.html) | "channel-group-number - Channel group number. The range is 1 to 128." The same 1-to-128 on 17.18.x, so it is the current figure and not an early-release artefact |
| [Nexus 3548 NX-OS Interfaces Configuration Guide 10.3(x), *Configuring Port Channels*](http://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus3548/103x/configuration/interfaces/cisco-nexus-3548-nx-os-interfaces-configuration-guide-103x/m_3548_configuring_port_channels_9x.html) | "interface port-channel channel-number ... The range is from 1 to 4096." and "The channel-number range is from 1 to 4096." - the origin of the console's figure |
| [AOS-CX 10.16 Link Aggregation Guide (all AOS-CX series)](https://arubanetworking.hpe.com/techdocs/AOS-CX/10.16/PDF/link_aggregation.pdf) | "The range of the LAG interface ID is 1 to 256." The command is `interface lag <ID>` / `lag <ID>`, not `channel-group` |

## What is known

* **The documented range is per platform, not per command.** Six sources, six figures: 6 (2960),
  24 (2960-X), 48 (2960-XR), 128 (9300), 4096 (NX-OS), 256 (AOS-CX LAG id). Every one of them is stated
  as a property of the box, in the same sentence shape ("the range is ..."), on the same command.
* **The figure tracks the platform's EtherChannel capacity.** The 2960 guide says "limited to six" and
  then "the range is 1 to 6"; the 2960-X guide's 24 and the 2960-XR's 48 are the group counts those
  chassis support. That correlation is stated in prose for the 2960 only; for the other two it is an
  observation about two numbers on two pages of the same book.
* **The console validates one bound on both doors.** `_channelGroupId()` refuses anything outside
  1-4096, and both `channel-group <n> mode ...` and `no channel-group <n>` call it, so the printed range
  and the checked range cannot disagree (#1505) and the undo form cannot silently drop the number
  (#1510). That invariant is worth keeping; only the number is in question.
* **The out-of-range id is visible in the views.** A group number the console accepts becomes
  `Port-channel <n>`, a row in `show etherchannel summary` and a `channel-group <n> mode ...` line in
  `show running-config`.

## What is inferred

* **That 4096 was taken from NX-OS.** The figure is NX-OS's exact upper bound and no IOS/IOS-XE
  platform in the table above shares it. Stated as provenance, not as a claim about intent.
* **That a Catalyst refuses the id at parse time**, rather than accepting it and failing when the
  port-channel is created. IOS's parser knows the bound (`channel-group ?` prints `<1-6>` on a 2960 in
  the same way `speed ?` prints a menu), which is why the range is quoted in the command reference
  rather than in a "Guidelines" note. Not witnessed - see below.
* **That a per-platform bound belongs beside the other platform defaults** (`routingDefault()` in
  `engine/device.js` answers "what does this box do out of the box" from vendor + category), i.e. in
  the engine keyed on something the device already has, or in the device entry as a limit. Both are
  schema decisions; neither is a wording change.

## What remains unresolved

* **The exact sentence a box prints for an out-of-range id.** Not found in any command reference (they
  give the range, never the breach) and no transcript was found of `channel-group 7` on a 2960. Candidates:
  the parser's `% Invalid input detected at '^' marker.`, or a vendor-worded
  `% Channel group number must be between 1 and 6`. **What would settle it:** one console capture of
  `channel-group 7 mode active` on a 2960 (and `channel-group 25` on a 2960-X, `channel-group 129` on a
  9300), with the prompt after it.
* **Where the number should live.** A `limits.channelGroups` field on ~2,351 device entries is a data
  migration; a vendor+category table in the engine would be wrong for 2960 vs 9300 (same vendor, same
  category, 6 vs 128) and would need a model-family regex, which no other default in the engine uses.
  **What would settle it:** a decision on the schema (the catalogue-audit and capability-vocabulary
  plans are the places that decision is already being made), after which this is a one-line change in
  `_channelGroupId()` plus a test.
* **What the console does with a `channel-group` line on a platform whose own command is `lag`.** The
  command is offered to every device, so an Aruba CX 6000 answers an IOS spelling its operating system
  does not have. That is the console's one-dialect design, not this note's question, but it means the
  Aruba 256 figure is evidence about the *number*, not about the command name.
* **The ranges for the rest of the catalogue** (Huawei, HPE, Extreme, MikroTik, ...). Nothing was
  gathered; this note claims only the six sources above.

## What PacketForge does today

Measured on this branch's base (`919e1222`), `Catalyst2960`, `Fa0/1`, nothing else configured:

```
SW1(config-if)#channel-group 7 mode active
Creating a port-channel interface Port-channel 7
Interface Fa0/1 added to channel group 7 (mode active)
SW1(config-if)#channel-group 4096 mode active
Creating a port-channel interface Port-channel 4096
Interface Fa0/1 moved from channel group 7 to 4096 (mode active)
SW1(config-if)#channel-group 4097 mode active
% Invalid channel group id "4097": a channel group is identified by a number, 1-4096 (e.g. `channel-group 1 mode active`)
```

`show running-config` then carries `channel-group 4096 mode active`, and `show etherchannel summary`
prints the row `4096   Po4096(SD)      LACP      Fa0/1(D)` - the table's Group column is wide enough for
four digits, so a number no Catalyst in the catalogue can hold is not visible as a layout fault either.
The member cap (eight for a non-negotiating group, sixteen tried at most) is a separate, already
researched rule (`research/etherchannel-member-limit.md`); this note is about the id alone.
