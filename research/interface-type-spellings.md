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

## Unresolved, and what would settle it

* **Partial spellings.** `Gig1/0/1` and `g1/0/1` are still refused. IOS abbreviates any keyword to a
  unique prefix, and one Cisco guide types `show interfaces g0/0`
  (https://www.cisco.com/c/en/us/td/docs/routers/7300/install_and_upgrade/7301/7301_install_config_guide/7301icg/5418c.html),
  so single letters do work there. A prefix rule cannot be written table-free: which prefixes stay unique
  is per command, and a naive rule starts matching panel names (`Port 1`). Settling it needs a transcript
  of `show interfaces ?` / `interface ?` on one platform, showing the accepted keywords.
* **Types the table does not carry**: `TFGigabitEthernet` (Cisco 400G), `XGigabitEthernet` and `xge`
  (VRP 10G), `mge`, `hsgmii`, PON and DSL types. Each needs its vendor's own statement of the
  abbreviation before it is added; guessing would let `xge0/0/1` resolve to something it is not.
* **Whether `show running-config` should print the full name.** A real box prints `interface
  GigabitEthernet1/0/1`; this console prints the panel spelling `interface Gi1/0/1`. Both now resolve, so
  the round trip holds either way, and changing what the config prints is a separate question (it would
  touch every running-config test) rather than a consequence of this one.
