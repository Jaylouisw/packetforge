# A gateway's LAN address must not answer on its WAN socket

Written 2026-11-21 for request #130 (Dream Wall Pro). The Pro has no vendor page, so the work available on this
request is on the rows around it. Two of them - the Dream Wall (UDW) and the Dream Router (UDR) - had just been
given a WAN role by PR #2320 and PR #2346, and a measurement this pass shows that the role on one side does not
do anything on its own.

## The rule, in the engine's own words

`engine/device.js`, `ownsIpOn`:

```js
// WAN and LAN are separate L3 surfaces. A router's LAN address is not reachable
// from its WAN port - that is what NAT is for - so role separation outranks the
// VLAN shortcut below.
if (owner.role && inIface.role && owner.role !== inIface.role) return null;
```

`&&` twice: the separation only fires when **both** the port that holds the address and the port the frame arrived
on declare a role. `test/port-roles.test.js` has asserted the invariant for the consumer router since #8 -

```js
ok(!r.ownsIpOn(wan, '192.168.1.1'), 'the WAN port does not answer the LAN address');
```

- and the RT-AX89X passes it because its eight LAN sockets declare `role: "lan"` beside `bridgeGroup: "lan"`.

## What the two Dream rows shipped

| row | uplink | LAN bank |
|---|---|---|
| `devices/ubiquiti/udw.json` | `wan1`, `role: "wan"` (PR #2320) | `eth0`-`eth16`, **no role** |
| `devices/ubiquiti/udr.json` | `eth4`, `role: "wan"` (PR #2346) | `eth0`-`eth3`, **no role** |

So `owner.role` was set and `inIface.role` was null, and the check was skipped.

## Measured, before and after

Topology for both rows: VLAN-1 LAN address `192.168.1.1/24` on `eth0`, the row's WAN socket unused, three hosts -
one on `eth0`, one on the far side of the LAN bank (`eth5` / `eth1`), one cabled to the WAN socket and placed in
`192.168.1.0/24` so that nothing but role separation can stop it.

| probe | UDW before | UDW after | UDR before | UDR after |
|---|---|---|---|---|
| `ownsIpOn(wan, '192.168.1.1')` | **true** | false | **true** | false |
| host on the WAN socket pings `192.168.1.1` | **answered** | no reply | **answered** | no reply |
| host on `eth0` pings `192.168.1.1` | answered | answered | answered | answered |
| host on `eth5` / `eth1` pings `192.168.1.1` | answered | answered | answered | answered |
| `ownsIpOn(wan, <wan's own address>)` | true | true | true | true |
| `ownsIpOn(radio0, '192.168.1.1')` (UDR) | true | true | true | true |

The overlapping-subnet host is the point: a WAN-side host in the LAN's prefix is exactly the case where a real
console keeps the two surfaces apart, and the model answered ARP and ICMP from the LAN address on the uplink.

## Vendor rows this rests on

Both surfaces state the split, and both were re-read the same day as the change (bytes as returned):

| model | datasheet text layer | tech-spec table |
|---|---|---|
| UDW | `Networking interface (17) LAN: GbE RJ45 ports / (1) WAN: 2.5 GbE RJ45 port` - https://dl.ui.com/ds/udw_ds.pdf, HTTP 200, 544,909 B, 3 pp | `Default WAN Ports (1) 2.5 GbE RJ45 (1) 10G SFP+`, `Max. WAN Port Count 8` - https://techspecs.ui.com/unifi/cloud-gateways/udw, HTTP 200, 704,702 B |
| UDR | `Networking interface LAN: (4) GbE RJ45 ports / WAN: (1) GbE RJ45 port` - https://dl.ui.com/ds/udr_ds.pdf, HTTP 200, 771,202 B, 3 pp | `Default WAN Ports (1) GbE RJ45`, `Max. WAN Port Count 1` - https://techspecs.ui.com/unifi/cloud-gateways/udr, HTTP 200, 685,837 B |

## What is deliberately still unmodelled

- **The two UDW SFP+ cages.** The datasheet prints `(1) LAN: 10G SFP+ port / (1) WAN: 10G SFP+ port` without
  numbering them, so both keep `dualRole: ["wan","lan"]` and no `role`. Consequence, measured: an address held on a
  cage is still answered on the other cage. Numbering them would close that, and no vendor surface does.
- **`Max. WAN Port Count 8` (UDW).** The vendor states a ceiling, not which sockets can be reassigned. Marking all
  seventeen LAN ports `dualRole: ["wan","lan"]` would answer "which" with a guess; the row keeps a fixed LAN role
  and the ceiling is recorded here instead.
- **The radios.** They stay role-less on purpose - a wireless client is on the LAN side, and `ownsIpOn(radio0,
  '192.168.1.1')` is true, so the access point still serves the gateway's LAN address.

## Gate

`test/ubiquiti-wan-lan-role-separation.test.js` - 27 assertions: the roles, the `ownsIpOn` invariant in both
directions, the overlapping-subnet ping, the bank still answering bank-wide, the uplink still answering its own
address, the radios and cages unchanged, and a synthetic role pair so the engine rule itself is covered.
