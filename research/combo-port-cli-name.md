# The two halves of a combo port: one interface on the box, two names in this console

**Question (one, narrow).** On a Catalyst 1000-8P-2G-L (and the other small Catalysts that sell a
"combo" uplink), what does IOS call the SFP/RJ-45 combo uplink: **one interface name** or two - and
what does PacketForge print in `show ip interface brief`, `show vlan brief` and `show running-config`?

**Verdict: the box has one interface with two front ends; this console has two interfaces with two
names, and prints the second one.** IOS treats the combo position as *a single interface with dual
front ends* and gives the operator exactly one knob for the pair, `media-type {auto-select | rj45 |
sfp}`. PacketForge stores the pair as two interfaces that name each other
(`docs/CONNECTORS.md` §4.5) and prints both, so a C1000-8P-2G-L answers `show ip interface brief` with
`GigabitEthernet1/0/9` **and** `Gi1/0/9-sfp` - a name no Cisco box prints, in a spelling that does not
even match the row above it. **No engine code was changed this run**: the printed name is the visible
edge of the storage decision, and the ways to fix it are a model choice with different costs (below),
not a wording correction. The note records the vendor sentence, the measured defect, the census of
what carries it, and what the choice needs before code moves.

## What the vendor says

**1. The Catalyst 1000's own configuration guide, IOS 15.2(7)Ex, "Configuring Interface
Characteristics"** -
<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst1000/software/releases/15_2_7_e/configuration_guides/int_hw/b_1527e_int_and_hw_c1000_cg.pdf>

> Catalyst switches support dual-purpose uplink ports. **Each uplink port is considered as a single
> interface with dual front ends** - an RJ-45 connector and an SFP module connector. The dual front
> ends are not redundant interfaces, and the switch activates only one connector of the pair. ...
> you can use the `media-type` interface configuration command to manually select the RJ-45 connector
> or the SFP module connector.

**2. The 8-port and 16-port Hardware Installation Guide, "Product Overview"** -
<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst1000/hardware/installation/8_16_port_hig/b_c1000_8_16_hig/product_overview.html>

The 8-port PoE chassis's front-panel legend reads item 6 = "**Combo ports (2 GE Copper ports and 2 SFP
module ports)**", and the port table under it names them `GigabitEthernet1/0/9` and
`GigabitEthernet1/0/10` - **one line each**. The 16-port's table names `GigabitEthernet1/0/17` and
`.../18` and its legend says "SFP module slots", because the 16-port is SFP-only.

**3. The Catalyst 1000 Series data sheet** -
<https://www.cisco.com/c/en/us/products/collateral/switches/catalyst-1000-series-switches/nb-06-cat1k-ser-switch-ds-cte-en.html>

The uplink column separates the two families: all six 8-port SKUs read "**2 SFP/RJ-45 combo**", while
`C1000-16T-2G-L` reads "2 SFP" and the 24- and 48-port rows read "4 SFP". So "combo" is an 8-port-model
feature, and the catalogue is right to declare it on exactly the two 8-port PoE specs it holds.

**4. The same rule on the older family: Catalyst 2960 Software Configuration Guide 12.2(37)EY** -
<http://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_37_ey/configuration/guide/scg/swint.html>

> **Each uplink port is considered as a single interface with dual front ends** ... `media-type
> {auto-select | rj45 | sfp}` ... `auto-select` ... when link up is achieved, the switch disables the
> other type until the active link goes down.

So the pair is one port whose medium is a *state*, not two ports.

**5. The same construction on the Catalyst 1300 8-port** (reseller-hosted datasheet PDF, so secondary) -
<https://www.router-switch.com/pdf/cis-c1300-8p-e-2g-datasheet.pdf>

> 2 x Gigabit copper/SFP combo ports ... **Total System Ports 10 x Gigabit Ethernet** ... Each combo
> port has one copper Ethernet port and one SFP slot, with one port active at a time.

Ten ports, ten interface names - not twelve.

What the evidence does **not** say: how a box prints the pair when the optic is absent, and whether
speed/duplex settings are stored per front end or per port. Both are marked unresolved at the end.

## What PacketForge does today

Measured in this worktree on `c2503da8`, `cisco/C1000-8P-2G-L`, nothing configured:

```
SW#show ip interface brief
Interface              IP-Address      OK? Method Status                Protocol
GigabitEthernet1/0/1   unassigned      YES unset  down                  down
...
GigabitEthernet1/0/9   unassigned      YES unset  down                  down
Gi1/0/9-sfp            unassigned      YES unset  down                  down
GigabitEthernet1/0/10  unassigned      YES unset  down                  down
Gi1/0/10-sfp           unassigned      YES unset  down                  down
```

Four defects are visible in those four rows:

1. **A name the box has no interface for.** `Gi1/0/9-sfp` is this catalogue's key (`comboWith` /
   `comboRole`, `docs/CONNECTORS.md` §4.5), not a Cisco name. The vendor's port table for this chassis
   lists `GigabitEthernet1/0/9` and `GigabitEthernet1/0/10` and nothing else.
2. **The column does not line up**, because the invented name is not one the printer can expand to
   its long form: ten rows spell the port out and two spell it short, in the same table.
3. **The physical position appears twice** - ten positions, twelve rows.
4. **The two halves are separate Layer 2 ports.** After `interface Gi1/0/9-sfp` /
   `switchport access vlan 20`, `show vlan brief` puts the *same combo position* in two VLANs at once:

