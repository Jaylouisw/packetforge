# `show ip ospf neighbor`: what the State cell contains

**Question.** The `State` column of `show ip ospf neighbor` printed one word, `Full`. A real box
prints two facts in that cell - the adjacency state and the *role the neighbour holds on the
segment*. What exactly goes after the slash, and when is there nothing to put there?

## What is known

* IOS prints `FULL/DR`, `FULL/BDR` and `FULL/DROTHER` on a broadcast segment, and the role is the
  **neighbour's**, not the reporting router's. Cisco's own explanation of the field: the Neighbor ID
  is the neighbour's router ID, and in the sample the box reads
  `192.168.45.1  1  FULL/DR  00:00:36  10.0.0.1  Ethernet0` - "The neighbor is the DR".
  <https://www.cisco.com/c/en/us/support/docs/ip/open-shortest-path-first-ospf/13688-16.html>
* The election rule, same page: "The router with the highest priority becomes the designated
  router (DR). If the priorities are the same, then the router with the highest router ID becomes
  the DR. By default, priorities are set to 1." Priority 0 makes a router ineligible, so it is
  always a DROTHER.
* Two routers on one segment therefore read each other as `FULL/DR` and `FULL/BDR` - the higher
  router ID is the DR. A worked example on Ethernet, with the DR/BDR pair and the DROTHERs staying
  at `2WAY/DROTHER`, is in Cisco's "why are neighbours stuck in two-way" note:
  <https://www.cisco.com/c/en/us/support/docs/ip/open-shortest-path-first-ospf/13683-11.html>
* On a **point-to-point** link there is no election and the cell is `FULL/ -`:
  `2.2.2.2  1  FULL/ -  00:00:32  1.1.1.1  Serial 0`, with the text "On point-to-point links such
  as HDLC and PPP, OSPF runs as a point-to-point network type. This network type is enabled by
  default."
  <https://www.cisco.com/c/en/us/support/docs/ip/open-shortest-path-first-ospf/13687-15.html>
* The Frame Relay subinterface note says the same in words: "the OSPF neighbor state is shown as
  `FULL / -`, but the DR and BDR state is not indicated. This is because there is no DR and BDR
  election on a point-to-point link."
  <https://www.cisco.com/c/en/us/support/docs/ip/open-shortest-path-first-ospf/13693-22.pdf>

## What this model can and cannot produce

PacketForge builds one adjacency per cable (`computeOspf()` walks `topo.links`), so every segment
has exactly two speakers. That makes the election deterministic without modelling a shared LAN:
the higher router ID is the DR, the other end the BDR. A third speaker on one segment - where a
DROTHER would read `FULL/DR`, `FULL/BDR` and `2WAY/DROTHER` - cannot arise here, so that branch is
not written rather than written and untested.

Serial ports are the one point-to-point case the model has (`hardware.family === 'serial'`, e.g.
the 2811's `Se0/0/0`). IOS's default OSPF network type on a serial interface is point-to-point, so
those adjacencies print `FULL/ -` and no role.

## What is inferred

* **Priority.** There is no `ip ospf priority` command here, so every port sits at IOS's default of
  1 and the router ID is the only tie-break that can fire. The code says that in a comment rather
  than carrying a priority field nothing can change.
* **Timing.** IOS's election is pre-emptive only when the DR role is vacant: an established DR
  keeps the role even when a higher-ID router appears later, and a box that finishes loading first
  can win a tie on a live network. This model has no boot order, so it applies the textbook
  tie-break to the topology as it stands - the answer a freshly powered lab gives.

## What is unresolved

* Duplicate router IDs. A real box refuses to become adjacent over a duplicate ID (the adjacency
  sticks in INIT/EXSTART and logs a DUP_RTRID warning); this model happily forms one. The role is
  then decided by device id just to keep the output stable, which is a stopgap, not fidelity.
* `ip ospf network point-to-point` on an Ethernet port (and the reverse) is not modelled, so the
  only route to "no election" is a serial port.
* Whether IOS prints `FULL/  -` (two spaces) or `FULL/ -` varies by platform/terminal capture; the
  captures above all show one space before the dash, which is what this console prints.

## What evidence would settle the remainder

1. One `show ip ospf neighbor` from a box with a duplicate router ID configured, to see whether the
   row appears at all or the adjacency stays out of the table.
2. The same command on a Catalyst with `ip ospf network point-to-point` on a routed Ethernet port,
   to confirm the role cell follows the network type rather than the media.
3. `ip ospf priority 200` on one end of a two-router segment: one paste showing `FULL/DR` on the
   other end settles that the priority outranks the router ID (the doc says so; a capture would
   pin the column widths too).
