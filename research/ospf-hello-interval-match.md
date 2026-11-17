# OSPF: does an adjacency form when the Hello/Dead intervals differ?

**Question (one, narrow).** Two routers sit on the same subnet, in the same area, both running OSPF, but
one sends Hello 5 s / Dead 20 s and the other the default 10 s / 40 s. Do they become neighbours?

**Verdict: known, and adopted.** They do not. The receiving port compares the received `HelloInterval`
and `RouterDeadInterval` with its own and drops the Hello on any mismatch, so neither side ever reaches
ExStart. PacketForge previously formed the adjacency and installed routes across it, because the two
timer sets arrive as independent per-device settings and nothing compared them.

## The rule, from the protocol

RFC 2328 10.5, *Receiving Hello Packets*, is explicit:

> Next, the values of the Network Mask, HelloInterval, and RouterDeadInterval fields in the received
> Hello packet must be checked against the values configured for the receiving interface. Any mismatch
> causes processing to stop and the packet to be dropped. In other words, the above fields are really
> describing the attached network's configuration.

* https://www.rfc-editor.org/rfc/rfc2328.txt (section 10.5; the Hello format carrying both numbers is
  A.3.2)

One exception is stated in the same paragraph and is *not* adopted here: on point-to-point networks and
virtual links the received Network Mask is ignored. PacketForge still requires both ends of a serial link
to carry the same mask before it forms an adjacency - see "unresolved", below.

## What a real box shows an operator

The drop is silent on the console. The only trace is under `debug ip ospf hello`, and it prints the two
pairs as received (R) against configured (C):

```
OSPF: Rcv hello from 192.168.12.1 area 0 from FastEthernet1/0 192.168.12.1
OSPF: Mismatched hello parameters from 192.168.12.1
OSPF: Dead R 40 C 60, Hello R 10 C 15  Mask R 255.255.255.0 C 255.255.255.0
```

That is Cisco's own troubleshooting document (12151), and the same trace is reproduced in Cisco Learning
Network answers to "OSPF hello timer mismatch" and in the Nexus 9000 OSPFv2 guide's list of interface
compatibility criteria:

* https://www.cisco.com/c/en/us/support/docs/ip/open-shortest-path-first-ospf/12151-trouble-main.html
* https://learningnetwork.cisco.com/s/question/0D53i00000Kt5puCAB/ospf-hello-timer-mismatch
* https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus9000/sw/6-x/unicast/configuration/guide/l3_cli_nxos/l3_ospf.html
  ("An OSPFv2 interface must have a compatible configuration with a remote interface before the two can
  be considered neighbors. The two OSPFv2 interfaces must match the following criteria: Hello interval,
  Dead interval, ...")
* https://www.cisco.com/c/en/us/support/docs/cloud-systems-management/application-policy-infrastructure-controller-apic/221994-troubleshoot-aci-ospf-adjacencies.html
  ("OSPF Hello and Dead Intervals must match"; "The value of all hello intervals must be the same within
  a network.")

Note the pair is compared as a pair: equal Hello with unequal Dead is still a mismatch, which is exactly
what `Dead R 40 C 60, Hello R 10 C 15` reports.

## What PacketForge did, and what changed

`engine/simulator.js::computeOspf()` built one link per cable between two OSPF speakers after checking
the port is up, is not passive, and addresses the same subnet with the same mask. Timers were never part
of that test, although the same module's `show ip ospf neighbor` counts its `Dead Time` cell down from
`convergence.ospfTimers(dev).deadSec` - so the console printed a 20 s countdown for an adjacency a real
box would have refused outright.

* `computeOspf()` now compares `convergence.ospfTimers()` at both ends and refuses the link when either
  number differs, recording the refusal on both devices (`dev.ospfRejected`).
* The area disagreement is recorded the same way. It was already refused (in `ospf.buildGraph()`), but
  with no reason kept, so the console answered "nothing on the other end runs OSPF" about a box running
  OSPF in another area.
* `show ip ospf neighbor [<port>]` and `show ip ospf` now name the disagreement instead of printing that
  false sentence: the two interval pairs, or the two areas, plus the RFC paragraph the rule comes from.
* `test/ospf-timer-mismatch.test.js` holds the engine and the console to it: adjacency and the `O` route
  present at matching defaults, both absent on a 5/20 against 10/40, still absent when only Dead differs,
  restored when the timers are put back, and the area case reported as an area case.
* `test/show-ospf.test.js` changed one lab: it used to give *one* box 30/120 and keep reading its
  neighbour row, which is now (correctly) refused. The lab puts 30/120 on every box, which is what makes
  the countdown observable at all.

## Unresolved

1. **Mask on a point-to-point link.** RFC 2328 10.5 says the Network Mask in a received Hello "should be
   ignored" on point-to-point networks and virtual links, and NetworkLessons' troubleshooting page says
   the same in IOS terms ("OSPF will only compare the subnet mask when you are using the broadcast
   network type"). PacketForge still refuses any link whose two masks differ, serial links included. What
   would settle it is a capture of two IOS routers on a serial link with /24 against /30: adjacency up,
   and whether the far address resolves.
2. **Per-interface versus per-process timers.** IOS configures the pair per interface
   (`ip ospf hello-interval` / `ip ospf dead-interval`); this model carries it per device
   (`config.ospf.helloSec` / `deadSec`), and has no config command for either, so the mismatch this run
   refuses is reachable through the lab model (and the tests) rather than through the console. The rule
   is stated per device, which is correct only as long as the model's timers are per device.
3. **Whether IOS re-derives Dead from Hello.** One lab write-up used as a source claims IOS "quietly
   changed R2's dead interval to 20 seconds, four times the new Hello" after `ip ospf hello-interval 5`.
   Cisco's command reference describes the dead interval default as four times the hello interval but
   does not say it tracks a later change, and the classic lab advice is to set both. Nothing in this run
   depends on the answer (the tests set both), but a capture of `show ip ospf interface` before and after
   `ip ospf hello-interval 5` would settle it.
