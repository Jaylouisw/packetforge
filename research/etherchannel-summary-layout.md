# What `show etherchannel summary` prints around the table, and what a `Po1(SU)` cell says

**Question (one, narrow).** On a Cisco-style switch, what exactly does `show etherchannel summary` print —
the material before the first group row, the four column headings and their widths, the flags in the
`Port-channel` cell, and the text in the `Protocol` cell — and which of those does PacketForge get wrong?

**Verdict: known, and adopted.** The command is furniture around a table, and every piece of the furniture
was missing or invented:

| | Device | PacketForge before | PacketForge now |
|---|---|---|---|
| Legend | nine fixed lines, `Flags:  D - down …` | none | the same nine lines |
| Counts | `Number of channel-groups in use:` / `Number of aggregators:` | none | both, same column |
| Header | `Group  Port-channel  Protocol    Ports` | `Group  Protocol  Ports` | the device's |
| Rule | `------+-------------+-----------+----…` | none | the device's, character for character |
| Port-channel cell | `Po1(SU)` (L2 + in use), `Po1(SD)` when down | absent | `Po<N>(SU)` / `Po<N>(SD)` |
| Protocol cell | `LACP`, `PAgP`, or `-` for `mode on` | `LACP (active)`, `Static` | `LACP`, or `-` |
| Member cells | `(P)`, `(D)`, `(H)`, `(w)` | `(P)`, `(D)` | unchanged |
| No group at all | the key, two zeros, the header, the rule, no rows | `% No link aggregation groups configured` | the same table with no rows |

## What the device prints

