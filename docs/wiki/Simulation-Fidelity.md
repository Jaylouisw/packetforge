# Simulation fidelity

The authoritative, file-and-line-cited answer lives in
**[docs/SIMULATION.md](https://git.jayw.uk/jaylouisw/packetforge/src/branch/main/docs/SIMULATION.md)**,
which is written from `engine/*.js`. This page is a summary; when the two disagree, that one
is right.

## Modelled

- **Physical layer**: cages, media, transceivers, ferrule polish (UPC/APC), optical budget,
  cable length, speed negotiation, PoE.
- **Layer 2**: MAC learning, VLANs (access/trunk/native), LAG, STP, LLDP.
- **Layer 3**: IPv4 and IPv6, ARP/ND, ICMP, static routes, longest-prefix match.
- **Services**: DHCP client and server, NAT (static, dynamic pool and PAT — all three translated in
  the data path and visible in `show ip nat translations`, but configured in the topology JSON:
  there is no `nat` CLI command yet), ACLs, VRRP.
- **Routing**: OSPF (areas, SPF, passive interfaces), BGP (eBGP/iBGP, split horizon).
- **Naming and overlay**: DNS, SCION.

## Approximated

Documented in the matrix, with the reason. Two worth knowing before you build a lab around
them: convergence **is** timed - STP listening/learning, OSPF hello plus the SPF hold, VRRP
master-down and the DHCP exchange all have durations, and the schedule re-bases from the instant
a cable is pulled - but a question is answered *as of* an instant, so no hello is ever lost and
no timer ever expires on its own. Queueing is not modelled: a link is either passing traffic or
it is not.

## Not modelled

Also listed there, in full. If a feature is not in the matrix, assume it is not modelled and
ask [in an issue](https://git.jayw.uk/jaylouisw/packetforge/issues) rather than assuming.
