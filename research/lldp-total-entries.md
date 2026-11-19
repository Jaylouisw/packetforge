# The line under `show lldp neighbors`: what it says, and what its number counts

**Question (one, narrow).** On a Cisco-style switch, what does the box print *after* the last row of the
one-line neighbour table - the exact words, where they sit, and is the number a count of the rows printed
or something else?

**Verdict: known, and adopted.** The view ends with `Total entries displayed: N`, at the left margin, on the
line directly under the last row, and `N` is the number of rows the view printed. PacketForge printed the
rows and stopped, so a pasted table gave a reader no way to tell how many entries they were looking at
without counting them - and "how many neighbours are there" is the question this command is opened with when
a link stops working.

**The empty case is settled as well now: a box with nothing heard prints the same line, reading
`Total entries displayed: 0`.** That half was open in the first version of this note, which said a count of
zero would be invented; four captures above the line - two of them Catalyst 9300s - show the heading followed
straight by the zero, and Cisco's own IOS XE release notes print it for a filtered `show lldp entry *`. The
count is of the rows printed, so zero is the same rule as four, and the model now prints it for both empty
states.

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

### The empty table: five captures of a zero

| Source | Prints | What it settles |
| --- | --- | --- |
| [Cisco Community, "C9300 802.1x EAP-MD5 for IP-Phones not working"](https://community.cisco.com/t5/switching/c9300-802-1x-eap-md5-for-ip-phones-not-working/td-p/4141021) | A Catalyst 9300, LLDP running, dot1x holding the phone's LLDPDUs back: `Switch-C9300-001#sh lldp neighbors`, the capability legend, `Device ID Local Intf Hold-time Capability Port ID`, then `Total entries displayed: 0` | A real 9300 with no neighbour in the table prints the line, reading 0 - this is the platform class the model imitates |
| [Cisco Community, "PoE Error in Cisco 9300"](https://community.cisco.com/t5/switching/poe-error-in-cisco-9300/td-p/4992692) | `sh lldp neighbors gigabitEthernet 1/0/9` - the *filtered* view - prints the legend, the heading, `Total entries displayed: 0` | One port asked about, nothing on it: the zero is still printed, so it is not a property of the whole table only |
| [Cisco Learning Network, "i did everything only this line just how to start it ?"](https://learningnetwork.cisco.com/s/question/0D56e0000DNLHFQCQ5/i-did-everything-only-this-line-just-how-to-start-it-) | An IOS router: `show lldp neighbors` before `lldp run` gives `% LLDP is not enabled`; after `lldp run`, the legend, the heading, a blank line, `Total entries displayed: 0` | An IOS box that has just started announcing and heard nothing prints the legend, the heading and the zero - and the refusal is a different answer, printed when LLDP is off |
| [Cisco, IOS Release 15.8(3)M1 release notes, IR800/CGR1000](https://www.cisco.com/content/en/us/td/docs/routers/access/800/829/15-8-3M1-Release-Note.html) | `IR800# show lldp entry *` followed by the legend and then `Total entries displayed: 0` | The vendor's own document prints the zero, in the *entry* view, with no rows under the heading |
| [Network Kings, "What is CDP in Networking?"](https://www.nwkings.com/what-is-cdp-in-networking) | A lab: LLDP enabled on one switch only, `show lldp neighbors` prints `Device ID  Local Interface  Hold-time  Capability  Port ID` then `Total entries displayed: 0`, with the explanation "hence total entries are 0" | The zero is what a reader is meant to conclude from, not a missing line; the article treats it as the answer to "how many" |

An older [Cisco 9200 PoE thread](https://community.cisco.com/t5/switching/cisco-9200-series-not-connecting-the-poe-devices/m-p/5247997)
shows the same closing zero from `show lldp neighbors detail`, so the line does not belong to the brief form
alone. Nothing found prints an empty table with *no* count line.

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
detail view counts one, and the full Nexus 3500 view counts 45 against no more rows than that on screen. With
nothing heard, the line is still printed and reads `0` - on a Catalyst 9300 (twice, once filtered to a single
port), on an IOS router just given `lldp run`, in Cisco's own IOS XE release notes, and in a training lab;
the legend and the column heading are printed above it, and the whole table is replaced by the one line
`% LLDP is not enabled` only when the protocol is off.

**Inferred.** That a *filtered* brief view counts its own rows on Catalyst IOS - the filtered sample is the
NX-OS detail view. This console has no filters on `show lldp neighbors`, so nothing here depends on it.

**Unresolved.** Nothing about the count itself. What this note still cannot settle, because it did not set
out to: whether any Cisco platform omits the legend on an empty table (all five captures print it, and this
console prints no legend at all - that is the column-set question in
`research/lldp-hold-time-column.md`, not this one); whether the count is printed when LLDP is enabled but
*transmit* is disabled per port (no capture); and whether the empty-state prose this console adds above the
count would confuse a reader comparing against a real box - no vendor output has such a sentence, so it is a
deliberate addition, kept because the number 0 cannot say whether the table is empty because nothing was ever
heard or because every entry ran past its hold-time, and Cisco prints the same zero for both.

**Also out of scope, and why.** The legend and the header's `Hold-time` and `Capability` columns belong to
the vendor's table shape, and they were deliberately not taken here. A legend defining `(R)`, `(B)`, `(T)` and
the rest would be furniture for a `Capability` column this table does not have; adding the legend without the
column would be a key to a lock that is not on the door. That column set is its own question, already recorded
as such at the end of `research/lldp-hold-time-column.md`.

**What would settle what is left.** A `show lldp neighbors` paste from a box with `lldp transmit` disabled on
every port would say whether the count line survives; a capture from a non-Cisco LLDP implementation (Extreme,
Arista) asked for an empty table would say whether the zero is an IOS convention or a general one. Neither
changes the line this console prints, which follows the Cisco-shaped platforms it imitates.

## What was changed

* `engine/cli.js` - `show lldp [neighbors|neighbours]` prints `Total entries displayed: <rows>` as its last
  line, whether or not there are rows, with the evidence cited at the call site. The line moved out of the
  `else` that drew the rows, so the empty branch cannot drift away from the filled one.
* `test/lldp-total-entries.test.js` - 21 checks: the sentence and its position, that the number equals the rows
  printed, that it is plural for a single row, that aging a neighbour out leaves the sentence with a zero
  rather than deleting it, that a box that never heard anything prints its own prose and then a zero, that a
  row for a downed port is still counted because it is still printed, and that both accepted spellings agree.
* `docs/CLI.md` - the `show lldp` transcript and one paragraph saying what the count counts, including the
  empty case; `docs/ARCHITECTURE.md`'s empty-table snippet now carries the same closing line.
