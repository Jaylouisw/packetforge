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
- **Services**: DHCP client and server, NAT (static and PAT), ACLs, VRRP.
- **Routing**: OSPF (areas, SPF, passive interfaces), BGP (eBGP/iBGP, split horizon).
- **Naming and overlay**: DNS, SCION.

## Approximated

Documented in the matrix, with the reason. Two worth knowing before you build a lab around
them: routing convergence is computed per event rather than by timer, and queueing is not
modelled - a link is either passing traffic or it is not.

## Not modelled

Also listed there, in full. If a feature is not in the matrix, assume it is not modelled and
ask [in an issue](https://git.jayw.uk/jaylouisw/packetforge/issues) rather than assuming.
