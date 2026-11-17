# A voice VLAN belongs to an access port, and a trunk stores it without using it

**Question.** `switchport voice vlan <id>` is the command that tells a switch which VLAN an attached IP phone
should tag its own traffic with. Which port mode does it act on - and what does it do on the other one?

This matters because the console had the rule backwards in both directions: `validatePortConfig` refused a
voice VLAN on an access port ("voice traffic is tagged") and `classifyEgress` carried it on a **trunk** whether
or not the trunk's allowed list named it. The one configuration a Cisco phone actually uses - access mode, one
data VLAN, one tagged voice VLAN - was the one configuration the simulator reported as "stored, not in use".

## What the vendor documentation says

Every current Cisco switching guide states the same prerequisite, in the same words:

> Voice VLAN configuration is only supported on device access ports; voice VLAN configuration is not supported
> on trunk ports.
>
> **Note** Trunk ports can carry any number of voice VLANs, similar to regular VLANs. The configuration of voice
> VLANs is not supported on trunk ports.

- Catalyst 9200, *VLAN Configuration Guide*, IOS XE 17.17, "Configuring Voice VLANs":
  https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-17/configuration_guide/vlan/b_1717_vlan_9200_cg/configuring_voice_vlans.html
- Catalyst 9600, *VLAN Configuration Guide*, IOS XE 17.12, same chapter:
  https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/17-12/configuration_guide/vlan/b_1712_vlan_9600_cg/configuring_voice_vlans.html

The same chapter describes the data path, which is the part the simulator has to model:

> When you enter a VLAN ID, the IP phone forwards voice traffic in IEEE 802.1Q frames, tagged with the specified
> VLAN ID. The device puts IEEE 802.1Q voice traffic in the voice VLAN. When you select dot1p, none, or untagged,
> the device puts the indicated voice traffic in the access VLAN.

So a voice port is one port with two memberships: untagged data in the access VLAN, tagged voice in the voice
VLAN. It does **not** become a trunk - the tagged set is exactly one VLAN.

That the configuration is *accepted* on a trunk and still does nothing is stated outright in the Catalyst 9600
port-security chapter, in a compatibility note:

> Voice VLAN is only supported on access ports and not on trunk ports, even though the configuration is allowed.

https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/26-x/configuration_guide/sec/b_26x_sec_9600_cg/port_security.html

Older platforms phrase the same rule as advice, because the command itself never objects:

- Catalyst 3750 SCG 12.2(25)SEA, "Configuring Voice VLAN":
  "You should configure voice VLAN on switch access ports; voice VLAN is not supported on trunk ports."
  http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3750/software/release/12-2_25_sea/configuration/guide/3750scg/swvoip.html
- Catalyst 3560 Command Reference 15.0(2)SE, `switchport voice vlan`:
  "Voice VLAN is supported only on access ports and not on trunk ports." and "You should configure voice VLAN on
  Layer 2 access ports."
  http://www.cisco.com/en/US/docs/switches/lan/catalyst3560/software/release/15.0_2_se/command/reference/cli3.html
- IEEE 802.1X Voice VLAN (IOS XE 3E): "A voice VLAN port is a special access port associated with two VLAN
  identifiers."
  https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_usr_8021x/configuration/xe-3e/sec-usr-8021x-xe-3e-book/sec-ieee-8021x-voice-vlan.pdf

## What was changed

`engine/vlan.js`:

- `classifyEgress` - on an **access** port the voice VLAN leaves tagged and marked as voice; the access VLAN
  still leaves untagged; every other VLAN is still dropped. On a **trunk** the allowed list is the whole answer:
  the voice field neither adds a VLAN nor exempts one from the list.
- `classifyIngress` - an access port accepts exactly one tagged VLAN (its voice VLAN) and still drops every
  other tagged frame with `tagged-frame-on-access`; the trunk lost its voice exemption for the same reason.
- `validatePortConfig` - the warning moved from the access case to the trunk case: a voice VLAN on a trunk
  "has no effect ... a voice VLAN applies to access ports".
- `switchportSentence` - an access port prints `access VLAN 10 · voice 20 (tagged)`; a trunk prints
  `... · voice 20 (no effect on a trunk)`. A voice VLAN equal to the access VLAN is not printed twice.
- `framesCompatible` / `mismatchReason` - two access ports in the same data VLAN but with different voice VLANs
  no longer look interchangeable, which is what a LAG member check needs.

`engine/cli.js`:

- `switchport voice vlan` says nothing extra on an access port and explains the stored-but-inert case on a
  trunk. `no vlan <id>` still refuses to delete a VLAN a voice port references, but now names an access port's
  reference as `(voice)` and a trunk's as `(voice, no effect)`, and no longer claims the port went "inactive"
  in it - the port's data VLAN was never that VLAN.

`show vlan` follows automatically, because it asks `classifyEgress` which VLANs a port is a member of: a voice
port is now listed under both its access VLAN and its voice VLAN.

## What is inferred, not quoted

- **The dual listing in `show vlan brief`.** No vendor page found here prints a `show vlan` sample with a voice
  port in both rows; the guides only say the voice VLAN "should be present and active" and is verified with
  `show vlan`. The inference is from the membership model ("an access port associated with two VLAN
  identifiers") and from CCNA-level material that shows exactly that table, e.g.
  https://netstuts.com/StepbyStepTut/voice-vlan-configuration - "access ports appear in both VLANs when a voice
  VLAN is configured". Secondary source, but it agrees with the primary model, and a table that listed the port
  in one row only would contradict the data plane the same page documents.
- **The exact CLI wording when the command is used on a trunk.** Cisco says the configuration "is allowed", but
  no sample output was found for the receipt. This console therefore says what is true of its own model
  ("stored; a trunk carries VLANs by its allowed list ...") rather than inventing an IOS `%` line.
- **Whether `show vlan` on every platform lists the voice VLAN row when no other port is in it** (i.e. whether
  the row exists only because the voice VLAN was created). This model prints the row when the VLAN exists and
  the port in it, which is what the membership rule implies.

## What would settle the remaining questions

A transcript from one real box - `show vlan brief`, `show interfaces <port> switchport` and
`show running-config interface <port>` on a port configured `switchport access vlan 10` +
`switchport voice vlan 20` - and the same three commands after `switchport mode trunk` is typed over the top.
That single transcript would fix the row set of `show vlan`, the receipt wording for the trunk case, and whether
the voice parameter survives a mode change in the running config (this model keeps it, and prints it).
