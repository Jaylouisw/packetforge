# `show ip ospf interface <port>` on a shut port: refusal, or the block?

**Question (one, narrow).** A port that exists, holds an address and is covered by the OSPF process, but is
administratively disabled: does `show ip ospf interface <port>` answer with the one-line tagged message
`%OSPF: OSPF not enabled on <port>`, or with the port's interface block - and if a block, which line opens it?

**Verdict: the block, and its first line is the port's own state line.** Two independent captures, one the
per-port form and one the unfiltered table, both open with `<port> is administratively down, line protocol is
down` at the left margin and print `Internet Address <addr>/<len>, Area <id>` two spaces in on the next line.
Neither prints `%OSPF: OSPF not enabled`. That matters because it also settles a rule this engine had written
down the wrong way: a shut port is **still an OSPF interface** - it is listed, it belongs to an area, and it
just cannot form an adjacency - so "OSPF runs on no shut port with an address" is false.

## Evidence

| Source | Prints |
| --- | --- |
| [howtonetwork.org, "Troubleshooting Route Advertisement"](https://www.howtonetwork.org/tshoot/module-6/troubleshooting-route-advertisement/) | `R1# show ip ospf interface loopback 100` -> `Loopback100 is administratively down, line protocol is down` / `Internet Address 100.1.1.1/24, Area 0` / `Process ID 1, Router ID 1.1.1.1, Network Type LOOPBACK, Cost: 1` / `Enabled by interface config, including secondary ip addresses` / `Loopback interface is treated as a stub Host`. The same page's earlier `show ip ospf interface brief` lists that port: `Lo100 1 0 100.1.1.1/24 1 DOWN 0/0` - **DOWN** in the State column, still a row of the OSPF table. |
| [TECH PROjin, "OSPF neighbour failures 1"](https://tech.pjin.jp/blog/2017/10/31/ospf_neighbor_1/) (IOS 12.4) | `R1#show ip ospf interface` -> `FastEthernet0/0 is administratively down, line protocol is down` / `  Internet Address 192.168.100.1/24, Area 0` / `  Process ID 1, Router ID 1.1.1.1, Network Type BROADCAST, Cost: 1` / ... / `  Transmit Delay is 1 sec, State DOWN, Priority 1`. The same page prints the config responsible: `interface FastEthernet0/0` with `ip address 192.168.100.1 255.255.255.0`, `ip ospf 1 area 0` and `<the disable verb>`. Note the indentation: the first line flush left, every field under it two spaces in. |

Both boxes state the port in the long type spelling (`loopback 100` typed, `Loopback100` printed), and both put
`State DOWN` in the body of the block - absent from the brief table's vocabulary, which is where a reader looks
for "is this port up".

## What PacketForge did, and what changed

`_showOspf()`'s per-port branch reached the shut case through `dev.ospfInterfaces`, which `computeOspf()` fills
only from ports that are `enabled` **and** addressed (`engine/simulator.js`, `if (!i.enabled || !i.ip ...)
continue`). A shut port therefore had no row, and the branch answered with a sentence of this console's own
invention: `% Gi0/1 is administratively down: OSPF runs on no shut port with an address`.

That sentence is now gone. For a shut port that holds an address, the console prints the captured head of the
block:

```
GigabitEthernet0/0/1 is administratively down, line protocol is down
  Internet Address 10.2.0.1/24, Area 0
```

The area is the port's own `ip ospf area` override when one is set, else the process default - the same two
values `computeOspf()` would have used, from the same config. Nothing after those two lines is printed, because
the next fields (`Process ID`, `Network Type`, `State`, the DR/BDR lines and the timers) need facts this model
does not carry: it has no process id (the summary view says `Routing Process with ID <router-id>` for the same
reason) and no per-interface network type. A truncated block that stops where the model's knowledge stops is
more honest than a block whose numbers were invented.

For a shut port with **no address** the console prints `%OSPF: OSPF not enabled on <port>`. That is an
inference, not a capture: an interface with no address cannot be an OSPF interface, and the tagged line is the
documented message for every other disqualifier with no reason in it (`research/show-ospf-interface-not-enabled.md`,
points 1-5). No capture of a shut *and* unaddressed port was found.

## What is known, inferred, unresolved

**Known.** A shut port the process covers prints its block; the block opens with the port-state line and the
address/area line; the two-space indent; the port naming; that the brief table still lists the port with State
`DOWN`; that a 12.4 box and a modern lab box agree on all of it.

**Inferred.** That the same head appears on IOS XE 15.x/17.x Catalysts - both captures are routers (a lab
loopback and an IOS 12.4 ISR-class box), and no Catalyst capture was found.

**Unresolved.**

1. **The rest of the block.** `Process ID`, `Network Type`, `Cost`, `State`, the DR/BDR lines and the timer
   lines vary with the port's medium and with whether neighbours exist; printing them is a detail view this
   console does not have, and the numbers it would need (process id, network type) are not in the model.
2. **A shut port with no address.** Which line the box gives - see the inference above.
3. **`show ip ospf interface brief` on a shut port.** Both captures show the port listed with `DOWN`; this
   console's one table has no State column at all, so the fact has nowhere to go. Adding the column is a layout
   question of its own.

**What would settle 1 and 2.** A paste of `show ip ospf interface <port>` on (a) a shut port with no address,
and (b) a Catalyst 9200/9300 (IOS XE 17.x) with the same shut-port configuration as the pjin capture - the two
lines should repeat, and (a) should print `%OSPF: OSPF not enabled on <port>` if the inference is right.

## What changed

* `engine/cli.js`, `_showOspf()`, the `!port.enabled` branch: the invented sentence replaced by the captured
  two-line head, gated on the port holding an address; the unaddressed case now prints the tagged message.
  The long name comes from `iface-name.displayName()`, the same expansion the neighbouring refusal uses.
* `test/show-ospf-interface-shut-port.test.js` (new, 13 checks): the two lines verbatim and in that order, the
  block stopping after them, no `%` and no `OSPF not enabled` for the addressed case, two spellings of the same
  port resolving to the printed long name, the per-port area override reaching the Area field, the unaddressed
  case drawing the tagged line, and an *up* port still answered by the table.
* `test/show-ospf-interface-not-enabled.test.js`: the shut branch's comment and assertion updated from "this
  console's own sentence, unsettled" to the captured head.
* `docs/CLI.md`: the paragraph that said a shut port keeps the console's own sentence now says what the box
  prints.