```
1    default                          active    Gi1/0/1, Gi1/0/2, Gi1/0/3
                                                ...
                                                Gi1/0/10, Gi1/0/10-sfp
20   VLAN0020                         active    Gi1/0/9-sfp
```

Cabled, the defect stops being cosmetic. Fibre into the SFP half, a link between two of these
chassis:

```
SW1#show interfaces GigabitEthernet1/0/9
Gi1/0/9 (ethernet, 1G), MAC 0200.0000.0008
  status: down (no cable), protocol: down
SW1#show ip interface brief
GigabitEthernet1/0/9   unassigned      YES unset  down                  down
Gi1/0/9-sfp            unassigned      YES unset  up                    up
```

So the one name the hardware guide gives the operator - `GigabitEthernet1/0/9` - reports the port dead
while it carries traffic, and `show spanning-tree` files the working link under `Gi1/0/9-sfp`. The
pair also holds **two MAC addresses** (`0200.0000.0008` / `0200.0000.0009`); on the box one interface
has one. And the vendor's only per-front-end knob is missing: `media-type rj45` in interface mode
answers `% Unrecognized interface command: media-type rj45`.

## How many specs carry it

Counted over `devices/**/*.json` in this worktree: **39 specs declare combo halves**, **228 half
entries** (114 pairs), across **18 vendors**; **37 of the 39** are CLI-bearing, so the printed names
reach a console. The second half's name is the first half's plus a suffix in nearly every spec: `-sfp`
on 108 halves, `-SFP` on 2 (`netgate`), and 4 where the vendor really does name the two front ends
differently (`fortinet` `wan1`/`sfp1`, `wan2`/`sfp2`).

The six Cisco specs are `C1000-8P-2G-L` and `C1000-8FP-2G-L` (two pairs each), `C1300-8FP-2G`,
`C1300-8P-E-2G` and `C1300-8T-E-2G` (two pairs each) and the `ISR 4331` (three pairs: `Gi0/0/0`-`2`
plus their `-sfp` twins). All six are IOS switches or routers of the same construction, and the
vendor's sentence covers all of them.

## Why nothing was changed this run

The evidence is not thin - it is the vendor contradicting the model in one sentence, on three
platform families. What is unresolved is the **choice**, because the storage decision is load-bearing
elsewhere: `Topology.validateLink` refuses a cable in the sibling half with `E_COMBO_OCCUPIED`, and
the panel draws two sockets so an SFP cage and an RJ-45 socket can each be cabled. Three fixes, with
different blast radii:

1. **Print one name, keep two keys.** Cheapest, and it fixes defects 1-3: the brief table and
   `show running-config` would print `GigabitEthernet1/0/9` once, and the `-sfp` key stays a
   panel/API detail. It leaves defect 4 - the halves still hold independent VLAN and STP state - and
   `interface Gi1/0/9-sfp` would still take a name the box does not have. Not enough on its own.
2. **Share the Layer 2 state.** Mirror every switchport setting onto the sibling, which is what "one
   interface" means for VLAN, mode, trunk list, voice VLAN, ACL and STP. Cheap to write, but it has to
   be applied at every command that writes that state rather than at one funnel, and a miss shows up
   as a silently half-configured port.
3. **Model the vendor's object.** One interface with a `media` state and a per-front-end PHY override,
   `media-type` on the CLI, the panel drawing two connectors for one port. This is the honest model
   and the largest change: 39 specs, the cable rules, the panel, the round-trip test, and every test
   that counts rows.

Choosing between 2 and 3 is what "one interface with dual front ends" costs here, and it is a design
decision rather than a research result, so it was not taken inside a fidelity increment. Option 1
alone would put a tidy table over an L2 split that is the more damaging of the two defects.

## What is unresolved, and what would settle it

* **What a real `show ip interface brief` prints for this chassis.** Ten rows is the inference from
  the hardware guide's port table; one command on a `C1000-8P-2G-L` turns it into fact. Same for
  `show running-config` - one `interface GigabitEthernet1/0/9` stanza, or one per front end.
* **What `show interfaces GigabitEthernet1/0/9` prints with an empty cage and with an optic in it.**
  The `media-type` sentence says the switch "activates only one connector of the pair", but no sample
  in hand shows the `Media type is ...` line for the empty case, which is what a simulator would have
  to print instead of `speed: 1Gb/s (auto)`.
* **Whether speed and duplex are per front end or per port.** Under `auto-select` the front ends
  negotiate differently (copper negotiates; a 1000BASE-X optic does not), which suggests the box keeps
  PHY state per front end while keeping L2 state per port - i.e. the current two-object model is
  *half* right. A `show run all`, or a `media-type` capture from a box with both front ends exercised,
  would settle which half.
* **Whether any vendor in the census really exposes two names.** D-Link, PLANET and Zyxel web UIs
  sometimes list a combo position as `25` and `25SFP`; a CLI transcript from one of them would show
  whether the `-sfp` convention happens to be right for those specs even though it is wrong for Cisco.

## What changed

* This note - the vendor sentence, the measured defect, the census of 39 specs, and the three options.
* `docs/CONNECTORS.md` §4.5: a caution that the second half's name is printed verbatim by the console
  and is **not** a vendor name on the Cisco specs, pointing here, so an operator reading `Gi1/0/9-sfp`
  does not go looking for it on the box.
