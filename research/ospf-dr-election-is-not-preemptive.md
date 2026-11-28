# The OSPF DR/BDR election does not preempt

**Question (one, narrow).** Three or four routers share one access switch, all in area 0, all at the
default interface priority. One of them is given `ip ospf priority 200` in place - the ordinary way an
operator tries to move the DR. On a box nothing happens: `show ip ospf neighbor` still names the old
DR, and the newcomer stays a DROTHER until the DR goes away or the process is cleared. This model's
`computeOspf()` is a converged-graph pass with no memory, so it held a fresh election on every run: the
router was DR by the time the *next* `show ip ospf neighbor` asked, and a router that lost its cable
and got it back took the seat back from whoever had been holding it.

**Verdict: the seats are incumbents, and the answer of one election is the input to the next.** That is
not a house rule - it is what RFC 2328 section 9.4 already describes, because the election is run over
what each router last *declared* in its Hellos, not over the ranking alone. A router that has been DR
keeps saying so, so it wins the seat against a higher-priority router that has never declared anything;
and when nobody declares the DR seat, `assign the Designated Router to be the same as the newly elected
Backup Designated Router` - the promotion. `computeOspf()` now keeps the two seats per router port on
the topology (like a DHCP lease, so the answer survives the request that produced it) and lets them
stand while the incumbent is still on the segment and still eligible. A first election - no incumbents -
is unchanged: highest Router Priority, then highest Router ID.

## The evidence

