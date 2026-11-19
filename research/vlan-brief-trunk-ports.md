# `show vlan brief`: does a trunk port appear in the VLANs it carries?

**Question (one, narrow).** On a Cisco-style access switch, `show vlan brief` prints one row per VLAN with a
Ports column. **A trunk port carries every VLAN in its allowed list. Is it listed in those rows?**

**Verdict: no.** The Ports column is access membership. A trunk port is in no row at all, and a VLAN that
nothing but a trunk's allowed list names has no row either, because it was never created. PacketForge listed
trunks in every VLAN they carry and invented rows for VLANs absent from its own VLAN database. Changed.

## The device's own words

Cisco's LAN Switching Command Reference, `show vlan`, Usage Guidelines
(https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/lanswitch/command/lsw-cr-book/lsw-s2.html):

> When displaying a single VLAN both trunk and non-trunk ports are displayed. A non-trunk port is a port that
> is not configured as pm_port_mode_trunk. If an interface is configured as "switchport port mode trunk" it is
> displayed whether the link is up or down. **When displaying multiple VLANs only non-trunk ports are
> displayed.**

`show vlan` and `show vlan brief` are the multi-VLAN form - one line per VLAN for the whole database - so the
last sentence governs this console's table. The same page documents `show vlan all-ports` as a separate
command: "To display VLAN information for trunk and access ports". A command that exists only to add trunks
is proof that the default view leaves them out.

