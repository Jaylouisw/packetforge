# `vlan 1006` on a factory-default switch: what allows it, and what does the box print when it does not?

**Question (one, narrow).** On a Cisco access switch out of the box, does `vlan <id>` for an id in the
extended range (1006-4094) succeed - and if it does not, what exactly does the box print, and *when*?
This asks only about the creating door. The range 1002-1005 is already settled
(`research/default-vlan-refusal-wording.md`, `research/vlan-media-defaults.md`), and the allowed-list
arithmetic on trunks that spans 1-4094 is settled too.

**Verdict: unresolved as a single rule, and nothing in the engine was changed.** The vendor states the
rule plainly - extended-range VLANs need VTP transparent mode in VTP v1/v2 - and the refusal is transcribed
five times, identically, on five different boxes. But two boxes in the *same* VTP version disagree: a
Catalyst 9606R running VTP v1 in server mode refuses, and a Catalyst 4500X running VTP v1 in **client**
mode creates one. PacketForge has no VTP at all, so it has neither a mode to test the rule against nor a
way to satisfy it; a blanket refusal would be a one-way door in a tool whose job is to let a learner build
the VLAN. That decision is a feature decision (a `vtp mode` command, a per-device default), not a fidelity
fix.

## What PacketForge does today

Measured on `2d71aeb4`, one `C2960X-24TS-L`, no configuration:

```
sw1# configure terminal
sw1(config)# vlan 1006
VLAN 1006 created (name: VLAN1006)
sw1(config)# vlan 1006 name ext
VLAN 1006 created (name: ext)
sw1(config)# interface Gi1/0/1
sw1(config-if)# switchport access vlan 1006
Access VLAN 1006 on Gi1/0/1
sw1(config-if)# end
sw1# show vlan brief
VLAN Name                             Status    Ports
---- -------------------------------- --------- -------------------------------
1    default                          active    Gi1/0/2, Gi1/0/3, Gi1/0/4
...
1002 fddi-default                     act/unsup
1003 token-ring-default               act/unsup
1004 fddinet-default                  act/unsup
1005 trnet-default                    act/unsup
1006 ext                              active    Gi1/0/1
sw1# show running-config
! PacketForge running-config
hostname Catalyst 2960X-24TS-L-sw1
vlan 1006 ext
interface GigabitEthernet1/0/1
  switchport access vlan 1006
  switchport mode access
```

Three properties follow from the code and the transcript:

* **The acceptance is deliberate, not an oversight.** `docs/CLI.md` ("A VLAN id is a number") says every
  VLAN door takes "a whole number from 1 to 4094", and `test/vlan.test.js:111` pins the intent in words:
  `vlan 1005 -> E_VLAN_RESERVED, 1001 and 1006 are fine`. A refusal would retract a documented contract.
* **There is no VTP anywhere.** `grep -ri vtp engine/ docs/CLI.md web/ devices/` returns nothing: no mode,
  no version, no domain, no `vtp` command, and therefore no state in which the vendor's rule could be
  evaluated.
* **The console has no `config-vlan` sub-mode.** `vlan 1006` is a single global-config line that creates
  and acknowledges in one step (`vlan 1006 name ext` is the one-line spelling, and `name ext` on its own is
  refused with a pointer to it). This matters below: on a real box the refusal is printed *later*.

## The refusal, character for character

Three independent captures agree, on an `end`/`exit` out of VLAN configuration mode:

```
Switch3(config)#vlan 1006
Switch3(config-vlan)#end
% Failed to create VLANs 1006
Extended VLAN(s) not allowed in current VTP mode.
%Failed to commit extended VLAN(s) changes.
Switch3#
```

