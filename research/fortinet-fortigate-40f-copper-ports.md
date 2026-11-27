# FortiGate 40F — internal1-4 are not this box's ports

The catalogue gave the FortiGate 40F a `portTemplate` of `internal1-4` plus a bare `wan1`. The
hardware has **five** 10/100/1000BASE-T RJ45 ports, **no** SFP cage, and none of those names: the
box calls them `lan1`, `lan2`, `lan3`, `a` and `wan`. So a 40F could not be cabled as the desktop
branch box it is — the three LAN ports of the default hardware switch and the FortiLink port did
not exist under their real names, and the uplink was named `wan1` (the 60E/60F spelling) with no
connector and no rate ladder declared at all.

## What Fortinet says

**Fast path architecture page** —
<https://docs.fortinet.com/document/fortigate/8.0.0/hardware-acceleration/965349/fortigate-40f-fast-path-architecture>

> The FortiGate 40F features the following front panel interfaces:
> Five 10/100/1000BASE-T Copper (WAN, A, and 1-3) connected to the SOC4. A is a FortiLink interface.

The same page prints the CPU offload table, which is the model's own port naming:

```
diagnose npu np6xlite port-list
Chip XAUI Ports Max Cross-chip
Speed offloading
------ ---- ------- ----- ----------
np6xlite_0
10 wan 1000M NO
5 lan1 1000M NO
4 lan2 1000M NO
3 lan3 1000M NO
2 a 1000M NO
```

So the five interfaces are `wan`, `lan1`, `lan2`, `lan3`, `a` — not `wan1`/`internal1-4`, which is
the 60E/60F naming. That distinction matters because a 40F config pasted into the simulator used to
reference an interface the box does not have.

**40F series data sheet** — <https://www.fortinet.com/content/dam/fortinet/assets/data-sheets/pdf/fortigate-fortiwifi-40f-series.pdf>
(FG-40F-DAT, revision current at 2026-11-27)

* Front panel interface list: `1 x GE RJ45 WAN Port`, `1 x GE RJ45 FortiLink Port`,
  `3 x GE RJ45 Ethernet Ports` — five copper jacks, no SFP row.
* Specifications table, `Hardware Accelerated GE RJ45 PoE/+ Ports`: **0** for FG-40F.
* Ordering information: `5x GE RJ45 ports (including 4x Internal Ports, 1x WAN Ports)`.

**QuickStart guide** — <https://fortinetweb.s3.amazonaws.com/docs.fortinet.com/v2/attachments/fd70142f-ff2f-11e9-8977-00505692583a/FG-FWF-40F-60F-Series-QSG.pdf>
— the rear-panel legend, which is where the silk-screen order comes from:

* `WAN (RJ45) 1 Gbps Ethernet interface`
* `FortiLink Port A (RJ45) 1 Gbps Ethernet interface (FortiLink interface)`
* `Ethernet Ports 1 to 3 (RJ45) 1 Gbps Ethernet connections`

**Rate ladder.** The fast path page rates all five at 10/100/1000BASE-T, and a 40F console shows the
same ladder on the WAN port (`set speed ?` → `10full`, `100full`, `1000full` only, no 2500):
<https://community.fortinet.com/support-forum-92/fortigate-fortiwifi-40f-default-link-speed-and-duplex-150040>

## What changed

`devices/fortinet/fortigate-40f.json` is now a five-port box named `wan`, `lan1`, `lan2`, `lan3`
and `a`, each `connector: rj45` with `speedCaps: [10, 100, 1000]`. No `portTemplate`: these five
have different roles on the box (lan1-lan3 are the default `lan` hardware switch, `a` is the
default FortiLink member) rather than being interchangeable rows, and the template is what let
the wrong `internal*` names in.

`test/fortinet-fortigate-40f-copper-ports.test.js` pins the count, the names (including that
`internal1-4` and `wan1` are gone), the ladder, the absence of any fibre cage / MGMT / HA port, and that the FortiLink jack still cables to a
FortiSwitch uplink at 1G while an SFP transceiver is refused with `E_CONNECTOR_MISMATCH`.

## Left open deliberately

* **FG-40F-3G4G / FWF-40F** — the cellular and WiFi members of the series. Same five copper ports;
  the `wwan`/`modem` interface is a separate model and would need its own LTE evidence, so it is
  not folded into this spec.
* **PoE** — none on a 40F (`PoE/+ Ports: 0`); the 40F series has no PoE variant.
* **Console and USB** — the RJ45 console is a management line, not a data interface, and the
  simulator models consoles separately.