Corroboration from Cisco's support knowledge base, "Ports assigned to VLAN do not show up in the show vlan
command output"
(https://community.cisco.com/t5/networking-knowledge-base/ports-assigned-to-vlan-do-not-show-up-in-the-quot-show-vlan-quot/ta-p/3131935):

> This is a normal behaviour as trunk ports are part of multiple VLANS, not just a single VLAN. Any port
> configured for **access vlan** shows up under **show vlan**. Trunk ports never show up under any VLANs.
> ... Trunk ports that are **connected** to other device do not appear in the output of the **show vlan**
> command. ... Ports on an EtherChannel do not show up in the **show vlan** command output.

| Source | Says |
| --- | --- |
| LAN Switching Command Reference, `show vlan` | multi-VLAN view: only non-trunk ports; `all-ports` exists for trunks |
| Cisco support KB, "Ports assigned to VLAN do not show up" | "Trunk ports never show up under any VLANs"; EtherChannel members too |
| itpracticeexams, "Reading show vlan brief" (https://itpracticeexams.com/kb/ccna/cisco-vlan-configuration/) | "The Ports column lists interfaces whose *access* VLAN is that VLAN ... trunks are omitted from this output entirely"; a shut access port is still printed |
| CFWorx 802.1Q trunking notes (https://cfworx.tech/notes/networking/ccna/cisco-u/8021q-trunking/) | "trunk ports do not appear in show vlan brief port listings" |
| nextwork.ai static-routing lab (https://nextwork.ai/projects/4fd633b2-52bc-44e4-a971-540dfbd5cd9c) | "Trunk ports do not appear in the show vlan brief output. Only access ports are listed" |

## What is known

1. The Ports cell is access membership. A port configured `switchport mode trunk` is never printed in it, up
   or down - the command reference says so explicitly, and it is why `show vlan all-ports` and
   `show interfaces trunk` exist.
2. The row set is the VLAN database. A trunk's `allowed vlan` list may name a VLAN that does not exist; the
   switch accepts the list, creates nothing, and prints no row for it.
3. A shut access port is still printed under its access VLAN (itpracticeexams, and the command reference's own
   samples show ports regardless of link state). PacketForge already behaved this way.

## What is inferred

1. **Administrative mode decides, not operational mode.** The command reference keys the rule to "configured
   as switchport mode trunk" and says such a port is displayed "whether the link is up or down", so the test
   is the configuration. PacketForge's `vlan.mode === 'trunk'` is exactly that flag.
2. **EtherChannel members are also left out.** One Cisco KB sentence says so; PacketForge does not apply it
   yet (a bundled member keeps its own access VLAN and can still appear). A second rule, a second question,
   now worked in `research/show-vlan-brief-etherchannel.md`: the IOS sample in hand names `Po1` in the cell,
   but no capture shows the members' absence, so the engine is unchanged.

## The one contradiction

The same Cisco KB adds: "Trunk ports that are **not connected** appear by default in vlan 1 and also appear in
the output of the **show vlan**." That describes a port that has not trunked yet - the default `dynamic auto`
state, which is an access port until DTP negotiates - and it disagrees with the command reference's flat "only
non-trunk ports" for a port already configured as a trunk. PacketForge models `switchport mode trunk` as
unconditional, so this run follows the command reference and leaves the unconnected case unresolved.

## What PacketForge printed before, and what it prints now

Before (trunk on Fa0/1, access ports on Fa0/2 and Fa0/3):

```
VLAN Name                             Status    Ports
---- -------------------------------- --------- -------------------------------
1    default                          active    Fa0/1, Fa0/4, Fa0/5, ...
10   SERVERS                          active    Fa0/1, Fa0/2
20   VLAN0020                         active    Fa0/1, Fa0/3
```

The trunk was a member of three VLANs at once - the thing the device's own KB says never happens.

Worse, with no VLAN created at all:

```
s1(config-if)# switchport trunk allowed vlan 20,30
s1# show vlan brief
1    default    active    Fa0/1, Fa0/3, ...
20   VLAN0020   active    Fa0/2
30   VLAN0030   active    Fa0/2
```

Rows for VLANs 20 and 30, which the engine's own `config.vlans` did not contain. The table was built from the
trunk's allowed list, so it described a VLAN database the box did not have.

Now:

```
VLAN Name                             Status    Ports
---- -------------------------------- --------- -------------------------------
1    default                          active    Fa0/4, Fa0/5, Fa0/6, Fa0/7, Fa0/8
10   SERVERS                          active    Fa0/2
20   VLAN0020                         active    Fa0/3
1002 fddi-default                     act/unsup
```

## What changed

* `engine/cli.js`, `show vlan` / `show vlan brief`: the row set is the VLAN database (VLAN 1, configured
  VLANs, VLANs created by an access assignment, the four reserved defaults) - no longer every allowed and
  native VLAN of every trunk; and the Ports cell skips ports whose mode is `trunk`.
* `test/show-vlan.test.js`: the membership section now asserts the vendor's rule instead of the data plane's.
  The old section asserted that the table and `classifyEgress()` agreed for every port and VLAN, which is what
  made a trunk a member of everything it forwards. The new one asserts listed iff access port belonging to the
  VLAN, plus a lab where a trunk's allowed list names two VLANs nobody created and neither gets a row.
* `test/trunk-allowed-add-remove.test.js`: its `show vlan brief` check expected the trunk to be listed under
  the VLANs its allowed list names; it now expects no rows for non-existent VLANs and no trunk in any row.
* `docs/CLI.md`: the `show vlan` row says access ports, and says a trunk is in no row.

`classifyEgress()` is untouched: it is still the forwarding rule, and the data plane still sends every VLAN a
trunk allows. The two answers differ because the questions do.

## What remains unresolved

1. **Unconnected trunks** (above): the KB says VLAN 1 lists them; the command reference says non-trunk ports
   only. One `show vlan brief` from a switch with `switchport mode trunk` on an unpatched port would settle it.
2. **EtherChannel members**: one KB sentence says bundled ports do not appear. PacketForge lists a member's
   access VLAN. `research/show-vlan-brief-etherchannel.md` gathers the IOS/NX-OS samples and the exact
   command set that would settle it; no capture in hand shows an IOS access bundle's cell, so the engine is
   unchanged.
3. **`show vlan id <n>`**: the single-VLAN form does list trunk ports per the command reference, and this
   console refuses that argument rather than printing it. Adopting the single-VLAN form is a new command, not a
   fidelity fix, so it was not added here.