Note the three-line shape: a first line with `% ` (percent, space), a second line with **no** `%` at all and
a full stop, and a third with `%` hard against `Failed`. A fourth line appears in the log, not on the
console: `%SW_VLAN-4-VLAN_CREATE_FAIL: Failed to create VLANs 2567: extended VLAN(s) not allowed in current
VTP mode`.

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 2960 / 2960-S Software Configuration Guide 12.2(53)SE, "Configuring VTP" (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_53_se/configuration/guide/2960scg/swvtp.pdf) | The rule, and the default version: "VTP version 1 and version 2 support only normal-range VLANs (VLAN IDs 1 to 1005)"; "Extended range VLANs (VLANs 1006 to 4094) are supported only in VTP version 3"; "In VTP versions 1 and 2, the switch must be in VTP transparent mode when you create extended-range VLANs"; "**VTP version 2 and version 3 are disabled by default.**" |
| [Catalyst 2960 / 2960-S Software Configuration Guide 15.0(1)SE, "Configuring VLANs"](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-0_1_se/configuration/guide/scg2960/swvlan.html) | Same rule, plus the VTP v3 exception: "VTP version 3 supports the entire VLAN range (VLANs 1 to 4094)" and "VTP version 3 supports extended-range VLANs in VTP server and transparent mode." |
| [Catalyst 2960-XR VLAN Configuration Guide 15.2(2)E (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15-2_2_e/consolidated_guide/b_1522e_consolidated_2960xr_cg/b_1522e_consolidated_2960xr_cg_chapter_0110100.pdf) | The **timing**, in the vendor's own words: "In VTP version 1 or 2, if you enter an extended-range VLAN ID when the switch is not in VTP transparent mode, an error message is generated when you exit VLAN configuration mode, and the extended-range VLAN is not created." |
| [Catalyst 4500, "Understanding and Configuring VTP" (PDF)](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/31sg/configuration/guide/vtp.pdf/1000) | The default **mode**: "By default, the Catalyst 4500 series switch is in VTP server mode ... VTP server is the default mode." Together with the line above, a factory-default switch is server + v1, which is exactly the state that refuses. |
| [Das Blinkenlichten, "VTP (VLAN trunking protocol)"](https://www.dasblinkenlichten.com/vtp-vlan-trunking-protocol/) | The transcript above, on a `Switch3` with VTP v1/v2 (the post's own framing: "If you try and configure an extended range VLAN VTP it won't work"), and the refusal at `end`. |
| [howtonetwork.com, "VTP - VLAN Trunking Protocol"](https://www.howtonetwork.com/free-ccna-study-guide-ccna-book/vtp-vlan-trunking-protocol/) | Two captures in one chapter. The before/after pair for `vlan 2000`: the three lines, then `Switch(config)#vtp mode transparent` / `Setting device to VTP TRANSPARENT mode.` / the same `vlan 2000` accepted. And, a page later, the sentence that names the state - "When you try to configure extended VLANs with the switch in **the default VTP mode of the server**, you will see an error message like the one in the output below" - followed by the same three lines for `vlan 2010` and that box's `show vtp status`: `VTP Version : running VTP1 (VTP2 capable)`, `VTP Operating Mode : Server`, `VTP V2 Mode : Disabled`. That is the default state of a 2960, measured. |
| [ccie-in-3-months, "How to use extended-range vlans in the NM-16ESW"](http://ccie-in-3-months.blogspot.com/2008/05/how-to-use-extended-range-vlans-in-nm.html) | The same three lines for `vlan 2567` on a `SW1`, **plus** the syslog line `%SW_VLAN-4-VLAN_CREATE_FAIL: Failed to create VLANs 2567: extended VLAN(s) not allowed in current VTP mode` - so the console message is accompanied by a log entry. |
| [Cisco Community, "Extended Vlans" (2025)](https://community.cisco.com/t5/switching/extended-vlans/td-p/863621) | A modern **Catalyst 9606R**, `VTP version running : 1`, `VTP Operating Mode : Server`, holding 20 extended VLANs already: `vlan 3063` still prints the same three lines. The same post then shows the contradiction - a **Catalyst 4500X**, `VTP version running : 1`, `VTP Operating Mode : Client`, creating `vlan 3062` and `sh vlan id 3062` reporting it `active` - and the poster's own note that "on older C6880 and C4500X it was possible to configure extended vlans even which mode is running". |
| [cnblogs, "Cisco VLAN大于1006-4000创建"](https://www.cnblogs.com/im17me/p/12543641.html) | The same three lines for `vlan 2000`, the explanation that the switch is in server mode by default, and the same command succeeding after `vtp mode transparent` - a fourth copy of the message, on a fourth box. |

## What is known

1. **The rule is published and repeated**: v1/v2 learn and carry only 1-1005; extended-range VLANs need
   transparent (v1/v2) or VTP version 3. Four vendor documents say it in three different chapters.
2. **The refusal is one message, three console lines, printed on exit from VLAN configuration mode** - not
   at the `vlan` command, because the box defers the commit until the sub-mode closes. The `%` spacing is
   inconsistent between line 1 and line 3, and line 2 has no prefix at all.
3. **The default state is server + version 1**, so a factory-default 2960-class or 9600-class switch is in
   the refusing state before anyone types `vtp mode`.
4. **Transparent mode is the documented remedy**, shown working in two of the captures.
5. **The same three lines come from a 2025 IOS-XE box (C9606R) and from a 2008-era IOS box**, so the message
   is not a legacy artefact.

## What is inferred

* PacketForge's 1-4094 contract is a **deliberate simplification for the lab**, in the same family as
  LLDP always being on (`research/lldp-default-state.md`): a simulator with no VTP has to choose a mode, and
  choosing "server + v1" would refuse the extended range outright while choosing "transparent" silently
  accepts it. Accepting is the useful choice for a teaching tool. It is currently an **unstated** one:
  `docs/CLI.md` says 1-4094 without saying why a box might say no.
* Because the console has no `config-vlan` sub-mode, it *cannot* reproduce the vendor's timing even if the
  rule were adopted: a refusal here would have to be printed by the `vlan` line itself, one prompt earlier
  than the box prints it. That is a shape difference, not a wording one, and it is the strongest argument
  for leaving this alone until a VTP mode exists.

## What remains unresolved

* **Which platforms refuse at all.** The C4500X capture shows an extended VLAN created in client mode with
  VTP v1 running, which contradicts the rule as published. Either that box's VTP state is not what
  `show vtp status` reports, or the platform's VLAN commit path bypasses the VTP check. One capture cannot
  tell which, and no vendor document acknowledges a per-platform exception.
* **Range spelling.** No capture shows `vlan 1006-1010` or a mixed `vlan 999,1006` under a refusing mode -
  whether the message names the range once (`Failed to create VLANs 1006-1010`) or once per id, and whether
  the in-range ids still commit, is unknown.
* **The port door.** `switchport access vlan 1006` on a box where 1006 does not exist prints
  `% Access VLAN does not exist. Creating vlan 1006` (this console already models that pair, verbatim, for
  normal-range ids). Whether the auto-create is then refused by VTP - and with which of the two messages -
  is not documented in any capture found.
* **Whether the refused VLAN leaves anything behind.** None of the captures runs `show vlan` afterwards; the
  C9606R post implies it does not exist, but the box also already held 20 extended VLANs.
* **The default version on Catalyst 9000.** The 9606R capture is v1, but whether every 9000-series platform
  ships with VTP v1 (rather than v3, which would accept extended VLANs in server mode) is not stated in the
  documents found.

## What evidence would settle it

1. One paste from a factory-default Catalyst 9200/9300/9600 - `show vtp status`, `vlan 1006`, `end`,
   `show vlan brief | include 1006` - which fixes the default version, the refusal, and the aftermath in
   four commands.
2. The same four commands on a box in `vtp mode transparent`, to confirm the accept path on current IOS-XE
   (the 2008-era captures only prove it for IOS 12.x).
3. One capture of `vlan 1006-1008` on a refusing box, for the range wording.
4. One capture of `switchport access vlan 1006` (no prior `vlan 1006`) on a refusing box, for the port door.

## What a change would cost

Not done here. It is one field and one command, but both are new state: `vtp: {mode, version}` on the device
with a per-vendor default (`server`/`1` for Cisco), a `vtp mode server|client|transparent` command with its
own acknowledgement lines, and the refusal path for ids 1006-4094 on a device whose mode is not transparent
(and, for VTP v3, accepted in every mode). Then `docs/CLI.md`'s "1 to 4094" needs its exception, and
`test/vlan.test.js:111` - which asserts 1006 is "fine" - has to be re-aimed at "fine on a transparent box,
refused on a default one". That is a plan under `docs/plans/`, and the first step of it is the four commands
in "what evidence would settle it".
