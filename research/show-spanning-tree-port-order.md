# `show spanning-tree`: in what order does a box list its port rows?

**Question (one, narrow).** In the one-line-per-port table `show spanning-tree` prints, in what order do the
rows run - the order the names sort as strings (`Gi1/0/1`, `Gi1/0/10`, `Gi1/0/11`, `Gi1/0/2`, …) or the order
of the ports themselves (`Gi1/0/1`, `Gi1/0/2`, … `Gi1/0/10`)?

**Verdict: port order.** Two live transcripts on Catalyst hardware print ten and eleven where ten and eleven
belong, and one of them would have to be printed in a wholly different sequence under a string sort. This
console built the table from `Object.keys(st.states).sort()`, a plain string sort, so every switch with ten or
more ports in the tree listed `Gi1/0/10` before `Gi1/0/2`. The sort is now numeric-aware, and
`test/stp-port-order.test.js` pins both transcript shapes. Nothing else about the table changed.

## The evidence

| Source | Says |
| --- | --- |
| [Spiceworks Community, "DHCP suddenly fails on specific VLAN and specific ports", post of 30 Mar 2021](https://community.spiceworks.com/t/dhcp-suddenly-fails-on-specific-vlan-and-specific-ports/795152?page=2) | A live stack member's `#sh spanning-tree vlan 10`, pasted by the operator: `Interface Role Sts Cost Prio.Nbr Type` then `Gi1/0/4 … 128.4`, `Gi1/0/5 … 128.5`, `Gi1/0/6 … 128.6`, `Gi1/0/9 … 128.9`, `Gi1/0/10 … 128.10`, `Gi1/0/11 … 128.11`, `Gi1/0/13 … 128.13`, `Gi1/0/14`, `Gi1/0/15`, `Gi1/0/16`, `Gi1/0/25`, `Gi1/0/27`, `Gi1/0/30`, `Gi1/0/31`, `Gi1/0/41`, `Gi1/0/43`. Nine, ten, eleven in that order, with `Prio.Nbr` counting up beside them. |
| [Cisco Community, "Inconsistent inferior PVST BPDU received on VLAN 10", `XXXXSW-050#show spanning-tree`](https://community.cisco.com/t5/switching/inconsitent-inferior-pvst-bpdu-received-on-vlan-10/td-p/4852991) | A C9300 stack member: `Gi1/0/1 Root BKN*`, `Gi1/0/2`, `Gi1/0/6`, `Gi1/0/8`, `Gi1/0/10`, `Gi1/0/11`, `Gi1/0/13`, `Gi1/0/15`, `Gi1/0/17`, `Gi1/0/20`, `Gi1/0/22`, `Gi1/0/23`. A string sort of those same twelve names would print `Gi1/0/10, Gi1/0/11, Gi1/0/13, Gi1/0/15, Gi1/0/17, Gi1/0/2, Gi1/0/20, Gi1/0/22, Gi1/0/23, Gi1/0/6, Gi1/0/8` - so this single capture rules the string order out on its own. |
| [CCNP SWITCH lab guide, "Spanning Tree Protocol (STP) Default Behavior"](https://netacad.fit.vutbr.cz/wp-content/uploads/ccnp/switch/v7-new/SWITCH_M4_ENG_v7.pdf) | A lab capture on `DLS2`: `Fa0/7 Desg FWD 19 128.9 P2p`, `Fa0/8 … 128.10`, `Fa0/9 … 128.11`, `Fa0/10 … 128.12`, `Fa0/11`, `Fa0/12` - the same rule on a Fast Ethernet platform, and the same `Prio.Nbr` running in step with the port number. |
| [Catalyst 2960 Command Reference 15.0(1)SE, `show spanning-tree`](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-0_1_se/command/reference/cr_2960/cli2.html) | The vendor's own sample output, for the shape of the row rather than the order: `GigabitEthernet2/0/2 desg FWD 200000 128 P2P bound(STP)` and a `Port-channel1 desg FWD …` row. Secondary here: it is a trimmed example, not a full table. |

## What PacketForge did

`engine/cli.js`, inside the `show spanning-tree` branch:

```js
const names = Object.keys(st.states || {}).sort();          // before
```

Measured on `278e7f42`, one `C2960X-24TS-L` with twelve of its ports cabled to twelve other switches:

```
Port          Role          State
Gi1/0/1       designated    listening
Gi1/0/10      designated    listening
Gi1/0/11      designated    listening
Gi1/0/12      designated    listening
Gi1/0/2       designated    listening
...
```

after:

```js
const names = Object.keys(st.states || {}).sort(function (a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
});
```

and the same lab prints `Gi1/0/1, Gi1/0/2, … Gi1/0/9, Gi1/0/10, Gi1/0/11, Gi1/0/12`. `test/stp-port-order.test.js`
checks the twelve-port sequence, the sparse shape the C9300 transcript prints (`2, 6, 8, 10, 11`), and that a
bundle row is where it was. The numeric-aware `localeCompare` is the spelling `show arp` already uses to order
its address rows, so there is one way of sorting names in this file, not two.

## The tie between two types of port, captured

The row order *across* types was left open above. It is now settled for the shape that dominates the
catalogue's switches - a 24-port Fast Ethernet access block with two Gigabit uplinks - and it is settled
*against* the idea that the type word decides anything.

| Source | Says |
| --- | --- |
| [Wendell Odom, *CCNA 200-301 Official Cert Guide* Vol. 1, Appendix O, Example O-12](https://ptgmedia.pearsoncmg.com/imprint_downloads/cisco/bookreg/9780135792735/resources/9780135792735_AppO.pdf) | `SW3# show spanning-tree vlan 10` on a switch with 24 Fast Ethernet ports and two Gigabit uplinks. The `Root ID` block reads `Port 25 (GigabitEthernet0/1)`, and the table is `Fa0/13 Desg FWD 19 128.13 P2p Edge`, then `Gi0/1 Root FWD 4 128.25 P2p`, then `Gi0/2 Altn BLK 4 128.26 P2p`. Example O-13 prints the same three rows again under RSTP. The root port is a Gigabit port and it is still listed *last*, after a Fast Ethernet port that is further down the table. |
| [InfoSec Institute forum, "STP Designated switch/port", `2950B#show spanning-tree`](https://community.infosecinstitute.com/discussion/16725/stp-designated-switch-port) | Two adjacent rows: `Fa0/24 Desg FWD 19 128.24 P2p` and `Gi0/1 Desg FWD 4 128.25 P2p`. The last Fast Ethernet port and the first Gigabit port are consecutive rows with consecutive indices, so nothing separates the two blocks. `2950A` prints the same pair. |
| [Cisco Community, "High Latency issue to gateway switch", `CAP2# show spanning-tree`](https://community.cisco.com/t5/switching/high-latency-issue-to-gateway-switch/td-p/2728257) | `Fa0/24 Desg FWD 19 128.24 P2p` then `Gi0/1 Desg FWD 4 128.25 P2p` - the same pair on a different box in a different network. |
| [tek-tips, "InterVLAN Routing - Cant ping between VLANs from the catalysts"](https://www.tek-tips.com/threads/intervlan-routing-cant-ping-between-vlans-from-the-catalysts.1643773/) | `Fa0/24 Desg FWD 19 128.24 P2p Edge` then `Gi0/1 Root FWD 4 128.25 P2p` - same order, and the `Edge` cell shows it is a full table, not a filtered one. |

Four boxes, four networks, one answer: **the Fast Ethernet block is listed first and the Gigabit uplinks
follow it**, because the uplinks hold indices 25 and 26 and the box walks its index. A reader who expected
the root port at the top of the table is reading the root *cost* block, which does name it (`Port 25
(GigabitEthernet0/1)`); the port table is in port order.

That is also the order this console prints, without having been told to: `Fa0/1` sorts before `Gi0/1` as a
string, so the type-word tie-break and the index happen to agree on this shape. Nothing in `engine/cli.js`
changes because of this section.

## The same shape, opposite index layout

A capture that agrees with the type word is a coincidence of that platform rather than a rule, and there is a
transcript that shows the coincidence is not universal:

| Source | Says |
| --- | --- |
| [Course deck derived from Cisco's CCNP SWITCH material, "The show spanning-tree Command"](https://netacad.fit.vutbr.cz/wp-content/uploads/ccnp/switch/v7-new/SWITCH_M4_ENG_v7.pdf) | `DLS2# sh spanning-tree` (MST0) prints `Fa0/7 Desg FWD 200000 128.9 P2p` through `Fa0/12 … 128.14`, and the same box's `Root ID` gives `Port 13 (FastEthernet0/11)`; a second slide on the same box shows `do sh span vlan 1 int fa 0/7` with `112.9`. So on `DLS2` the Fast Ethernet block does **not** start at index 1: `Fa0/7` is index 9 and `Fa0/1` would be 3. |
| same deck, "STP Switch and Port Parameters" | `Prio.Nbr` is `128` (one byte, default) and then **the port index** (one byte) - so the second number in the cell is the index, not a count of rows printed. |

`DLS2` has the same *name* shape as the four boxes above - `Fa0/x` plus `Gi0/1`–`Gi0/2` - and numbers its
ports two places off. Either its two Gigabit uplinks hold indices 1 and 2 (the only ports on such a box that
are not Fast Ethernet) or two other ports do; the capture does not say which, and this note does not guess.
What it does say is that the index layout is a property of the platform, not of the type words: two boxes
whose interface names look identical order their port blocks differently.

## A row set, answered in passing

The Pearson capture also answers the older side-question about the *set* of rows: `SW3` has 26 ports and
prints three rows - the two Gigabit uplinks and the one Fast Ethernet port that is cabled. The twenty-odd
uncabled Fast Ethernet ports are not listed. This console behaves the same way (it prints the ports the
election reached), so the row set is corroborated by the same transcript, on a box where the omission is
visible because the table is otherwise tiny.

## Known, inferred, unresolved

**Known.** On a Catalyst the rows ascend with the port number inside a type: 9 before 10 before 11, and a
string sort would put 10, 11, 13 … before 2. The row's `Prio.Nbr` column (128.9, 128.10, …) counts with it,
which is a second, independent sign that the box is walking its port list.

**Inferred.** That the rule is the interface index rather than anything about the names: the transcripts span
Fast Ethernet and Gigabit Ethernet, classic IOS and IOS XE, and both ascend. No source states the rule in
words; it is read off the captures.

**Unresolved.** The order between two *types* of port where the platform's index layout does not follow the
names. Settled for the shape that four captures show (`Fa0/1`–`Fa0/24` at indices 1–24, `Gi0/1`–`Gi0/2` at
25–26, Fast Ethernet block first) and shown *not* to be universal (`DLS2`, where `Fa0/7` is index 9). Which
ports hold indices 1 and 2 on `DLS2` is not stated by that capture, so the one table that would settle the
cross-type order on that platform - a `show spanning-tree` from it naming both an `Fa` and a `Gi` row - is not
in hand. What would produce it: any paste of `show spanning-tree` from a Catalyst whose Fast Ethernet block
starts at index 3, or whose uplinks are numbered `Gi0/1`–`Gi0/2` and appear in the same table as `Fa0/x`
rows. Until then this console keeps the type-word tie-break, which the captures now show is right on the
Fa-first boxes and is not claimed for the other layout.
