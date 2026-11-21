# `show ip ospf neighbor` with no neighbours: nothing at all, or a header over nothing?

**Question (one, narrow).** When a box has no OSPF adjacency, what does `show ip ospf neighbor` print —
the six-column heading with no rows under it, or no output at all? The answer decides whether the
heading is furniture the view always prints or a header that is written for rows.

**Verdict: nothing at all. The header is printed only when there are rows to head.** A machine-recorded
IOS XE 17.18.2 capture answers the exact case — one router with a neighbour in INIT, the other with no
neighbour — and the second router's command returns no header, no blank row and no count. Cisco's own
troubleshooting page lists "nothing at all" as one of the answers this command can reveal, and two
further transcripts show the same blank result. This console printed the heading *before* it asked
whether the table had rows, so a lab with no adjacency answered with a six-column heading over a
sentence — a table no box can produce.

## The capture that settles it

pinglabz, "OSPF Stuck in INIT: Diagnosing the One-Way Hello" — a live lab, two `iol-xe` routers on IOS
XE 17.18.2 in Cisco Modeling Labs, with the statement "No output on this page was typed by hand":
<https://www.pinglabz.com/ospf-stuck-in-init-one-way-hello/>

```
R1# show ip ospf neighbor
Neighbor ID     Pri   State           Dead Time   Address         Interface
2.2.2.2           1   INIT/DROTHER    00:00:32    10.0.12.2       Ethernet0/0

R2# show ip ospf neighbor
(no output - R2 has no OSPF neighbor at all)
```

One box, one instant, both answers: R1 has a row and therefore a heading; R2 has no neighbour and
therefore nothing, not a heading with an empty body. The page's own reading of that answer is "an empty
neighbor table … not an error, not a partially formed neighbor. Nothing."

## The evidence

| Source | What it says |
| --- | --- |
| [pinglabz, "OSPF Stuck in INIT"](https://www.pinglabz.com/ospf-stuck-in-init-one-way-hello/) (IOS XE 17.18.2, machine-recorded) | R1 prints the header and one row; R2 prints nothing at all, annotated "(no output - R2 has no OSPF neighbor at all)". The two answers are side by side in one capture, so this is not a formatting guess. |
| [Cisco, "Troubleshoot OSPF Neighbor Problems" (13699-29)](https://www.cisco.com/c/en/us/support/docs/ip/open-shortest-path-first-ospf/13699-29.html) | "The output of this command reveals one of these: **nothing at all**; state = down; state = init; …" — an empty answer is named as an outcome of the command, not as a failure to answer, and "If the `show ip ospf neighbor` command reveals nothing at all … then this router has not received any 'valid' OSPF HELLOs". |
| [networklessons, "Troubleshooting OSPF Neighbor Adjacency"](https://networklessons.com/ospf/troubleshooting-ospf-neighbor-adjacency) | `R1#show ip ospf neighbor` is followed by a blank line and nothing else in the captured session (the text resumes with "As you can see we don't have any OSPF neighbors"); the same page then shows the populated table with its heading. |
| [Cisco Community, "Ospf Neighbors" (td-p/1374827)](https://community.cisco.com/t5/routing/ospf-neighbors/td-p/1374827) | "The fact that the `show ip ospf neighbor` output is empty is a good indication that there is a problem in basic neighborhood/adjacency establishment" — an empty table is discussed as *empty output*, the thing an operator sees before any heading appears. |

The heading itself is not in doubt when rows exist: ntc-templates keeps the raw CLI text for
`show ip ospf neighbor` (the capture this console's column widths were measured on), and every Cisco
sample of the populated table opens with the same six cells. `research/ospf-neighbor-table-layout.md`
carries those sources; this note is only about the empty case.

## What changed

`engine/cli.js`, `_showOspf()`: the `Neighbor ID  Pri  State  Dead Time  Address  Interface` heading is
now pushed after the empty-table branch instead of before it. An empty answer therefore prints the
console's own one-line reason and no heading. The reason stays because it is the answer this console
gives for a table it can explain (a passive port, a refused link, a port that is not carrying OSPF, or
"no OSPF state has been evaluated yet") — the same trade `show lldp neighbors` makes with its
`(none - …)` line. It is the console's sentence, not the box's: a real box prints nothing at all here,
and a reader who wants the hardware's silence has it by deleting the line, not by keeping a heading
that claims a table.

The sibling view already worked this way: `show ip ospf interface` with nothing to report prints its
`% no OSPF state has been evaluated yet - run a simulation` line with **no** header above it
(`engine/cli.js`, the `_showOspf()` interface branch). The neighbour table was the odd one out.

## Known, inferred, unresolved

**Known.** An IOS XE 17.18.2 box with no neighbour answers `show ip ospf neighbor` with nothing at all,
while the same command on a box with one neighbour prints the header and the row. Cisco documents
"nothing at all" as one of this command's answers.

**Inferred.** That the same is true on classic IOS 15.x: the networklessons capture (IOS 15-era
`FastEthernet` naming) is blank, but that page's session does not carry a version banner, so the
platform is inferred from the interface names rather than from a `show version`.

**Unresolved.**

* **The `detail` form with no rows.** Whether `show ip ospf neighbor detail` prints its block header
  when the table is empty is not shown by any capture in hand. This console has no detail form, so
  nothing prints it either way.
* **A platform that prints the heading anyway.** No sample was found of a heading over zero rows on any
  IOS/IOS XE release; if one exists, it is the exception this note's rule would be wrong about.
* **The console's own trailing count.** `docs/CLI.md` shows a `1 neighbour(s), all Fully adjacent` line
  under a populated table; that line is this console's, not the box's (the same shape as
  `Total entries displayed: 0` in `show lldp neighbors` but without a vendor original). It is untouched
  here because the question was the heading, not the count.

**What would settle the rest.** On one IOS 15.x and one IOS XE 17.x box with an OSPF process and no
neighbours, `show ip ospf neighbor`, `show ip ospf neighbor detail` and
`show ip ospf neighbor | include Neighbor` (the filter prints the heading only if the command produced
one), with `terminal length 0` so no `--More--` truncates the answer.
