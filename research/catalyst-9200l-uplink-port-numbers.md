# A Catalyst 9200L's fixed uplinks: `Gi1/0/25`, or `Gi1/1/1`?

**Question (one, narrow).** A 24-port Catalyst 9200L has 24 copper downlinks and four fixed SFP/SFP+ cages. What
does the box call those four cages - `Te1/0/25`-`Te1/0/28`, continuing the downlink group and its numbering, or
`Te1/1/1`-`Te1/1/4`, in a separate module that starts again at 1? And the same for the 48-port models (49-52
against 1/1/1-4) and the 2x25G models.

**Verdict: module 1, restarting at 1.** The uplinks are not in the downlink group at all. Cisco's Catalyst 9200
interface guide states the rule in the section that defines what a port number means, a real C9200L-24P-4G
prints `Gi1/1/1` and `Gi1/1/2` for its cages in `show inventory`, and a published C9200L-24PXG-4X `show
inventory` prints `Te1/1/1` and `Te1/1/2`. All fourteen C9200L specs in this catalogue said the other thing, so
every one of them was wrong in the same way - see "What changed".

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 9200 Interface and Hardware Components Configuration Guide, 17.14, "Interface Types"](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-14/configuration_guide/int_hw/b_1714_int_and_hw_9200_cg/configuring_interface_characteristics.html) | The decisive rule, and it names both port types: "**Module number:** the module or slot number on the device: switch (downlink) ports are 0, and uplink ports are 1. On a device with SFP uplink ports, the module number is 1 and the port numbers restart. For example, if the device has 24 10/100/1000 ports, the SFP module ports are `GigabitEthernet1/1/1` through `GigabitEthernet1/1/4` or `TenGigabitEthernet1/1/1` through `TenGigabitEthernet1/1/4`." The example is exactly this chassis: 24 copper ports, four cages. |
| [Cisco community thread, "WLC9800-L-F Tengiga ports not working"](https://community.cisco.com/t5/wireless/wlc9800-l-f-tengiga-ports-not-working/m-p/4619552) | A real chassis doing it: `show inventory` on `C9200L-24P-4G` (IOS XE 17.3.3) lists `NAME: "Gi1/1/1", DESCR: "1000BaseSX SFP" PID: GLC-SX-MMD` and `Gi1/1/2` beside it, and `show run int g1/1/1` shows a trunk built on it - so the 1G cages are `Gi1/1/x`, not `Gi1/0/25`. |
| [orb-agent, `test_driver.py`, the `fixed_uplink_chassis_no_fru_row` fixture](https://github.com/netboxlabs/orb-agent/blob/a9addddb/orb-discovery/device-discovery/tests/custom_drivers/cisco_ios/test_driver.py) | An independent codebase encoding the same fact for the 10G case: "A C9200L-24PXG-4X has FIXED 10G uplinks: Cisco numbers them `Te1/1/x` (second segment 1, not the baseboard 0) but ships no `FRU Uplink Module` row, because there is no removable module." Its `show inventory` fixture for that model carries `Te1/1/1` and `Te1/1/2` with `SFP-10G-SR`. |
| [Catalyst 9200 StackWise-80 white paper (PDF)](http://cisco.com/c/en/us/products/collateral/switches/catalyst-9200-series-switches/nb-06-stackwise-cat9200-series-wp-cte-en.pdf) | "The port numbers of the member switches begin with the switch number, such as `Gig1/0/1`, `Te1/1/1`, or `TwentyFiveGigE1/1/1`, depending on whether the ports are Gigabit Ethernet (GE), 10 GE, or 25 GE." Names the three spellings and puts the 10G and 25G ports in module 1. |
| [Catalyst 2960-X command reference, `show vlan`](https://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_5_e/command_reference/b_1525e_consolidated_2960x_cr/b_1525e_consolidated_2960x_cr_chapter_01100.html) | The contrast that makes the mistake look reasonable: Cisco's own 2960-X sample lists `Gi1/0/23` ... `Gi1/0/28` in one group, i.e. on that platform the SFP uplinks really do continue the downlink numbering past port 24. This catalogue's `C2960X-24TS-L` says `Gi1/0/25`-`Gi1/0/28`, and that is right. |

## What the catalogue said, and what changed

`devices/cisco/c9200l-*.json` - fourteen specs - carried the 2960-X convention:

| Family | Was | Is |
| --- | --- | --- |
| 24-port 4G (`24P-4G`, `24T-4G`) | `Gi1/0/25`-`Gi1/0/28` | `Gi1/1/1`-`Gi1/1/4` |
| 24-port 4X (`24P-4X`, `24T-4X`, `24PXG-4X`) | `Te1/0/25`-`Te1/0/28` | `Te1/1/1`-`Te1/1/4` |
| 48-port 4G (`48P-4G`, `48PL-4G`, `48T-4G`) | `Gi1/0/49`-`Gi1/0/52` | `Gi1/1/1`-`Gi1/1/4` |
| 48-port 4X (`48P-4X`, `48PL-4X`, `48PXG-4X`, `48T-4X`) | `Te1/0/49`-`Te1/0/52` | `Te1/1/1`-`Te1/1/4` |
| 2-port 25G (`24PXG-2Y`, `48PXG-2Y`) | `Twe1/0/25`-`26` / `Twe1/0/49`-`50` | `Twe1/1/1`-`Twe1/1/2` |

Not a single port was added or dropped - the port counts (28, 52, 26, 50) are unchanged - and each file gained a
note carrying the quotation and the transcript. `test/c9200l-uplink-numbering.test.js` pins the rule over all
fourteen specs, the type word per family, the contrast with the 2960-X and the 9300 (whose network-module ports
were already `1/1/x`), and four console consequences on a C9200L-24P-4X: `show interfaces Te1/1/1` answers about
that cage, `show interfaces Te1/0/25` is refused, `show ip interface brief` holds 28 rows with `Te1/1/1` among
them, and `show interfaces Te1/1/1` on a 4G model is refused because it has no 10G cage.

The visible defect this fixes is not cosmetic: `show ip interface brief` on a 48-port 9200L claimed `Gi1/0/49`
was a copper downlink, and `interface Te1/1/1` - the name in Cisco's own guide - was answered
`% No interface Te1/1/1`, i.e. the simulator told a reader that the vendor's port name did not exist.

## What is inferred, and what is unresolved

**Inferred.** The 25G spelling. No `show inventory` or `show interfaces status` from a `-2Y` chassis was found;
the module-1 rule plus the white paper's `TwentyFiveGigE1/1/1` example makes `Twe1/1/1`-`Twe1/1/2` the only
consistent answer, but it is an application of the rule, not a transcript.

**Unresolved - the silkscreen.** Where the CLI says `1/1/1`, what does the front panel print next to that cage?
This matters for the drawn faceplate, which labels a connector group from its port names (so these four cages now
print `1`, `2`, `3`, `4`). On a 2960-X the panel and the CLI agree (`25`-`28`); on a 9300 Cisco's photographs
show the cages in their own numbered group. No 9200L front-panel photograph or hardware guide plate was checked
in this run, so whether the 9200L silkscreen reads `1`-`4` or `25`-`28` is open.

**Unresolved - the neighbours.** The catalogue's `C1000`, `C1200`-era and `C1300` models also declare their
uplinks as `Gi1/0/25`-`28`. Those are IOS XE platforms of the same generation, and *not* re-checked here: the
9200 rule is a statement about the 9200 family, and folding a small-business platform onto it without a source
would be the same mistake in the other direction.

**What would settle them.** A `show inventory` (or `show interfaces status`) from a C9200L-24PXG-2Y for the 25G
spelling, the same from a C1000-24T-4G for the neighbours, and a straight-on photograph of a C9200L-24P-4X front
panel for the silkscreen.
