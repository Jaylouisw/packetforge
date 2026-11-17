# When a port goes down, do its dynamic MAC entries stay in the table?

**Question (one, narrow).** On a real access switch, when a port is administratively closed or its link drops,
do the MAC addresses learned on that port stay in `show mac address-table` until the ageing timer lapses, or are
they removed at once?

**Verdict: settled - they are removed at once.** PacketForge kept them and said so in a test
("shutting a port does NOT empty the table - real switches age entries out"). That sentence about real switches
is wrong, and the table now follows the device.

## What PacketForge did before this change

```
sw1(config)# interface Fa0/2
sw1(config-if)# shutdown
Fa0/2 administratively down
sw1# show mac address-table
Vlan    Mac Address         Type        Age     Ports
1       0200.0000.0200      DYNAMIC     0s      Fa0/2 (administratively down)
```

The row survived until `MAC_AGE_MS` (300 s) of silence expired, marked with its reason. The note (`(down: ...)`)
is worth keeping for rows nothing here can date or observe, but it was standing in for a deletion that real
hardware performs.

## Evidence

| Source | Says |
| --- | --- |
| [Aruba Instant On 1930 Management and Configuration Guide, "Port security"](https://arubanetworking.hpe.com/techdocs/InstantOn_1930_Switch/1930_Management_and_Config_Guide.pdf) | "A dynamically-learned MAC address is removed from the MAC address table if the entry ages out, **the link goes down**, or the system resets." Three causes, stated as one rule; ageing is only one of them. |
| [Aruba AOS-CX Layer-2 Bridging Guide 10.14](https://arubanetworking.hpe.com/techdocs/AOS-CX/10.14/PDF/l2_bridging_8100-83xx-9300-10000.pdf) | "Port-security MAC addresses are cleared when the port on which the MAC addresses were learned are **shut down** or the port-access-security feature is disabled" - same event, from the secure-MAC side. |
| [Cisco Catalyst 9300 configuration guide 17.16, Port Security](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-16/configuration_guide/sec/b_1716_sec_9300_cg/port_security.pdf) | "When a port disconnects from the switch, the system **immediately** removes the dynamic secure MAC addresses, even if the port-security aging inactivity is configured to retain those addresses." Immediate, and outranking a configured ageing time. |
| IEEE Std 802.1D-2004, 7.4 and 17.19.7 | Learning is conditional on the Port State (7.4): a port that is not part of the active topology does not learn, and the filtering database is told to "remove all entries for this Port, immediately" (17.19.7, the topology-change flush). The bridge's own tables are not allowed to keep a location the port can no longer serve. |
| [Cisco Learning Network, "Question about MAC table"](https://learningnetwork.cisco.com/s/question/0D53i00000Kt5dPCAR/question-about-mac-table) | Practitioner consensus, and the reason given: "As soon as a switchport goes down, all MAC addresses learned on that port are flushed. Otherwise, the switch would be trying to forward the frames out an inoperable port, causing them to get lost." Static entries are the exception and are not flushed. |

The forwarding reason is also the model's own: `macLookup()` refuses to hand the data plane a port it should not
use, so a row kept for a down port was a display-only survivor - the packet path already behaved as if the entry
were gone. The table and the forwarding decision disagreed about the same switch.

## What is now implemented

* `flushMacsOnPort()` is called from the interface `shutdown` handler and from `Topology.disconnect()`, so both
  events that take a port out of service drop what was learned on it, in every VLAN.
* The flush is reported, not silent: `Fa0/2 administratively down (1 learned address on it dropped)`. A deletion
  that said nothing would be the same kind of evidence-free claim as the old retention.
* Reopening the port does not resurrect the entry, which is the observable that matters: a reconnected host has
  to speak before the switch stops flooding for it.
* `test/mac-table.test.js` pins the rule at both call sites, and `docs/CLI.md` no longer states the old one.

## What is inferred, and what remains

* Cisco's configuration guides do not print the sentence Aruba prints, for plain dynamic entries - the Cisco
  evidence is the port-security wording (immediate removal on disconnect) plus the 802.1D rule plus field
  consensus. That is enough to act on, but it is inference from three directions rather than one quotation.
* **A port whose far end goes away is not flushed**, because nothing in the model observes that as an event: the
  port reads `down (peer shut down)` at display time and the entry stays marked. On hardware the near port's link
  also drops, so its entries would go too. Closing that needs a link-state hook, not another call site.
* Static and sticky MAC entries are not modelled, and on hardware neither is flushed by a port going down -
  worth remembering before anyone adds them.
* `show arp` keeps its entries on a down port on purpose (a router's cache does not empty when a cable is
  pulled); this note does not touch it.
