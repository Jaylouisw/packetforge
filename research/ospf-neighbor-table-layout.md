# `show ip ospf neighbor`: the columns, their order and their widths

**Question.** The neighbour table printed four columns - `Neighbor ID  Address  Interface  State` -
where a real box prints six, in a different order: the priority and the dead countdown were simply
not there, and the port sat where the address belongs. Which fields does the command print, in what
order, at what column, and what is the `Dead Time` cell counting?

## What is known

* The six fields, in order, with the vendor's own description of each: Neighbor ID (the neighbour's
  router ID), Pri (the neighbour's interface priority), State (adjacency state, plus the role the
  neighbour holds), Dead Time (the time left before the neighbour is declared down), Address (the
  neighbour's interface address on the shared link), Interface (the port the adjacency formed on).
  <https://www.cisco.com/c/en/us/support/docs/ip/open-shortest-path-first-ospf/13688-16.html>
* The same page's sample line is `192.168.45.1  1  FULL/DR  00:00:36  10.0.0.1  Ethernet0`, and it
  states the defaults the two new cells rest on: "By default, priorities are set to 1", and "The
  Dead Time field indicates the amount of time that remains as the router waits to receive an OSPF
  hello packet from the neighbor before it declares the neighbor is down."
* The three quantities travel in the Hello packet, so the cells are read from the neighbour, not
  invented locally: RFC 2328 A.3.2 carries `Router Priority`, `HelloInterval` and
  `RouterDeadInterval` in the Hello body. <https://www.rfc-editor.org/rfc/rfc2328#appendix-A.3.2>
* **Column positions.** Web pages collapse runs of spaces, so the widths have to come from a capture
  whose whitespace survived. ntc-templates ships raw CLI text for exactly this reason, and its file
  for this command is intact:
  <https://github.com/networktocode/ntc-templates/blob/master/tests/cisco_ios/show_ip_ospf_neighbor/cisco_ios_show_ip_ospf_neighbor.raw>
  Its four lines, measured, put every field on the same column:
  `Neighbor ID`@0, `Pri`@16 (the value right-aligned so it ends at 18), `State`@22 and 16 wide,
  `Dead Time`@38 and 12 wide, `Address`@50 and 16 wide, `Interface`@66 (last, unpadded).
  The same file shows a point-to-point row - `10.0.0.1  0  FULL/  -  00:00:32  10.0.1.1  Port-channel1`
  - so the widths hold whatever the State cell contains.
* Dell's OS10 and S6000 references print the same six columns in the same order and then an `Area`
  column, which is the one vendor-specific addition seen:
  <https://www.dell.com/support/manuals/en-us/smartfabric-os10-emp-partner/smartfabric-os-user-guide-10-6-1-x/show-ip-ospf-neighbor>
  The base six are therefore the portable shape, and Area is left out here.
* **The Interface cell's spelling.** The last column prints the port's *full* name, not the panel
  abbreviation. Four captures agree: the ntc-templates raw file prints `Port-channel1` and
  `Vlan1000` (link above); Cisco 13688-16's own sample row ends `Ethernet0`; the Cisco Press
  chapter "Implementing OSPFv2 Using network Commands" prints three rows ending
  `GigabitEthernet0/0/1`, `GigabitEthernet0/0/2`, `GigabitEthernet0/0/3`
  <https://www.ciscopress.com/articles/article.asp?p=3197438&seqNum=3>; and a RouteLearn paste
  prints `GigabitEthernet0/0` on every row
  <https://routelearn.net/ospf/dr-bdr-network-types>. One third-party blog row is written
  `Gig0/0` <https://github.com/OneUptime/blog/blob/master/posts/2026-03-20-troubleshoot-ospf-neighbor-adjacency/README.md>
  - hand-typed prose rather than a paste, and the only sample found that abbreviates.
* The abbreviation is used in the *other* member of this command family: `show ip ospf interface
  brief` prints `Et0/2` / `Et0/0` in its Interface column in Cisco's own forwarding-address note
  <https://www.cisco.com/c/en/us/support/docs/ip/open-shortest-path-first-ospf/200066-Understand-Selection-of-Forwarding-Addre.pdf>
  (a CCNA lab doc prints `Gi1/0/23` there). So the long spelling is a fact about this table, not
  about OSPF reporting in general.
* The dead interval is four Hellos: 40 s over the default 10 s hello on a broadcast segment
  (IOS's `ip ospf dead-interval` default). A capture showing the countdown at 36 s, with neighbours
  heard at slightly different instants, is in Cisco's two-way troubleshooting note:
  <https://www.cisco.com/c/en/us/support/docs/ip/open-shortest-path-first-ospf/13683-11.html>

## What this model does

* Prints the six columns at the measured widths, in the measured order, with the port named in full
  (`GigabitEthernet0/0/0` for a catalogue port called `Gi0/0/0`) as every capture does. A row with
  that name reaches column 86, so the table's last line is wider than 80 columns - the box's is too,
  and neither wraps it. `show ip ospf interface brief` keeps the abbreviation (`Gi0/0`), which is
  what the same box prints there.
* `Pri` reads the neighbour's Hello priority, carried as `ospfNeighbors[].priority` and configured
  with `ip ospf priority <0-255>` (default 1); the election in `computeOspf()` reads the same field,
  so the cell and the role beside it cannot disagree. See `research/show-ospf-neighbor-state.md`.
* `Dead Time` is the Router Dead Interval counting down, taken from `convergence.ospfTimers()` -
  the same timers the convergence schedule runs OSPF on, so a lab carrying other numbers sees the
  countdown those numbers produce. Hellos start at t=0 and repeat every `helloSec`, so the last one
  arrived at the largest multiple of `helloSec` at or before the instant being asked about, and the
  cell is `deadSec` minus the time since then, floored at zero.
* The converged answer (`runAtMs === Infinity`) has no instant to count from, so it prints the
  interval itself - the cell in the moment after a Hello. Cisco's samples of 31-39 s are that cell
  part-way through, which a finite run instant reproduces.

## What is inferred

* **The countdown's origin.** The model assumes Hellos leave exactly on the tick, with no jitter and
  no per-neighbour offset. Real captures show three neighbours in one table at 32, 33 and 39 s,
  because Hellos are heard at different moments and the box rounds; here every row of a table shares
  one value.
* **The flooring.** `deadSec - elapsed` is rounded to the nearest second, which is what makes the
  converged default read `00:00:40` rather than `00:00:39`. A capture of a real countdown at a known
  elapsed time would replace that guess with a measurement.
* **Suppressing the hour.** The cell is `HH:MM:SS`; no capture with a dead interval of an hour or
  more was found, so whether IOS prints `01:00:00` or `60:00` there is unverified (this console
  always prints two-digit hours).

## What is unresolved

* Whether any IOS release abbreviates the Interface cell of `show ip ospf neighbor`. Every paste
  found spells it out; the one abbreviated row is a blog's hand-typed example (`Gig0/0`), which is
  also the spelling no `show` command in this family uses (`Gi0/0` would be the abbreviation). A
  paste from a box with a very long name (`TwentyFiveGigE1/0/1`) would show whether the box ever
  shortens it to keep the row near 80 columns - this table does not.

* What a real box prints when the countdown reaches zero: whether the row vanishes, drops to
  `DOWN`, or shows `00:00:00` for one more refresh. This model has no per-neighbour expiry - an
  adjacency either exists in `computeOspf()` or does not - so no row can age out, and the cell stops
  at `00:00:00` rather than the row disappearing.
* `FULL/ -` versus `FULL/  -`. The ntc capture has two spaces before the dash, Cisco's own prose
  prints one, and this console prints one. It is an intra-cell difference only; the column does not
  move.
* The `Area` column Dell adds, and the long `detail` form of the command, are both out of scope here.
* `ip ospf priority` is still not configurable, so `Pri` can only ever be 1 - the column is right by
  construction, not by measurement.

## What evidence would settle the remainder

1. One paste of `show ip ospf neighbor` on a box where `ip ospf priority 200` is set on one end:
   pins both the right-alignment of a three-digit priority and that the field is the neighbour's.
2. A capture that includes the moment a neighbour goes away (`debug ip ospf adj` alongside, or two
   pastes a dead interval apart), to see whether the row is removed or marked.
3. A box with `ip ospf dead-interval 3600`: one line settles whether the hour is printed as `01:00:00`.
