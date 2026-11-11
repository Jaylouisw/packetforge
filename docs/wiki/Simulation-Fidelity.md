# Simulation fidelity

The authoritative, file-and-line-cited answer lives in
**[docs/SIMULATION.md](https://git.jayw.uk/jaylouisw/packetforge/src/branch/main/docs/SIMULATION.md)**,
which is written from `engine/*.js`. This page is a summary; when the two disagree, that one
is right.

## Modelled

- **Physical layer**: cages, media, transceivers, ferrule polish (UPC/APC), optical budget,
  cable length, speed negotiation, PoE.
- **Layer 2**: MAC learning, VLANs (access/trunk/native, voice VLAN), LAG, STP, LLDP,
  port security with its violation modes and aging (`switchport port-security …`, `clear port-security`).
- **Layer 3**: IPv4 and IPv6, ARP/ND, ICMP, static routes, longest-prefix match, IPv6 first-hop
  configuration (`ipv6 nd ra enable|disable`, `ipv6 nd ra managed|other-config`,
  `ipv6 nd ra lifetime <s>`, `ipv6 nd prefix <prefix>/<len> [valid <s>] [preferred <s>]`,
  `ipv6 nd suppress-ra`) with SLAAC on the hosts. Those are **global** verbs even when typed inside an
  interface block, and the console says so rather than applying them silently —
  `note: "ipv6 nd ra enable" is a global command - applied at global scope; you are still in this
  interface block`. The prefix form wants the keywords: `ipv6 nd prefix 2001:db8::/64 3600 1800` is
  refused with `% Unexpected "3600": expected [valid <seconds>] [preferred <seconds>]`, while the same
  line with the intervals left off is accepted and reports what it advertised (`L=1 A=1, valid
  2592000s, preferred 604800s` — the RFC defaults). A prefix on an interface with no address inside it
  is never actually sent, and `show ipv6 nd` says so in a line of its own:
  `% 2001:db8::/64 is configured but no interface has an address inside it, so it is never advertised`.
- **Services**: DHCP client and server, NAT (static, dynamic pool and PAT — all three translated in
  the data path and visible in `show ip nat translations`; static and PAT rules can be written from the
  console with `ip nat inside source …`, but a pool-based dynamic rule still comes from the topology
  JSON, because `ip nat pool` is refused), ACLs, VRRP.
- **Routing**: OSPF (areas, SPF, passive interfaces), BGP (eBGP/iBGP, split horizon).
- **Naming and overlay**: DNS, SCION.
- **Flows**: a transport flow can be opened against a destination and inspected rather than
  inferred from pings — `flow open <dst> [port <n>] [bytes <n>] [proto tcp|udp] [sport <n>] [at <ms>|converged]`,
  with `show flows` and `show flows counters` reading back what the data path did. A refused flow
  names its code, which is the difference between "it did not work" and "here is which rule or
  missing route stopped it".

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
