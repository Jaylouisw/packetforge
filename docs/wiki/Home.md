# PacketForge wiki

An open-source, vendor-agnostic network simulator: build a topology out of real hardware
models, cable it with parts that exist, and find out what the packet actually does.

- **[Getting started](Getting-Started)** - clone, run, build your first lab in five minutes.
- **[Requesting hardware](Requesting-Hardware)** - a device is missing? This is how it gets added, and how you know it is accurate.
- **[Simulation fidelity](Simulation-Fidelity)** - what the engine really does, what it approximates, and what it does not do at all.
- **[Contributing](Contributing)** - the rules that keep the catalogue honest.

## What this project is for

Cisco Packet Tracer teaches Cisco. PacketForge aims at the thing a lab actually needs:
**any** vendor's box, modelled at the level where engineering decisions live - which cage is
on which port, which optic mates with which ferrule, what a cable that cannot exist would
mean if it did.

The catalogue holds **1,637 device models from 246 vendors**, from ONTs and OLTs to PTP radios,
switches, servers, printers, cameras and phones. It is JSON: one file per model, no code
changes to add one.

## The two questions the project answers

**"Can I cable this?"** Every link is checked against the physical layer: connector, cage,
media, speed negotiation, ferrule polish, optical budget, cable length. A cable that cannot
exist is refused with a reason, not silently allowed.

**"What happens then?"** ARP, IPv4/IPv6, ICMP, VLANs, LAG, STP, DHCP, NAT, ACLs, VRRP, OSPF,
BGP, DNS and SCION in the data path, with per-hop latency.

If the documentation ever disagrees with the code, [Simulation-Fidelity](Simulation-Fidelity)
is the one that is right.
