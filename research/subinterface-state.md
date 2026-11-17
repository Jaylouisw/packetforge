# A subinterface's line state: whose is it?

**Question (one, narrow).** What do the `Status` and `Protocol` columns say for a router-on-a-stick
subinterface when the physical parent is (a) up, (b) uncabled, (c) administratively down - and can a
subinterface read `administratively down` when nobody shut the subinterface?

**Verdict: settled for 802.1Q Ethernet, and adopted.** A subinterface has no line of its own; it reports
its parent's state, with one exception: a `shutdown` typed on the subinterface itself also holds it down.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco Press, Wendell Odom, *CCNA 200-301 Official Cert Guide, Vol. 1*, ch. 17, "VLAN Routing with Router 802.1Q Trunks"](https://www.ciscopress.com/articles/article.asp?p=2990405&seqNum=2) | "the ROAS subinterface state does depend to some degree on the physical interface state. In particular, the subinterface state **cannot be better than the state of the matching physical interface**." Parent up/up -> subinterfaces up/up; "if you unplugged the cable from that port, the physical port would fail to a down/down state, and the subinterfaces would also fail to a down/down state"; and Example 17-4, with the parent shut: "the subinterfaces then automatically changed to an administratively down state as a result". The same page prints the transcript (below) and adds: "the subinterface state can also be enabled and disabled independently from the physical interface, using the no shutdown and shutdown commands in subinterface configuration mode." |
| [Cisco Press, "Troubleshoot Inter-VLAN Routing (4.4)"](https://www.ciscopress.com/articles/article.asp?p=3089357&seqNum=7) | Example 4-35, a working lab: `GigabitEthernet0/0/1 ... up up` with `Gi0/0/1.10`, `.20`, `.99` all `up up`. Children are listed immediately after their parent. |
| [Cisco, *Configuring Layer 3 Interfaces* (Nexus 3548, NX-OS 6.0(2))](http://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus3548/sw/interfaces/602_a1_1/b_N3548_Interfaces_Config_602_A1_1/b_N3548_Interfaces_Config_603_A1_1_chapter_011.pdf) | "If you shut down the parent interface, Cisco NX-OS shuts down all associated subinterfaces as well." The same rule, stated for another OS. |
| [Cisco, *Configuring POS Interfaces* (ASR 9000, IOS XR 6.6.x)](https://www.cisco.com/c/en/us/td/docs/routers/asr9000/software/asr9k-r6-6/interfaces/configuration/guide/b-interfaces-hardware-component-cg-asr9000-66x/b-interfaces-hardware-component-cg-asr9000-66x_chapter_010000.pdf) | "The administrative state of a parent interface drives the state of the subinterface and its PVC." On a packet-over-SONET port there is a second gate the Ethernet case does not have: "A POS subinterface does not actively carry traffic until you configure a PVC under the POS subinterface." |

Example 17-4, verbatim:

```
B1(config)# interface g0/0
B1(config-if)# shutdown
B1# show ip interface brief | include 0/0
GigabitEthernet0/0         unassigned      YES manual administratively down down
GigabitEthernet0/0.10      10.1.10.1       YES manual administratively down down
GigabitEthernet0/0.20      10.1.20.1       YES manual administratively down down
```

So the four states are: parent up/up -> `up`/`up`; parent down (no carrier) -> `down`/`down`; parent
administratively down -> `administratively down`/`down`; and a subinterface's own `shutdown` ->
`administratively down`/`down`, with the parent untouched.

## What this console did

`Device.ifaceStatus()` had no branch for a subinterface, so a subinterface fell through to the cable
tests: it has no `peer` of its own, so `!port.peer` returned `down`, reason **"no cable"**. A working
router-on-a-stick therefore printed

```
Gi0/0.10               10.10.0.1       YES manual down                  down
```

in the table an operator checks first, and `show interfaces Gi0/0.10` explained it with a cable a
subinterface never had. The data plane was never fooled - a ping across the lab worked while that row
said down - so the console was the only liar, which is the worse kind: the lab worked and the command
said it could not.

The `enabled` flag was the second half. `Device.addSubinterface()` copied the parent's flag at creation,
so a subinterface created while the physical port was shut stayed `administratively down` after the
parent was enabled (nothing could reach a flag already set), and `show running-config` grew a
`shutdown` line under a subinterface nobody had shut - which a restore would then apply.

## What changed

- `engine/device.js`, `ifaceStatus()`: a subinterface reports its parent's state. Parent up -> `up`/`up`;
  parent down or shut -> the parent's status and `down`, with the reason naming the parent
  (`parent Gi0/0 is shut down`, `parent Gi0/0: no cable`) so it cannot be read as a fault of the
  subinterface. The subinterface's own `shutdown` still wins, because that check runs first.
- `engine/device.js`, `addSubinterface()`: a new subinterface is administratively up, as
  `interface Gi0/0.10` is on a box.
- `docs/LINK-STATE.md`: the state table gains the inherited case.
- `test/subinterface-state.test.js`: six cases - up/up, parent shut, subinterface shut, parent
  re-enabled, subinterface created under a shut parent, and an uncabled parent - each asserting the row
  in `show ip interface brief` and, where it matters, the sentence in `show interfaces` and the
  absence or presence of the line in `show running-config`.

## What remains unresolved

1. **Does a subinterface go down when its VLAN is not carried by the trunk?** The Cisco Press
   troubleshooting table in the same chapter lists "encapsulation mismatch on subinterface" and "VLAN not
   allowed on trunk" as causes of a host that cannot reach its gateway, and field write-ups describe a
   subinterface reading `down/down` while the parent is `up/up`. This console does not model it: a
   subinterface's state is its parent's and nothing consults the parent's allowed-VLAN list. Settling it
   needs one capture from a box (not a lab write-up) of `show ip interface brief`, `show interfaces trunk`
   and the subinterface block, with a dot1q id deliberately left off the trunk.
2. **Does the connected route survive a down subinterface?** `show ip route` here lists a prefix per
   configured address and does not ask the port's state; a box removes the connected route when the
   interface goes down. That is a routing-table question, not an interface-state one, and is not changed
   here. Evidence: `show ip route` beside `show ip interface brief` with the parent shut.
3. **Row order in `show ip interface brief`.** Cisco's own samples print children immediately after their
   parent (Example 4-35 above); this console appends every subinterface after every physical port, so
   `Gi0/0.10` lands below `Gi0/2`. `show interfaces` already places children after their parent, so the
   two views of one list disagree - a separate, layout-sized question.
4. **Non-Ethernet subinterfaces.** On IOS XR POS and serial ports the parent's administrative state drives
   "the subinterface and its PVC", and a PVC is a second gate with no Ethernet equivalent. The catalogue's
   ports are Ethernet, fibre and serial-with-clock, so only the Ethernet form is implemented.
5. **What `show interfaces <subif>` prints on a box.** IOS opens with
   `GigabitEthernet0/0.10 is up, line protocol is up`; this console prints its own block shape, so that
   sentence is deliberately not claimed anywhere.
