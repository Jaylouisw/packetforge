# The Juniper EX access switches: what the 48 "G" ports are, and which PIC the uplinks sit on

**Question (one, narrow).** Issue #1398 counts template ports whose connector nothing declares. Two
Juniper EX specs generated their access ports from a portTemplate that said only
`type: ethernet, speed: 1G` — EX3400-48T and EX4300-48T, 96 ports. Does Juniper state the physical port
for those models, does it train at 10 and 100 as well as 1000, and what are the uplinks?

**Verdict: both are 48 × 10/100/1000BASE-T on an RJ-45 jack, with a [10, 100, 1000] ladder.** Juniper
says it in one sentence per model, and the same documentation also settles two things these two specs
had wrong above the access ports:

* **EX4300-48T** declared its four *built-in* 40GbE QSFP+ ports as 10G SFP+ uplinks. The 40G ports are
  built in (PIC 1, rear panel); the 4 × 1/10GbE SFP+ ports are the *optional* front uplink module
  EX-UM-4X4SFP (PIC 2).
* **EX3400-48T** declared its four front-panel SFP+ uplinks on PIC 1 and its two rear QSFP+ ports on
  PIC 2 — the two PIC numbers the other way round. Junos lists the front uplinks as
  `ge-0/2/0-3` / `xe-0/2/0-3` and the rear QSFP+ pair as `et-0/1/0-1`.

## Evidence

