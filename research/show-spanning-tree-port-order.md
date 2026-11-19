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

## Known, inferred, unresolved

**Known.** On a Catalyst the rows ascend with the port number inside a type: 9 before 10 before 11, and a
string sort would put 10, 11, 13 … before 2. The row's `Prio.Nbr` column (128.9, 128.10, …) counts with it,
which is a second, independent sign that the box is walking its port list.

**Inferred.** That the rule is the interface index rather than anything about the names: the transcripts span
Fast Ethernet and Gigabit Ethernet, classic IOS and IOS XE, and both ascend. No source states the rule in
words; it is read off the captures.

**Unresolved.** The order between two *types* of port in one table - a box uses the platform's interface index,
which groups the port ASICs in a hardware order this model cannot know (on a 2960 the `Fa0/x` and `Gi0/x` port
ASICs have fixed indices, but which comes first is not something the captures in hand show). This console
leaves that tie to the type word, as it always did, and no capture is claimed for it. Also unresolved: whether
a box lists ports that are not in the tree at all - this model prints only ports the election reached - which
is a question about the row *set*, not its order, and is not touched here.
