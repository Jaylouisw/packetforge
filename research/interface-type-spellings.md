# One port, four spellings: the interface TYPE

**Question (one, narrow).** When an operator types an interface name the long way - `interface
GigabitEthernet1/0/1`, the form every Cisco document writes and every `show running-config` prints - or
puts a space before the number, does a real IOS-like box accept it? And what did this console do?

**Verdict: known, and adopted.** The four spellings are one command, stated by the vendor in one
sentence: "You do not need to add a space between the interface type and the interface number ... you can
specify either gigabitethernet 0/1, gigabitethernet0/1, gi 0/1, or gi0/1." This console accepted only the
catalogue's own spelling (`Gi1/0/1`, because that is what the panel is silkscreened), so the spelling an
operator is most likely to paste - and the one a saved real config contains - was refused with
`% Interface not found: GigabitEthernet1/0/1`. `engine/iface-name.js` now folds the interface TYPE onto
one name, with or without the space, and `test/iface-type-spelling.test.js` holds it.

## The vendor states it in one sentence, next to the type names

The *Configuring Interface Characteristics* chapter of the Catalyst Digital Building Series guide gives
the type and its abbreviation, then the note that makes the space optional:

> Type - Gigabit Ethernet (gigabitethernet or gi) for 10/100/1000 Mb/s Ethernet ports ...
>
> **Note** You do not need to add a space between the interface type and the interface number. For
> example, in the preceding line, you can specify either **gigabitethernet 0/1**, **gigabitethernet0/1**,
> **gi 0/1**, or **gi0/1**.

* http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst_digital_building_series_switches/software/15-2_6_e/configuration_guide/b_1526e_consolidated_cdb_cg/m_int_inter_cg.pdf (§ How to Configure Interface Characteristics, step 2)

The same note appears verbatim in the Catalyst 2960-L 15.2(6)E consolidated guide
(https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960l/software/15-2_6_e/configuration_guide/b_1526e_consolidated_2960l_cg.pdf).

Two things follow that the table had no rule for: the **type** has an abbreviation (`gi`), and the
number may be attached or separated. Neither is a property of one port - they are properties of the
word in front of the number.

## Both forms are in the vendor's own transcripts, not only in the note

The Catalyst 3560 command reference prints the long form attached in one place and separated in another,
in the same chapter:

```
Switch(config)# interface gigabitethernet0/1
Switch(config-if)# switchport autostate exclude
Switch(config)# interface gigabitethernet 0/1
Switch# show interface gigabitethernet0/1 switchport
Name: Gi0/1
```

* http://www.cisco.com/en/US/docs/switches/lan/catalyst3560/software/release/15.0_2_se/command/reference/cli3.html

Note the last two lines: the box is *asked* with the long name and *answers* with `Gi0/1`. The long name
is input, the short name is output - which is exactly the split this console had backwards.

## A vendor whose abbreviation is not `gi` shows why the fold is onto the TYPE

Huawei's S-series guides type the full word, with a space, and then call the same port `GE0/0/1` in the
task text:

```
[SwitchA] interface gigabitethernet 0/0/1
[SwitchA-GigabitEthernet0/0/1] port link-type trunk
[SwitchA-GigabitEthernet0/0/1] port trunk allow-pass vlan 2 to 20
```

* https://support.huawei.com/enterprise/en/doc/EDOC1000069520/caf9e783/typical-examples-of-mstp-rrpp-sep-vbst
* https://support.huawei.com/enterprise/en/doc/EDOC1000069520/6946084b/typical-dhcp-configuration

The catalogue stores that box's ports as `GE0/0/1`. A rule that rewrote the long name to Cisco's `gi`
would still refuse `interface GigabitEthernet0/0/1` on it, so the table folds every spelling onto the
**type** (`gigabitethernet`) and lets the device's own spelling be whatever the catalogue says.

## What was changed

`engine/iface-name.js` gains `TYPE_SPELLINGS` (type → the spellings vendors print for it) and
`foldInterfaceType()`, called at the end of `portKey()`, so every consumer - `interface`, `show
interfaces`, `device.addSubinterface()`, `Topology.connect()` and saved labs - folds through one door.
A name the table does not know passes through untouched: `SFP+1` and `SFP1` stay two ports, `sfp28-1`
is not rewritten, and `Port 1` on a UniFi box is not reachable as `Po1` (asserted).

The known cost, stated because it is real: folding onto the type means a spelling one vendor uses is
accepted on another vendor's box for the same type - `interface Gi0/0/1` now resolves on a VRP device
whose own abbreviation is `GE`. The alternative, a per-vendor abbreviation set, needs the vendor at the
moment the key is computed, and `portKey()` is deliberately device-free (it is also what a saved lab's
link names are folded with). Refusing the word an operator typed in order to protect a vendor boundary
seemed the worse error.