| Source | Says |
| --- | --- |
| [EX3400 System Overview](https://www.juniper.net/documentation/us/en/hardware/ex3400/topics/topic-map/ex3400-system-overview.html) — "EX3400 Switches First View" | "Either 24 or 48 RJ-45 ports (labeled 0 through 23 or 0 through 47) that support 10/100/1000BASE-T Gigabit Ethernet connectors." Same page: "Four uplink ports (labeled 0 through 3 on the front panel) that support small form-factor pluggable (SFP) transceivers and small form-factor pluggable plus (SFP+) transceivers, and two 40-Gigabit Ethernet ports (labeled 0 through 1 on the rear panel) that support quad small form-factor pluggable plus (QSFP+) transceivers." |
| Same page — "Hardware and CLI Terminology Mapping" table | `4x GE SFP+` / **PIC 2** / "SFP+ uplink ports on the front panel of the switch"; `2x XE QSFP+` / **PIC 1** / "QSFP+ uplink ports on the rear panel of the switch"; `48x 10/100/1000 BASE-T` / PIC 0 / "RJ-45 ports on the front panel". |
| [Configuring Junos OS on the EX3400](https://www.juniper.net/documentation/us/en/hardware/ex3400/topics/topic-map/ex3400-configuring-junos-os.html) — default configuration | "The four uplink ports on the front panel of EX3400 switches are listed as ge-0/2/0 through ge-0/2/3 and xe-0/2/0 through xe-0/2/3." The factory configuration then lists `interface xe-0/2/0` … `xe-0/2/3` and `ge-0/2/0` … `ge-0/2/3` — the same four cages at 10G and at 1G. |
| [EX4300 System Overview](https://www.juniper.net/documentation/us/en/hardware/ex4300/topics/topic-map/ex4300-system-overview.html) — 48-port section and Table 3 | "The 48-port EX4300 switches EX4300-48T and EX4300-48P provide 48 built-in 10/100/1000BASE-T Ethernet network ports, with or without PoE+ depending on the switch model, and four built-in quad small form-factor pluggable plus (QSFP+) ports that can house 40-Gigabit QSFP+ transceivers." … "Each switch provides a slot for installing an optional 4-port 10-Gigabit Ethernet SFP+ uplink module (model number: EX-UM-4X4SFP), which has four SFP+ ports that can house four SFP+ transceivers, four SFP transceivers, or a combination of SFP and SFP+ transceivers." Table 3, EX4300-48T row: "48 10/100/1000BASE-T Ethernet ports and four QSFP+ ports", PoE-enabled ports "0". |
| [Understanding Interfaces (Junos OS)](https://www.juniper.net/documentation/us/en/software/junos/interfaces-fundamentals/interfaces-ethernet-switches/topics/topic-map/switches-interface-understanding.html) | "On EX4300 switches, the PIC number is 0 for built-in network ports, 1 for built-in QSFP+ ports (located on the rear panel of the switch), and 2 for uplink module ports." Same rule is stated for the EX3400 family on its own overview page (the PIC table above). |
| [EX4300 line datasheet (PDF)](https://www.juniper.net/content/dam/www/assets/datasheets/us/en/switches/ex4300-line-of-ethernet-switches-datasheet.pdf) | Port density: "48P/48T: 56 (48 host ports + four 40GbE ports + optional four-port 1/10GbE uplink module)"; "10GbE port density per system (all models): 4 (uplink module)"; "40GbE port density per system (all models): 4". |

"10/100/1000BASE-T" is three clauses, not one: 10BASE-T, 100BASE-TX and 1000BASE-T are the three media
the port negotiates and all three are defined over twisted pair with an RJ-45 plug (engine/media.js,
MEDIA rows `10base-t`, `100base-tx`, `1000base-t`, all `connector: rj45`). That is exactly
`CAGE_SPEEDS.rj45`, so the declared ladder and the cage agree without a special case.

## What was changed

| Spec | Access template | Uplinks |
| --- | --- | --- |
| devices/juniper/ex3400-48t.json | `connector: rj45`, `speedCaps: [10,100,1000]` (48 ports) | `xe-0/2/0-3` — SFP+ cage, `speedCaps: [1000, 10000]`; `et-0/1/0-1` — QSFP+ cage, `speedCaps: [40000]`. Names moved from the swapped `xe-0/1/x` / `et-0/2/x`. |
| devices/juniper/ex4300-48t.json | `connector: rj45`, `speedCaps: [10,100,1000]` (48 ports) | `et-0/1/0-3` — QSFP+ cage at 40G (was declared 10G SFP+); `xe-0/2/0-3` — the EX-UM-4X4SFP uplink module, SFP+ cage, `speedCaps: [1000, 10000]`. |

`test/juniper-ex-copper-ports.test.js` pins the family: the declaration, the expanded cage and ladder,
that a 1000BASE-T patch cord meets two access ports at 1G and that 100M and 10M are not refused, that
a fibre optic into an access port is refused as a connector mismatch, the SFP+/QSFP+ split on both
boxes, and that an EX3400 uplink links an EX4300 uplink over 10GBASE-SR. On the previous specs it fails
on the six declaration assertions (the ports themselves were already inferred RJ-45 — which is the
issue's point: silence cannot be contradicted).

## What is inferred, and what is left open

* That 10/100/1000BASE-T means an RJ-45 jack. The media table carries that itself — a BASE-T link does
  not exist on another connector — so this is the datasheet's sentence read through the engine's medium
  table, not a guess about the box.
* **EX4300-48T is modelled with the uplink module fitted** (56 ports: 48 copper + 4 QSFP+ + 4 SFP+).
  Juniper calls the module optional; the catalogue already modelled four 10G uplinks on this box before
  this change, and the datasheet's headline density for the 48T is the 56-port figure. The description
  says so in as many words. The alternative — 52 ports with only the built-in QSFP+ — would have
  *removed* a capability the spec already claimed, and modelling an empty module slot as four ports is
  worse than saying which configuration is modelled.
* **The EX3400 rename is a name change, not a cage change.** `xe-0/1/x` and `et-0/2/x` were the right
  cage at the right rate with the wrong PIC digit; Junos names those two groups `xe-0/2/x` and
  `et-0/1/x`. A saved topology that cabled the old names will need to point at the new ones.
* **Not modelled:** that the EX3400's two QSFP+ ports are Virtual Chassis ports by default (Juniper:
  "The QSFP+ uplink ports are configured as Virtual Chassis ports (VCPs) by default"), and that
  EX4300 QSFP+ ports are likewise VCPs by default. That is a default configuration, not a hardware
  fact, and the engine models ports as ports.
* **Not touched:** the EX4300's four QSFP+ ports can be channelized to `xe-0/1/x:0-3` in Junos. The
  engine has no channelized-interface model, so the port is one 40G QSFP+ cage.
* Neighbouring EX models are out of scope here: the catalogue also carries SRX300/SRX345/SRX1500, which
  are firewalls with their own templates and their own datasheets.
