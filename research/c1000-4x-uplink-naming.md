# A Catalyst 1000's SFP+ cages: `Gi1/0/25`, or `Te1/0/1`?

**Question (one, narrow).** A Catalyst 1000 with 24 copper ports and four SFP+ cages is sold as a `-4X` model,
and the same chassis with four 1G SFP cages is the `-4G` model. The 1G cages are `Gi1/0/25`-`Gi1/0/28` - the
downlink group continued. What does the CLI of the **10G** model call its four cages: the same names, or
`Te1/0/1`-`Te1/0/4`? And, since the catalogue's 8- and 16-port Catalysts are in the same family, what are theirs?

**Verdict: `Te1/0/1`-`Te1/0/4`.** On a 10G Catalyst 1000 the four cages are `TenGigabitEthernet1/0/1` through
`TenGigabitEthernet1/0/4`: module 0 (not module 1 as on a 9200L), and the port numbers restart at 1 rather than
continuing the copper group. The 1G models keep the continued numbering - `Gi1/0/9`-`10` on an 8-port,
`Gi1/0/17`-`18` on a 16-port, `Gi1/0/25`-`28` and `Gi1/0/49`-`52` on the 24- and 48-port - which is what the
catalogue already said for all of them. The one `-4X` spec in the catalogue said `Gi1/0/25`-`Gi1/0/28`, so it
described a 10-gigabit cage with a GigabitEthernet name and refused the name the vendor's own guide prints.

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 1000 24-Port and 48-Port Hardware Installation Guide, "Product Overview", Tables 3 and 4](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst1000/hardware/installation/24_48_port_hig/b_c1000_24_48_hig/product_overview.html) | The port-mapping tables for the 24-port and 48-port models, each row pairing one cage's two names: `GigabitEthernet1/0/25` with `TenGigabitEthernet1/0/1`, .../26 with .../2, .../27 with .../3, `GigabitEthernet1/0/28` with `TenGigabitEthernet1/0/4`; and for the 48-port `.../49`-`.../52` with `TenGigabitEthernet1/0/1`-`.../4`. The note under the table calls them "the mapped ports": a 10G module in a 1G slot "or vice versa" needs `default-interface` run on the mapped port before it carries traffic. So the 10G cage is named `TenGigabitEthernet1/0/1`-`4` on both chassis sizes - restarting at 1, in module 0. |
| [Catalyst 1000 8-Port and 16-Port Hardware Installation Guide, "Product Overview", Tables 2 and 3](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst1000/hardware/installation/8_16_port_hig/b_c1000_8_16_hig/product_overview.html) | The same table for the small models: `GigabitEthernet1/0/9` and `GigabitEthernet1/0/10` on an 8-port, `GigabitEthernet1/0/17` and `GigabitEthernet1/0/18` on a 16-port. No 10G variant exists here, so there is nothing to rename - the cages continue the copper group. |
| [Single IP Management Configuration Guide, Cisco IOS Release 15.2(7)Ex (Catalyst 1000), PDF pp. 3, 16-18](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst1000/software/releases/15_2_7_e/configuration_guides/stacking/b_1527e_single_ip_management_c1000_cg.pdf) | The decisive transcript, and it covers every family in one document. The prose: "these uplink interfaces (for example, **10 Gigabit Ethernet 1/0/1 interface**) are not listed in the output of any show command". The 10-G examples of `show switch hstack-ports` list four rows: `Te1/0/1`, `Te1/0/2`, `Te1/0/3`, `Te1/0/4` - and the stacked example continues `Te2/0/1`-`Te2/0/4` on member 2. The 1-G example lists `Gi1/0/9`, `Gi1/0/10`, then `Gi1/0/25`-`28`, `Gi1/0/49`-`52`, `Gi6/0/17`-`18` for the 16-port members - i.e. the four continued-numbering families, unchanged. |
| [NetBox Data Exchange, Catalyst 1000-24P-4X-L](https://netboxlabs.com/ndx/cisco/cisco-c1000-24p-4x-l/) | An independent encoding of the same chassis: 24 `GigabitEthernet1/0/1`-`24` at 1000base-t, then `TenGigabitEthernet1/0/1`-`4` at 10gbase-x-sfpp, then `Vlan1`. Nothing named `Gi1/0/25`. |
| [Catalyst 9200 Interface and Hardware Components Configuration Guide, "Interface Types"](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-14/configuration_guide/int_hw/b_1714_int_and_hw_9200_cg/configuring_interface_characteristics.html) | The contrast that keeps this from becoming a global rule: on a 9200 the uplinks are "module 1 and the port numbers restart" (`Gi1/1/1`). A Catalyst 1000 restarts the numbers but stays in module 0, which is why the two families' cages cannot share a rule (research/catalyst-9200l-uplink-port-numbers.md). |

## What was wrong here, measured

One session on the catalogue's `C1000-24FP-4X-L`, before the change:

```
SW>show interfaces Te1/0/1
% No interface Te1/0/1 on Cisco Catalyst 1000 C1000-24FP-4X-L-SW
SW>show interfaces Gi1/0/25
Gi1/0/25 (ethernet, 10G), MAC 0200.0000.0018
  speed: 10Gb/s (auto), duplex: full
```

Two defects in two lines: the box said `GigabitEthernet` about a 10-gigabit cage, and it told the reader that
`Te1/0/1` - the name on Cisco's own 10-G pages for this switch - was not a port. `show ip interface brief` listed
28 rows ending `Gi1/0/25`-`Gi1/0/28`, so a lab built from that table cabled "fibre" ports with copper names.

The spec's own `notes` had half the fact already: it quoted the port-mapping table ("maps Gi1/0/25-28 to
Ten1/0/1-4") and read it as "Cisco renames the cage with the module" - true, but the rename is what the model
should carry, and it kept the 1G name.

## What changed

* `devices/cisco/c1000-24fp-4x-l.json` - the four cages are `Te1/0/1`-`Te1/0/4`. Nothing else moved: still 28
  ports, still `sfp+` at `10G`, still `speedCaps` 1000/10000 (the cages take a 1G module), still the same PoE
  and bandwidth figures. The `notes` sentence now quotes both names of the cage and the document that shows the
  CLI using the 10G one.
* `test/c1000-4x-uplink-naming.test.js` - 37 checks over all nine Catalyst 1000 specs: the rule per family
  (`Gi1/0/9-10`, `Gi1/0/17-18`, `Gi1/0/25-28`, `Gi1/0/49-52`, `Te1/0/1-4`), the cage count and media unchanged,
  `show interfaces Te1/0/1` and the long spelling `tengigabitethernet1/0/4` reaching the cage, the two old names
  refused in `show interfaces` and in `interface Gi1/0/25`, `show ip interface brief` holding 28 rows with
  `Te1/0/1` among them, `interface Te1/0/1` landing in `(config-if)#`, the 4G sibling and the 2960-X keeping
  `Gi1/0/25`-`28`, a 9200L keeping `Te1/1/1`-`1/4`, and a link from the corrected cage coming up. No engine code
  changed: the console already resolved `Te1/0/1` by type word, so only the catalogue was wrong.

## What is unresolved

* **The silkscreen.** What number is printed next to each cage on the front panel? The drawn faceplate labels a
  connector group from its port names, so these four now read `1`-`4`; Cisco's photographs of the 1G models
  (`25`-`28`) would suggest the 10G plate might read `1`-`4` too, since that is the name in the CLI, but no
  straight-on 4X photograph or hardware-guide plate was checked. A photograph would settle it.
* **Whether a 4X box also answers to `Gi1/0/25`.** Cisco calls the pair "mapped ports" rather than aliases, and
  the mapping exists so an operator moving a module between SKUs knows which interface to `default`. Whether
  `interface Gi1/0/25` on a 4X chassis is refused or silently maps is not shown by any document found here; this
  model refuses it, which is what a type-word-keyed lookup does. A transcript (or `show interfaces status` on a
  4X box) would settle it.
* **The 48-port 4X models** (`C1000-48T/P/FP-4X-L`) are not in the catalogue. Table 4 gives them
  `TenGigabitEthernet1/0/1`-`4` as well, so the same rule would apply, but it is untested here for want of a spec.
* **The `Type` column.** What `show interfaces status` prints for a 10G SFP+ cage in the `Type` column (and
  whether it says `10GBase-SR` from the module or a fixed string) is not modelled by this console and not
  settled here.
* **The small-business neighbours.** The 9200L note left the `C1200`/`C1300` uplink numbering open; those are
  different platforms with their own table and are still not re-checked.
