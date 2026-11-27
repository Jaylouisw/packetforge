# The Palo Alto branch and campus firewalls: which jack each port is, and what it trains at

**Question (one, narrow).** Issue #1398 counts template ports whose connector nothing declares.
The six Palo Alto specs on `main` all generated their data ports from a bare
`type: ethernet, speed: 1G` template - PA-220 (8), PA-440 (8), PA-450 (8), PA-820 (4),
PA-3220 (12) and PA-1420 (4), 44 ports - so `inferCage()` decided the cage from the port name.
The same six specs also carried explicit interfaces whose connector was silent or wrong: the
PA-3220 declared its **MGT and HA1-A/HA1-B ports as 10G SFP+** and the PA-820 declared its
MGT and HA ports as **SFP**, on hardware where every one of them is an RJ-45 socket.

**Verdict: every data port on these six is copper, and no two of them share a ladder.** The
PA-220, PA-440 and PA-450 are 10/100/1000 on all eight; the PA-820 splits 4x 10/100/1000 RJ-45
from 8x 1G SFP; the PA-3220 is 12x 10/100/1000 RJ-45, then 4x 1G SFP, then 4x SFP/SFP+; the
PA-1420 is 4x 10/100/1000 RJ-45, then **8x RJ-45 that still train at 10M and 100M** below their
2.5G/5G top, then 2x 1G SFP and 8x SFP/SFP+. The datasheet shorthand "1G/2.5G/5G" for that
middle block is the one place the two vendor documents disagree, and the hardware reference's
per-port table is the more specific of the two.

## Evidence

