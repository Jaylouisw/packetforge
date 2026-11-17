# The line under `show lldp neighbors`: what it says, and what its number counts

**Question (one, narrow).** On a Cisco-style switch, what does the box print *after* the last row of the
one-line neighbour table - the exact words, where they sit, and is the number a count of the rows printed
or something else?

**Verdict: known, and adopted.** The view ends with `Total entries displayed: N`, at the left margin, on the
line directly under the last row, and `N` is the number of rows the view printed. PacketForge printed the
rows and stopped, so a pasted table gave a reader no way to tell how many entries they were looking at
without counting them - and "how many neighbours are there" is the question this command is opened with when
a link stops working.

## The device's own output

Catalyst 3750/3750-E/3750-X, "Using LLDP Configuration Example" (document ID 113397) - a Catalyst IOS switch,
which is the platform class this model imitates:

```
Switch#show lldp neighbors
Capability codes:
    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device
    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other
Device ID Local Intf Hold-time Capability Port ID
Nortel IP Phone Gi1/0/1 180 T 0019.e1e7.018d
Polycom SoundPoint IGi1/0/19 180 T 0004.f22f.88b7
Baseline Switch 2426Gi1/0/18 180 P,B Ethernet0/26
Baseline Switch 2426Gi1/0/22 180 P,B Ethernet0/26
Total entries displayed: 4
```

(<https://www.cisco.com/c/en/us/support/docs/switches/catalyst-3750-series-switches/113397-lldp-3750-switch-00.html>)

Four rows, then the sentence, then the prompt. No blank line between the last row and the count, and the
sentence starts in the first column rather than under any heading.

| Source | Prints | What it settles |
| --- | --- | --- |
| Catalyst 3750/3750-E/3750-X LLDP configuration example (above) | `Total entries displayed: 4` after 4 rows | The words, the case, the colon and the position, on the platform class modelled here |
| [Nexus 3500 LLDP commands](https://developer.cisco.com/docs/nexus-3500-series-nx-api-cli-reference/latest/lldp-commands/) | `... Ethernet1/48` then `Total entries displayed: 45` | The same sentence on NX-OS, with a count large enough that a "one line per screenful" rule could not explain it |
| [Nexus 9000 LLDP commands](https://developer.cisco.com/docs/cisco-nexus-9000-series-nx-api-cli-reference/latest/lldp-commands/) | `show lldp neighbors interface ethernet 1/1 detail` ends `Total entries displayed: 1` | A *filtered* view counts its own rows: one neighbour asked for, one counted |
| [NCS 4000 LLDP command reference](https://www.cisco.com/c/en/us/td/docs/routers/ncs4000/software/reference/guide/otncommandreferenceguide/m-lldp.html) | `R1 TenGigECtrlr0/5/0/4/1 150 R TenGigECtrlr0/5/0/4/1` then `Total entries displayed: 1` | The same closing line on IOS XR, and the row is the `Hold-time` column's 150 |
| [Cisco 8000 IOS XR Ethernet interface commands (PDF)](http://www.cisco.com/c/en/us/td/docs/iosxr/cisco8000/Interfaces/b-interfaces-hardware-component-cr-8000.pdf) | `Total entries displayed: 2` for a two-neighbour table; `1` for a one-neighbour table | The number follows the rows it printed, in both directions |

Five samples across three operating systems, with no counter-example. The sentence is the view's, not one
platform's habit.

## What PacketForge does today

Before this run, `show lldp neighbors` printed the title, the column heading and the rows, and nothing after
them:

```
LLDP neighbours on Switch (L2)-sw:
  Neighbour                                  Local port  Port ID  Mgmt address
  ASR 1001-X aggregation services router-r1  Fa0/1       Gi0      10.0.0.1
  PC-pc                                      Fa0/2       eth0     -
```

`show lldp` and `show lldp neighbours` (the British spelling the console also accepts) printed the same
table, so all three spellings now end the same way.

## What is known, inferred, unresolved

**Known.** The sentence is `Total entries displayed: N`, with that capitalization and that colon, printed at
the left margin directly under the last row. `N` is the number of rows the view printed: the filtered Nexus
detail view counts one, and the full Nexus 3500 view counts 45 against no more rows than that on screen.

**Inferred.** That a *filtered* brief view counts its own rows on Catalyst IOS - the filtered sample is the
NX-OS detail view. This console has no filters on `show lldp neighbors`, so nothing here depends on it.

**Unresolved.** What a box prints when it has heard nothing: whether the sentence reads
`Total entries displayed: 0` or is absent, and whether the capability-codes legend is printed above an empty
table. No vendor page in hand shows an empty neighbour table. This console prints its empty-state prose
(`(none - no LLDP has been heard on any port)`, `(none - every neighbour has gone past the hold-time it
advertised ...)`) and no count, and a regression test pins that choice rather than letting it drift.

**Also out of scope, and why.** The legend and the header's `Hold-time` and `Capability` columns belong to
the vendor's table shape, and they were deliberately not taken here. A legend defining `(R)`, `(B)`, `(T)` and
the rest would be furniture for a `Capability` column this table does not have; adding the legend without the
column would be a key to a lock that is not on the door. That column set is its own question, already recorded
as such at the end of `research/lldp-hold-time-column.md`.

**What would settle the empty case.** On a Catalyst with LLDP running and no neighbours (`show lldp neighbors`
on a lab with every cable out, or with `no lldp run`), read the output. A `Total entries displayed: 0` line
settles it one way; its absence, with the legend still printed, settles it the other.

## What was changed

* `engine/cli.js` - `show lldp [neighbors|neighbours]` prints `Total entries displayed: <rows>` as its last
  line when it has rows, with the evidence cited at the call site.
* `test/lldp-total-entries.test.js` - 17 checks: the sentence and its position, that the number equals the rows
  printed, that it is plural for a single row, that aging a neighbour out removes it from the count rather
  than the count surviving the row, that a row for a downed port is still counted because it is still printed,
  that an empty table prints none, and that all three accepted spellings agree.
* `docs/CLI.md` - the `show lldp` transcript and one paragraph saying what the count counts, and what the
  empty case deliberately leaves out.