Catalyst SD-WAN Interfaces Configuration Guide, releases 26.x and later, "Monitor configured EtherChannel
using CLI"
(<https://www.cisco.com/c/en/us/td/docs/routers/sdwan/26x-later/interfaces/interfaces-configuration-guide/ether-channels/monitor-configured-etherchannel-using-cli.html>)
— the only transcript found that survives extraction with its spacing intact:

```
Device# show etherchannel summary
Flags:  D - down        P/bndl - bundled in port-channel
        I - stand-alone s/susp - suspended
        H - Hot-standby (LACP only)
        R - Layer3      S - Layer2
        U - in use      f - failed to allocate aggregator

        M - not in use, minimum links not met
        u - unsuitable for bundling
        w - waiting to be aggregated
        d - default port


Number of channel-groups in use: 1
Number of aggregators:           1

Group  Port-channel  Protocol    Ports
------+-------------+-----------+-----------------------------------------------
1       Po1(RU)         LACP     Te0/3/0(bndl) Te0/3/1(hot-sby)

RU - L3 port-channel UP State
SU - L2 port-channel UP state
```

Catalyst 9500 command reference, Layer 2/3 Commands (17.10)
(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/17-10/command_reference/b_1710_9500_cr/layer_2_3_commands.pdf>)
prints the same shape, and documents the argument form
`show etherchannel [channel-group-number | {detail | port | port-channel | protocol | summary}]`:

```
Group
Port-channel
Protocol
Ports
------+-------------+-----------+----------------------------------------
1
Po1(SU)
LACP
Gi1/0/1(P) Gi1/0/2(P)
```

The Catalyst 2960-X consolidated command reference, 15.2(4)E, "Layer 2 Commands"
(<https://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_4_e/command_reference/b_1524e_consolidated_2960x_cr/b_1524e_consolidated_2960x_cr_chapter_0101.html>)
shows a shorter legend on that release — `D`, `P - in port-channel`, `I`, `s`, `H`, `R`, `S`, `u`, `U`, `f`,
`d`: no `M`, no `w`.

Two Cisco-authored labs print the layout with the columns still aligned:

- `S1# show etherchannel summary` … `1      Po1(SU)         PAgP      Fa0/3(P)    Fa0/4(P)`
  (<https://cisco.tu-sofia.bg/wp-content/uploads/courses/CCNA3/course/files/3.2.1.4%20Lab%20-%20Configuring%20EtherChannel.pdf>)
- `A1# show etherchannel summary` … `1      Po1(SU)          -        Fa0/3(P)    Fa0/4(P)`
  (<https://edu-cisco.org/docs/CCNA-CCNP-lab-implement-etherchannel.pdf>)

The second is the decisive transcript for the `Protocol` cell: two ports in `mode on` read `-`, because `on`
negotiates nothing and there is no protocol to name. A Cisco Community transcript shows the same `-` on
static bundles and, on the same page, a bundle with no live member reading `Po26(SD)`:

```
1      Po1(SU)     -    Gi4/0/1(P) Gi4/0/2(P)
26     Po26(SD)    -    Gi2/0/11(D) Gi2/0/12(D)
```

(<https://community.cisco.com/t5/switching/show-commands-do-not-tell-link-aggregation-type/td-p/1879612>)

## What was wrong, and what each fix rests on

1. **The key.** The legend is fixed text: a box prints every flag it *can* use, not only the ones the table
   contains. So the model prints all nine lines even though it can only produce `P`, `D`, `S` and `U` —
   copying the device is the point, and the legend's job is to explain the table, not to enumerate it.
2. **The counts.** `Number of aggregators` sits directly under `Number of channel-groups in use`, its number
   in the same column (33). A real box's two figures can differ — an aggregator can outlive the group that
   made it — but this model builds exactly one port-channel per group, so printing different numbers would
   be a fiction.
3. **The header is not aligned with the rows, and that is the device's own doing.** The header spends 14
   columns on `Port-channel` and 12 on `Protocol`; a row spends 16 and 10. So `Protocol` in the header sits
   two columns left of `LACP` under it, while `Ports` and the member list *do* line up at column 33. Lining
   the header up with the rows would be tidier than the box, and wrong.
4. **`Po1(SU)`.** The Port-channel cell is the bundle's own flags: `S` Layer2 (`R` Layer3), and `U` in use or
   `D` down — the pair the SD-WAN guide glosses as "SU - L2 port-channel UP state". A bundle with one live
   member still reads `(SU)`; a bundle with none reads `(SD)`, which is what the community transcript shows
   and what the model now prints.
5. **The Protocol column is a protocol.** `LACP (active)` is a string no box produces, and `Static` for
   `mode on` named a protocol that is not running. The mode is still readable where the device keeps it:
   `show running-config` prints `channel-group 1 mode active`. That was the reason the mode was in the
   column, and the column was the wrong place for it.

## What is inferred rather than read

- **`(SD)` for a bundle with no live member.** No Cisco document states the second flag's value for a down
  bundle: a forum transcript shows it, and the guide's gloss ("UP state") implies its opposite. Adopted.
- **Row alignment, column 8 vs 7.** The SD-WAN 26 sample starts the `Po1(RU)` cell at column 8 while its own
  header starts `Port-channel` at 7; the CCNA labs and the 9500 reference use 7. The model uses 7 — the
  header's own column — and reads the 8 as the source's own drift.
- **`(P)` vs `(bndl)`.** IOS XE 26 on some platforms prints `P/bndl` in the key and `(bndl)` in the member
  list. The classic `(P)` is kept: the catalogue's devices are IOS-style switches, and both are keys for the
  same state.
- **The legend's line set.** `M`, `u`, `w` and `d` appear on IOS XE and not on 2960-X 15.2(4)E; `A - formed
  by Auto LAG` appears only where Auto LAG exists. The XE form without `A` is what is printed.
- ~~**Blank lines inside the key.** The SD-WAN sample has one after `f - failed to allocate aggregator` and two
  before the counts; the labs' PDF text does not. The model prints the nine lines with no blank ones, which
  is the majority form.~~ **Settled on 2026-11-20 — see "The blank lines in the key" below.** The "majority
  form" was an artefact of the sources: PDF and HTML extraction drops empty lines, so a reconstruction from
  those samples can only ever read as one solid block. Two machine-recorded captures both carry the blank
  lines, and the model now prints them.

## The blank lines in the key — settled (2026-11-20)

**Question (one, narrow).** `show etherchannel summary` prints the flag key as one solid block here. Does a
real box put blank lines inside that key, and if so where?

**Verdict: yes — and the gaps are in the device's bytes, not in the transcriber's.** Two `ntc-templates`
captures, stored as `.raw` (terminal output, spaces and empty lines intact), both print a blank line between
the `f - failed to allocate aggregator` text and the `M - not in use` line, and both print exactly one blank
line between `Number of aggregators:` and the `Group` header:

```
Flags:  D - down        P - bundled in port-channel
        I - stand-alone s - suspended
        H - Hot-standby (LACP only)
        R - Layer3      S - Layer2
        U - in use      N - not in use, no aggregation
        f - failed to allocate aggregator
                                    <- blank
        M - not in use, no aggregation due to minimum links not met
        m - not in use, port not aggregated due to minimum links not met
        u - unsuitable for bundling
        d - default port
                                    <- blank
        w - waiting to be aggregated
Number of channel-groups in use: 6
Number of aggregators:           6
                                    <- blank
Group  Port-channel  Protocol    Ports
------+-------------+-----------+-----------------------------------------------
1      Po1(SU)         LACP      Te6/4(P)       Te3/5(P)       Te9/4(P)
```

```
Flags:  D - down        P/bndl - bundled in port-channel
        I - stand-alone s/susp - suspended
        H - Hot-standby (LACP only)
        R - Layer3      S - Layer2
        U - in use      f - failed to allocate aggregator
                                    <- blank
        M - not in use, minimum links not met
        u - unsuitable for bundling
        w - waiting to be aggregated
        d - default port
                                    <- blank
                                    <- blank
Number of channel-groups in use: 1
Number of aggregators:           1
                                    <- blank
Group  Port-channel  Protocol    Ports
------+-------------+-----------+-----------------------------------------------
1      Po10(RU)  ...  (the SD-WAN sample's own L3 row)
```

| Source | What it is | The gaps it shows |
|---|---|---|
| [`cisco_ios_show_etherchannel_summary.raw`](https://github.com/networktocode/ntc-templates/blob/master/tests/cisco_ios/show_etherchannel_summary/show_etherchannel_summary.raw) | a Catalyst/IOS session with six groups | blank after the `f` line; blank after `d`, then a `w` block; **no** blank before the counts; one blank before `Group` |
| [`…summary2.raw`](https://github.com/networktocode/ntc-templates/blob/master/tests/cisco_ios/show_etherchannel_summary/show_etherchannel_summary2.raw) | IOS XE 26-style session (SD-WAN wording, one group) | blank after `U … f`; blank, blank after `d`; one blank before `Group` |

Both files are the same source the repo already trusts for `show mac address-table` alignment
(`research/mac-table-vlan-cell.md`) and for interface names (`cli.js`, the OSPF neighbour note), and both agree
on the two positions. They disagree on the *blocks*: IOS splits the key into three blocks (the `w` line stands
alone), XE into two, and the XE capture therefore shows two blank lines where IOS shows none between `w` and
the counts.

**What was adopted, and why the rest was not.** This console prints the XE line set (`M`, `u`, `w`, `d`; no
`N`/`m`), so it prints that line set's blocks: one blank after the `f` text, then `M`, `u`, `w`, `d`, then the
counts. The gap between the counts and the header is one blank line in both captures. The pre-counts count
(0 on IOS, 2 on XE) is left as IOS has it — no blank — because the two captures disagree and the number is an
artefact of which lines the last block holds, not a rule about spacing above a table.

`test/etherchannel-summary-layout.test.js` now pins both gaps, in the populated and the empty table;
`test/show-etherchannel-group-summary.test.js` and `test/show-etherchannel-views.test.js` count the furniture
at fifteen lines instead of thirteen; `docs/CLI.md`'s two samples carry the gaps.

The lesson is worth recording because the earlier pass stated the opposite as a fact: *"The model prints the
nine lines with no blank ones, which is the majority form."* The majority of the sources were transcoded
artefacts. A vendor page cannot witness a blank line, so absence of a blank line in a PDF is not evidence of
absence on the box — and for a layout question, `.raw` (or a paste in a `<pre>` block) is the only witness.

## What is unresolved, and what would settle it

- **`show etherchannel <n> summary`.** A real box accepts a group number, and this console refuses any
  argument (`show etherchannel 1` answers `does not take "1"`). That is a separate question about which
  arguments the view takes, and it is not answered here.
- **`brief`, `detail`, `port`, `load-balance`.** All of them printed the summary while this note was

## The other five views — settled (2026-11-20)

**Question (one, narrow).** The syntax line has six views -
`show etherchannel [channel-group-number | {detail | port | port-channel | protocol | summary}]` - and this
console answered every one of them with the summary table. Which of the six can it actually answer, and what
should it say about the rest?

**Verdict: one of six, and the other five are refused by name.** No engine behaviour was invented: the five
views print material the engine does not hold, so printing the summary for them was a wrong answer, not a
narrow one.

### What the vendor's reference says each word means

One page carries the syntax line and a syntax-description entry per word — Catalyst 2960-X Layer 2 Command
Reference, Cisco IOS 15.2(2)E, `show etherchannel`
(<https://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_2_e/layer2/command_reference/b_Layer2_3_1522e_2960x_cr.pdf>,
pp. 36-37):

| word | the reference's description | the sample it prints |
|---|---|---|
| `detail` | "Displays detailed EtherChannel information" | `Group state = L2 / Ports: 2 / Maxports = 16 / Port-channels: 1 / Protocol: LACP`, then a block per port (admin key, oper key, port state, pseudo port-channel) |
| `load-balance` | "Displays the load-balance or frame-distribution scheme among ports in the port channel" | the hash policy |
| `port` | "Displays EtherChannel port information" | a block per member port with its LACP/PAgP state |
| `port-channel` | "Displays port-channel information" | the bundle's own counters and timers |
| `protocol` | "Displays the protocol that is being used in the channel" | see below |
| `summary` | "Displays a one-line summary per channel group" | the table this console prints |

The 3650 3.6E, 3850 16.3 and 9500 16.6/17.10 references print the same line and the same samples; the 9500
one is HTML, so its spacing survives extraction
(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/16-6/command_reference/b_166_9500_cr/b_166_9500_cr_chapter_0111.html>).

The `protocol` sample is the one that shows most plainly that these are not variations on the summary table:

```
Switch# show etherchannel protocol
Channel-group listing:
-----------------------
Group: 1
----------
Protocol: LACP
Group: 2
----------
Protocol: PAgP
```

Two groups, eight lines, one fact - and the same fact is a column in `show etherchannel summary`.

### Why refusal, and not a model of each view

- `detail`, `port` and `port-channel` print per-port negotiation internals: admin and oper keys, the port's
  LACP state word, the aggregator MAC, and "time since last port bundled". The engine keeps the mode
  (`on`/`active`/`passive`) and whether a member is bundled; it keeps none of the rest, and inventing keys and
  timers is the failure mode this loop exists to avoid.
- `protocol` is the one view whose fact the engine *does* hold (the Protocol column). A block per group would
  be a new view built on existing data - a feature, not fidelity - so it is pointed at the column instead.
- `load-balance` has no counterpart in the engine at all: nothing hashes a frame across members, so there is
  no policy to report and no document that would make one true.

### What the console does now

- `summary`, `brief` (this console's own synonym for a one-line-per-group view) and the bare command still
  print the table, unchanged; a channel-group number still narrows it.
- `detail`, `port`, `port-channel`, `protocol`, `load-balance` (and the shortening `load`) answer with one
  line beginning `% ` and ending `<view> is a view this console does not have: …`, naming the view the reader
  typed, saying what it holds on a box, and pointing at `show etherchannel summary` - except
  `load-balance`, which points nowhere because there is nothing to point at.
- `show port-channel detail` refuses under the spelling the reader typed; `show port-channel summary` keeps
  printing the table.
- A typo (`show etherchannel flurbish`) keeps the sentence it had: `does not take "flurbish"`.

`test/show-etherchannel-views.test.js` pins all of it (43 assertions).

### Still unresolved

- Whether any of these five words is accepted by a *platform without EtherChannel support* (an
  invalid-input error rather than a view) - the same gap this note records for the empty table.
- What `show etherchannel load-balance` prints on a Catalyst whose policy was never changed. The default is
  reported as `src-mac` in most CCNA material and the `load-balance` word is not in the 2960-X sample set
  above; nothing in hand is a machine-recorded capture, so no default is claimed here.

## A device with no channel group — settled, and it contradicted what this note first said

The first version of this note left the zero-group case unresolved and kept
`% No link aggregation groups configured`, on the argument that an empty table would be an invention. Two
transcripts later, that sentence looks like the invention.

**Cisco, "Recover Errdisable Port State on Cisco IOS Platforms"** — its EtherChannel counterexample is a
Catalyst 6500 whose channel group has been torn down, so `show etherchannel summary` finds none in use
(<https://www.cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol/69980-errdisable-recovery.html>):

```
cat6k# show etherchannel summary
Flags: D - down P - in port-channel
I - stand-alone s - suspended
H - Hot-standby (LACP only)
R - Layer3 S - Layer2
U - in use f - failed to allocate aggregator
u - unsuitable for bundling
Number of channel-groups in use: 0
Number of aggregators: 0
Group Port-channel Protocol Ports
------+-------------+-----------+-----------------------------------------------
```

The key is printed, both counts read 0, the header and the rule follow — and there is no row. The command
answers with a table that has nothing in it, not with an error.

**A community thread on Cisco's own forum** shows the same shape on a second switch, again with no rows
(`ICC#sh ether summary`, both counts 0, then `Group Port-channel Protocol Ports`) — in a post otherwise
about a working two-member bundle, which makes it a real capture rather than a paraphrase
(<https://community.cisco.com/t5/switching/understanding-port-channeling/td-p/2290842>).

A search for `"% No link aggregation groups configured"` returns no Cisco document, no transcript and no
forum post: the sentence this console printed has no source.

**Adopted:** the key, the two counts (`0` and `0`), the header and the rule are printed whether or not
there are groups; only the rows are conditional. The legend wording stays the model's own (`P - bundled in
port-channel`, the IOS XE form rather than the older `P - in port-channel` the 6500 transcript uses), since
that choice was already made for the populated table and a platform model should not print two keys.

**Still unaccounted for:** the note cannot say how a platform with no EtherChannel support at all answers
(an invalid-input error rather than an empty table). Every device in the catalogue that offers this view
offers channel groups too, so the question does not arise here yet.

## What changed in the engine

`engine/cli.js`: `ETHERCHANNEL_FLAGS`, `ETHERCHANNEL_RULE`, `ETHERCHANNEL_HEADER` and
`ETHERCHANNEL_COLUMNS` are the layout; the `show etherchannel` block prints the key, the two counts, the
header and the rule before the rows, and builds each row's Port-channel and Protocol cells from the rules
above. `test/etherchannel-summary-layout.test.js` pins each one, `test/lag-mode.test.js` no longer asserts
the invented `LACP (active)` / `Static` cells, and `test/show-view-phrase.test.js` looks for the header
rather than for a first line starting with `Group`.