## Partial spellings: settled (2026-11-17)

This note left one question open in its first draft: `Gig1/0/1` and `g1/0/1` were refused, although a
Cisco guide types `show interfaces g0/0`. It asked for a transcript of `interface ?` on one platform
to say which keywords the box accepts. That transcript turned out not to be needed, because the
answer is not specific to interface names - the type word is a *keyword*, and IOS states the rule for
every keyword it parses:

> You can abbreviate commands and keywords to the number of characters that allow a unique
> abbreviation. For example, you can abbreviate the **configure terminal** command to **config t**.
> Because the abbreviated form of the command is unique, the router will accept the abbreviated form
> and execute the command.

* Cisco IOS Configuration Fundamentals, *Using the Cisco IOS Command-Line Interface* (12.2SX) -
  https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/configuration/12-2sx/cf-12-2sx-book/Using_the_Cisco_IOS_Command-Line_Interface.html

Two vendor transcripts show the rule reaching the interface type, at the shortest possible prefix -
one letter:

```
Router(config)# interface g 0/1/0
Router(config-if)# switchport access vlan 4
```

> Use the **show run interface g0/1/0**, **show interface g0/1/0**, and **show vlan** commands to
> verify the configuration.

* Cisco Embedded Service 6300 Series Software Configuration Guide, *Configuring Ethernet Switch Ports* -
  https://cisco.com/c/en/us/td/docs/IIOT/routers/embedded/6300/software/config/b_ESR6300_config/b_ESR6300_config_chapter_01111.html
  (the same page writes the type out in full elsewhere - `interface GigabitEthernet0/1/0` - so the
  shortened form is the operator's, not a typesetting accident)

```
Switch(config)# interface g0/12
Switch(config-if)# switchport mode access
Switch(config-if)# dot1x port-control auto
```

* Cisco support community, *Port-Security for mobile devices as laptops* -
  https://community.cisco.com/t5/physical-security/port-security-for-mobile-devices-as-laptops/td-p/3774460
  (Catalyst 6500, and `show dot1x interface g0/12` in the same paste)

`g` is one character, so every longer prefix of the same word - `gi`, `gig`, `gigabit` - is accepted on
the same rule; that is what the rule means.

**What the rule needs that a table cannot supply is uniqueness**, and this is why the first draft was
right to refuse to guess: `g` is unambiguous on a box whose only G-type is GigabitEthernet, and `t` is
ambiguous on a box carrying both TenGigabitEthernet and TwentyFiveGigE. So the expansion is done at
resolution time, against the types the device in front of the caller actually has, and only when
exactly one of them matches:

* a prefix that matches one type expands (`g1/0/1` -> `Gi1/0/1` on a 2960-X, `f0/1` -> `Fa0/1` and
  `s0/0/0` -> `Se0/0/0` on a 2811);
* a prefix that matches two types resolves to neither;
* a prefix that matches no type the device carries is refused as it was before (`f1/0/1` on a
  2960-X, which has no fastethernet port);
* the space form is the same command (`interface g 1/0/2`), and a subinterface takes it too
  (`interface g1/0/24.10` creates `Gi1/0/24.10`);
* it is done in `resolvePortName()` and **not** in `portKey()`: the key is device-free (saved labs are
  folded with it before any device exists), and a prefix rule there would reach names the table never
  knew - `p1` would find a UniFi `Port 1`, which the table promises not to do. Only a type already in
  `TYPE_SPELLINGS` can be reached this way, and only through a device.

`engine/iface-name.js` carries `expandTypePrefix()` for this, and `test/iface-type-prefix.test.js`
holds the rule; `test/iface-type-spelling.test.js` no longer asserts that `Gig1/0/1` is refused.

## Unresolved, and what would settle it

* **Types the table does not carry**: `TFGigabitEthernet` (Cisco 400G), `XGigabitEthernet` and `xge`
  (VRP 10G), `mge`, `hsgmii`, PON and DSL types. Each needs its vendor's own statement of the
  abbreviation before it is added; guessing would let `xge0/0/1` resolve to something it is not.
* **Whether `show running-config` should print the full name.** A real box prints `interface
  GigabitEthernet1/0/1`; this console prints the panel spelling `interface Gi1/0/1`. Both now resolve, so
  the round trip holds either way, and changing what the config prints is a separate question (it would
  touch every running-config test) rather than a consequence of this one.
* **Which types a box without the port will still accept.** IOS answers `interface g0/1` on a box whose
  ports are all fastethernet with `% Invalid input detected`, not with a prefix error, so the type is
  parsed before it is resolved; this console refuses the name and names it. A transcript of that one
  line would settle whether the refusal should read differently.