| Source | What it gives |
| --- | --- |
| [RFC 2328 section 9.4, *Electing the Designated Router*](https://www.rfc-editor.org/rfc/rfc2328.txt) (p. 75-76) | The algorithm is stateful by construction. (1) `Note the current values for the network's Designated Router and Backup Designated Router. This is used later for comparison purposes.` (2) The BDR is chosen from routers that `have declared themselves Backup Designated Router ... the one having highest Router Priority`, and only `if no routers have declared themselves Backup Designated Router` does the plain ranking apply. (3) The DR likewise: `If one or more of the routers have declared themselves Designated Router ... the one having highest Router Priority is declared to be Designated Router. ... If no routers have declared themselves Designated Router, assign the Designated Router to be the same as the newly elected Backup Designated Router.` (4) Steps 2 and 3 are repeated when the router's own role changed, so a promoted BDR vacates its own seat. |
| [RFC 2328 section 7.3, *The Designated Router*](https://www.rfc-editor.org/rfc/rfc2328.txt) | Why the declaration is the whole mechanism: `when a router's interface to a network first becomes functional, it checks to see whether there is currently a Designated Router for the network. If there is, it accepts that Designated Router, regardless of its Router Priority. (This makes it harder to predict the identity of the Designated Router, but ensures that the Designated Router changes less often.)` |
| [Cisco, *Scaling Networks v6.0*, Chapter 10 instructor deck (PDF)](http://vapenik.s.cnl.sk/pcsiete/CCNA3/10_OSPF_Tuning_Tshoot.pdf), slides 11 and 13 | The rule in the vendor's own words: `OSPF DR and BDR elections are not pre-emptive. If a new router with a higher priority is added to the network after the DR election, the newly added router does not take over the DR or the BDR role because those roles have already been assigned. If the DR fails, the BDR is automatically promoted to DR even if another DROTHER with a higher priority or router ID is added ... After a BDR is promoted to DR, a new BDR election occurs and the DROTHER with the higher priority or router ID is elected as the new BDR.` Slide 13 adds the priority case - `Priority changes do not automatically take effect because the DR and BDR are already elected` - and the two cures: re-enable the interfaces `starting with the desired DR, then the desired BDR, and then all other routers`, or `clear ip ospf process` on all routers. |
| [NetworkLessons, *OSPF DR/BDR Election explained*](https://networklessons.com/ospf/ospf-drbdr-election-explained) - three routers on one switch, one box's console throughout | The live case, with the Dead Time counting down between the two tables: `R1(config-if)#ip ospf priority 200`, then `R1#show ip ospf neighbor` still reads `192.168.123.2   1   FULL/BDR` / `192.168.123.3   1   FULL/DR`; only after `clear ip ospf process` on R2 and R3 does R1's table read `192.168.123.2 1 FULL/DROTHER` / `192.168.123.3 1 FULL/BDR`, and R3's read `192.168.123.1   200  FULL/DR`. This is the transcript `"What would settle it"` asked for in `research/ospf-segment-adjacency.md`. |
| [Cisco Community, "DR/BDR Election Process in Broadcast Network"](https://community.cisco.com/t5/routing/dr-bdr-election-process-in-broadcast-network/td-p/4419812) | A tested account of the two elections: `Brought up a new OSPF router in that network configured with a higher OSPF priority. Even with a router with higher priority present in the network there was no change in DR/BDR. Then rebooted the existing DR so it was no longer in service. The result is that the previous BDR became the new DR and the router with higher priority became new BDR. So there is no preemption and it would take 2 OSPF elections before the router with higher priority became DR.` |
| [Cisco Community, "Reselection of DR (OSPF)"](https://community.cisco.com/t5/routing/reselection-of-dr-ospf/td-p/4803100) | The withdrawal: `When you change the existing DR priority to zero then that router withdraws as DR and the current BDR immediately (and automatically) becomes the new DR.` RFC 2328 section 9.4 agrees - priority-0 routers are discarded from the list before any step runs, so an incumbent that has just been set to 0 is not on it. |
| [Cisco Learning Network, "OSPF : Remember old DR ??"](https://learningnetwork.cisco.com/s/question/0D53i00000Ksx3BCAR/ospf-remember-old-dr-) | The returning ex-DR: `When the old DR comes back up, it waits for the period of the wait timer, 40 seconds, and if it hears a hello that announces another DR on the segment, this old DR exits the wait state and become the BDR here.` A router that has been away has no live declaration to press. |

## What is known

1. The seat changes hands only for a reason: the holder fails, its OSPF process stops, its multiaccess
   interface fails or is shut, or its priority is set to 0. All three sources list the same set.
2. A newcomer - higher priority or higher router ID - does not take a seat, and if the DR seat frees up
   the BDR takes it ahead of the newcomer even though the newcomer outranks it.
3. After that promotion the *BDR* seat is voted on, and the newcomer can win that. So a router with the
   best priority on a segment needs two elections to become DR, which is exactly the two-election
   sequence the Cisco Community test reports.
4. A priority of 0 removes the holder from the election rather than losing it the vote, so the seat is
   vacated in the same instant the value is typed.
5. The election runs over a *list* very like the model's segment: RFC 2328 section 9.4 says "the list of
   neighbors attached to the network and having established bidirectional communication", plus the
   router itself. A port that is down is not on it, which is why a shut interface vacates a seat.

## What is inferred

* **That "declared in its Hello" can be stood in for by "held the seat at the last election".** The
  model has no Hellos, so it has no declaration field either, and the previous answer is the only
  evidence it can hold about one. The two agree whenever nothing else changed - a router that was DR
  and is still standing on the segment is, in the real thing, still declaring itself DR - and they
  disagree only where the model has nothing to say anyway (see the Wait timer below).
* **That incumbency belongs to the port, not to the router.** RFC 2328 elects per *network*, and a
  router with two interfaces in the same broadcast domain would hold two roles. Keying the memory on
  `<deviceId>/<port>` is the smallest mapping that keeps that true, and it is what makes a port that
  leaves the segment lose its claim: it is not in the new member list, so the rebuilt map drops it.
* **That a departed router has no claim when it returns.** RFC 2328 section 7.3 has a returning
  interface accept whatever DR it hears; the Cisco Learning Network thread shows the same router coming
  back as BDR, not DR. Nothing in the model distinguishes "still standing" from "just came back" except
  whether an election ran while it was away, and if one did, its claim is gone - which is the behaviour
  those two sources describe.

## What changed in the engine

* `engine/simulator.js`, the per-segment election under `computeOspf()`: the ranking is still the
  only vote, but it now fills a *vacant* seat. An incumbent DR still standing and still eligible keeps
  the DR seat; with that seat empty, an incumbent BDR is promoted ahead of the ranking; with both
  empty, the ranking wins. The BDR seat goes to the incumbent BDR unless it has just been promoted, in
  which case the ranking fills it - RFC 2328 section 9.4 steps 2-4. The two seats are then written back
  to `topo.ospfRoles` (a `Map` of port to role), which is where the next pass reads them.
* `engine/topology.js`: `ospfRoles` is created with the board, beside `dhcpStates`, because it is the
  same kind of fact - an answer the lab keeps between requests. It is deliberately not serialised into
  saved documents.
* `server/index.js` `/reset`: clears the seats with the leases. A reset re-elects, which is the only
  thing in the model that does what `clear ip ospf process` does on a box.
* `test/ospf-dr-election-is-not-preemptive.test.js` (28 assertions): a first election still votes; a
  router raised to priority 255 in place keeps its 2WAY row and does not take the seat; after the seats
  are cleared it does; a failed DR's seat goes to the BDR even with a 255 DROTHER standing by, and the
  open BDR seat then goes to the ranking; a returning ex-DR comes back as a DROTHER; a priority of 0
  withdraws an incumbent immediately and does not hand it the BDR seat; and a second `Simulator` on the
  same board reaches the same answer, which a reset does not.

## What remains unresolved

* **The Wait timer.** A real interface that comes up, hears no DR and no BDR within RouterDeadInterval
  (40 s at the defaults) declares *itself* DR, whatever its priority. That is why Cisco's own recipe
  for forcing an election is to re-enable the interfaces "starting with the desired DR" - first up
  wins. This model has no such wait: a segment with no incumbents is always decided by priority, so
  whichever router powered on first has no claim. Every capture above has the order of events settled
  (a segment that was already up, or all routers coming up together), so nothing in this change is at
  odds with them - but a lab built as "r1 (priority 1) boots, then r4 (priority 255) boots ten seconds
  later" should end with r1 the DR, and here it ends with r4. **What would settle it:** a
  `debug ip ospf adj` capture with timestamps across a staggered power-on, showing the first router
  declaring itself DR at the end of the wait interval and the second one accepting it.
* **Per-router `clear ip ospf process`.** The command is not modelled, and Cisco's own instructions
  clear the process on *all* routers; only the whole-lab `/reset` exists. A student typing the command
  the lesson uses is still refused by the console.
* **The roles are not saved with the lab.** `ospfRoles` lives in memory, so a document reopened from
  disk re-votes the seats. That is defensible - a reopened lab is a lab that rebooted, and the roles
  above show a rebooted set of routers electing by priority - but it is a choice, not evidence.
* **`show ip ospf interface` prints no seats.** A real box names the DR and the BDR it believes in
  ("Designated Router (ID) 3.3.3.3, Interface address 10.0.0.3"), and this model prints the area, the
  cost and whether the port is adjacent. So the only way to read a seat from this console is the role
  column of `show ip ospf neighbor` - and on a three-router segment a DROTHER's table shows two FULL
  rows and nothing else, which is what a box prints too. That is a separate question with its own
  evidence and was left alone here.