| Source | Says |
| --- | --- |
| [PA-220 datasheet](https://www.paloaltonetworks.com/content/dam/pan/en_US/assets/pdf/datasheets/pa-220/pa-220.pdf), Table 3 *Hardware Specifications* | I/O `10/100/1000 (8)`; Management I/O "10/100/1000 out-of-band management port (1)". |
| [PA-220 Hardware Reference - PA-220 Front Panel](https://docs.paloaltonetworks.com/hardware/pa-220-hardware-reference/pa-220-firewall-overview/front-panel-220) (also [PDF](https://docs.paloaltonetworks.com/content/dam/techdocs/en_US/pdf/hardware/pa-220/pa-220-hardware-reference.pdf)) | "**Eight RJ-45 10/100/1000Mbps ports** for network traffic"; MGT "this Ethernet 10/100/1000Mbps port". |
| [PA-400 Series datasheet](https://www.paloaltonetworks.com/content/dam/pan/en_US/assets/pdf/datasheets/pa-400-series/pa-400-series.pdf), Table 3 | I/O `PA-440, PA-450, PA-460: 1G RJ45 (8)`; Management I/O for the PA-440/450: "10/100/1000 out-of-band management port (1), RJ45 console port (1)". No SFP cage on either model. |
| [PA-400 Series Hardware Reference](https://docs.paloaltonetworks.com/content/dam/techdocs/en_US/pdf/hardware/pa-400/pa-400-hardware-reference.pdf), *PA-440, PA-450, and PA-460 Front Panel* (front panels identical) | "**Eight RJ-45 10/100/1000Mbps ports** for network traffic"; management "Ethernet 1Gbps port". The datasheet's "1G RJ45" and the reference's "10/100/1000Mbps" are the same jack and ladder. |
| [PA-800 Series datasheet](https://www.paloaltonetworks.com/apps/pan/public/downloadResource?pagePath=/content/pan/en_US/resources/datasheets/pa-800-series-datasheet), Table 3 | `PA-820: 10/100/1000 (4), Gigabit SFP (8)`; Management I/O "10/100/1000 out-of-band management port (1), 10/100/1000 high availability (2)". |
| [PA-800 Hardware Reference - PA-800 Front Panel](https://docs.paloaltonetworks.com/hardware/pa-800-hardware-reference/pa-800-firewall-overview/pa-800-front-panel) | "Ethernet ports 1 through 4: **Four RJ-45 10/100/1000Mbps ports**"; "SFP ports 5 through 8: four small form-factor pluggable (SFP) ports"; "SFP/SFP+ ports 9 through 12 ... PA-820 Firewalls: Four 1Gbps SFP ports; you cannot reconfigure these ports"; "HA1 HA2: **RJ-45 10Mbps/100Mbps/1Gbps**"; MGT "RJ-45 10Mbps/100Mbps/1Gbps". |
| [PA-3200 Series datasheet](https://www.paloaltonetworks.com/content/dam/pan/en_US/assets/pdf/datasheets/pa-3200-series/pa-3200-series.pdf), Table 3 | `PA-3220: 10/100/1000 (12), 1G SFP (4), 1G/10G SFP/SFP+ (4)`; Management I/O "10/100/1000 out-of-band management port (1), 10/100/1000 high availability (2), 10G SFP+ high availability (1)". |
| [PA-3200 Hardware Reference - PA-3200 Series Front Panel](https://docs.paloaltonetworks.com/hardware/pa-3200-hardware-reference/pa-3220-series-overview/front-panel-3200-series) | "Ethernet ports 1 through 12: **Twelve RJ-45 10Mbps/100Mbps/1Gbps ports**"; "PA-3220 firewall - Ports 13 through 16 are **SFP (1Gbps)** and ports 17 through 20 are SFP or SFP+ (10Gbps)"; "HA1-A and HA1-B ports: **Two RJ-45 10Mbps/100Mbps/1000Mbps ports**"; "MGT port: this Ethernet 10Mbps/100Mbps/1000Mbps port"; HSCI "One SFP+ (10Gbps) port". |
| [PA-1400 Series datasheet](https://www.paloaltonetworks.com/content/dam/pan/en_US/assets/pdf/datasheets/pa-1400-series/pa-1400-series.pdf), Table 3 | `PA-1420: 10/100/1000 (4), 1G/2.5G/5G (4), 1G/2.5G/5G (4)/PoE, 1G SFP (2), 1G/10G SFP/SFP+ (8)`; Management I/O "10/100/1000 out-of-band management port (1)", "HSCI 10 gigabit high availability (1)". |
| [PA-1400 Hardware Reference - PA-1400 Series Front Panel](https://docs.paloaltonetworks.com/hardware/pa-1400-hardware-reference/pa-1400-series-overview/front-panel-1400-series) | PA-1420 "Ports 1 through 4 - **10Mbps/100Mbps/1Gbps**"; "Ports 5 through 12 - **10Mbps/100Mbps/1Gbps/2.5Gbps/5Gbps**" (ports 9-12 are PoE); "Ports 13 and 14 - 1Gbps"; "Ports 15 through 22 - 1Gbps/10Gbps"; HSCI "One SFP+ (10Gbps) port (supports both SFP and SFP+ transceivers or cables)"; "HA1-A and HA1-B ports: Two RJ-45 10Mbps/100Mbps/1000Mbps ports"; MGT port RJ-45 10/100/1000. |

`10BASE-T`, `100BASE-TX`, `1000BASE-T`, `2.5GBASE-T` and `5GBASE-T` are all twisted-pair media
over an RJ-45 plug (`engine/media.js`, MEDIA rows), which is `CAGE_SPEEDS.rj45` exactly, so each
declared ladder and its cage agree with no special case. `sfp` and `sfp+` are the cages the
hardware reference names for ports 13-22 on the PA-3220/PA-1420.

## What was changed

| Spec | Template | Explicit interfaces |
| --- | --- | --- |
| devices/paloalto/pa-220.json | `connector: rj45`, `speedCaps: [10,100,1000]` (8 ports) | `mgmt` gains `rj45` / `[10,100,1000]` |
| devices/paloalto/pa-440.json | same (8 ports) | same |
| devices/paloalto/pa-450.json | same (8 ports) | same |
| devices/paloalto/pa-820.json | `connector: rj45`, `speedCaps: [10,100,1000]` (4 ports) | `ethernet1/5-1/7` gain `sfp` / `[1000]` (1/8-1/12 already had them); `mgmt`, `ha1`, `ha2` were **`sfp`** and become `rj45` / `[10,100,1000]` |
| devices/paloalto/pa-3220.json | `connector: rj45`, `speedCaps: [10,100,1000]` (12 ports) | `ethernet1/13-1/15` gain `sfp` / `[1000]`; `ethernet1/16` was **10G `sfp+`** and becomes 1G `sfp`; `mgmt`, `ha1-a`, `ha1-b` were **10G `sfp+`** and become `rj45` / `[10,100,1000]`; `ha2` (HSCI) stays `sfp+` / `[1000,10000]` |
| devices/paloalto/pa-1420.json | `connector: rj45`, `speedCaps: [10,100,1000]` (4 ports) | `ethernet1/5-1/12` gain `rj45` / `[10,100,1000,2500,5000]`; `ethernet1/13-1/14` narrow to `[1000]` (the HIG prints "1Gbps" for those two); `ethernet1/15-1/22` already `sfp+` / `[1000,10000]`; `ha1-a`, `ha1-b`, `management` gain `rj45` / `[10,100,1000]`; `hsci` gains `sfp+` / `[1000,10000]` |

The PA-3220 row is the one that changes behaviour rather than just wording. Before this pass the
spec said the management and HA1 ports were 10G SFP+ cages, so a copper patch lead into `mgmt`
was refused with `E_CONNECTOR_MISMATCH` while an SFP module was accepted - the exact inversion of
the hardware, on the port an operator reaches for first. `ha2` keeps `sfp+`: on the PA-3200 the
HSCI port *is* the 10G SFP+ high-availability port the datasheet lists under Management I/O.

The PA-820 row was the same lie in the other direction: `mgmt`, `ha1` and `ha2` were declared
`sfp` on a chassis whose HIG prints all three as RJ-45.

## What is left open

* **PA-1420 ports 9-12 are PoE ports** ("1G/2.5G/5G (4)/PoE", 151 W budget, 90 W on a single
  port in the datasheet) and the spec does not model the PoE capability on them. That is a
  census gap, not a connector one, and adding `poe` changes what the port can power rather than
  what it can cable to, so it is left for its own pass.
* **PA-1420's `ha1-a`/`ha1-b` were in the spec but not in the datasheet.** The datasheet's
  Management I/O row lists only the out-of-band MGT port and the HSCI port; the hardware
  reference's front-panel table adds "HA1-A and HA1-B ports: Two RJ-45
  10Mbps/100Mbps/1000Mbps ports for high availability (HA) control". The connector and ladder now
  trace to that table.
* **PA-820 ports 9-12 are 1G SFP, not SFP+.** The PA-800 reference says of the 820: "Four 1Gbps
  SFP ports; you cannot reconfigure these ports" - the SFP+ option on 9-12 belongs to the PA-850,
  which is not a spec in the catalogue.
* **PA-440/PA-450 have no SFP cage at all**, so the pass adds no cage rows; their own
  descriptions already said "no SFP cages" and the datasheet's I/O row agrees.
* The remaining 646 undeclared template ports are other vendors (Aruba 6405 and Instant On,
  Extreme X440/X460, MikroTik, H3C, Netgear GS748T, and the FortiGate / Juniper SRX / Sophos-XGS / Zyxel-USG
  firewall-router ids); see `scripts/audit-port-types.js --json`.
