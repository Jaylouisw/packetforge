# `show etherchannel <n> summary`: does the view take a group number, and what do the counts say when it hides a group?

**Question (one, narrow).** `show etherchannel summary` prints every channel group. A real box also accepts a
channel-group number in front of the keyword, and this console refused it - `show etherchannel 1` answered
`% show etherchannel does not take "1": every group is listed - each group is headed by its number`, which is a
sentence about a typo. So: is a number an argument of the view, what does the table keep when it is given, and do
the two count lines above it follow the filter or stay the box's totals?

`research/etherchannel-summary-layout.md` recorded the first half of this as **unresolved** ("A real box accepts a
group number, and this console refuses any argument") and said it was a separate question. This note answers it.

**Verdict: the number is an argument, it filters the table's rows, and it does not touch the counts.** A box with
two groups answers `show etherchannel 2 summary` with the same nine-line key, `Number of channel-groups in use: 2`,
`Number of aggregators: 2`, the header, the rule, and one row - the one for group 2. Three captures agree, on two
platforms and two IOS generations.

## The grammar

Every command reference that lists the command gives the same shape: an optional group number, or a keyword.

Catalyst 2960-X, *Consolidated Platform Command Reference*, 15.2(6)E, Layer 2 Commands, `show etherchannel`:

> `channel-group-number` - (Optional) Channel group number. The range is 1 to 24.

and its example is headed "This is an example of output from the `show etherchannel channel-group-number summary`
command":

```
Device> show etherchannel 1 summary
...
Number of channel-groups in use: 1
Number of aggregators: 1
Group Port-channel Protocol Ports
------+-------------+-----------+----------------------------------------
1 Po1(SU) LACP Gi1/0/1(P) Gi1/0/2(P)
```

* <http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/command_reference/b_1526_2960x_cr/layer_2_commands.html>

Catalyst 9500, 16.6, and Catalyst 9200, 26.x, print the syntax line itself:

> `show etherchannel [channel-group-number | {detail | port | port-channel | protocol | summary}] | [detail | load-balance | port | port-channel | protocol | summary]`

* <http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/16-6/command_reference/b_166_9500_cr/b_166_9500_cr_chapter_0111.pdf>
* <http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/26-x/command_reference/b_26x_9200_cr/layer_2_3_commands.html>

Cisco's own configuration example for an EtherChannel to a server types the filtered form too:

```
Switch# show etherchannel 1 summary
...
Number of channel-groups in use: 1
Number of aggregators:           1
Group  Port-channel  Protocol    Ports
------+-------------+-----------+-------------------------------------
1      Po1(SU)         LACP      Gi2/0/23(P) Gi2/0/24(P)
```

* <http://cisco.com/c/en/us/support/docs/lan-switching/etherchannel/98469-ios-etherchannel.pdf>

Those samples all come from a box with one group, so "one row" does not yet say whether the row is the filter or
the whole box. The next two captures come from boxes with two.

## The counts stay the box's; only the rows are filtered

**Capture 1 - a training lab, two groups on one switch.** The CCNP-style lab builds group 1 on DLS1, then group 2,
and reads the second one back:

```
DLS1# show etherchannel 2 summary
Flags: D - down P - in port-channel
I - stand-alone s - suspended
H - Hot-standby (LACP only)
R - Layer3 S - Layer2
U - in use f - failed to allocate aggregator
u - unsuitable for bundling
w - waiting to be aggregated
d - default port
Number of channel-groups in use: 2
Number of aggregators: 2
Group Port-channel Protocol Ports
------+-------------+-----------+---------------------------------------------
2 Po2(SU) PAgP Fa0/7(P) Fa0/8(P)
```

The same lab's other switch, ALS1, holds **group 2 only** and answers the same command with
`Number of channel-groups in use: 1` over one row. Same filter, two different counts - so the two figures are the
device's, not the selection's.

* <https://www.howtonetwork.org/switch/module-5/lab-etherchannel-configuration-and-implementation/>

**Capture 2 - a Catalyst 2960-S in a user's thread.** Two groups, group 2 down while LACP negotiated nothing:

```
#show etherchannel 2 summary
...
Number of channel-groups in use: 2
Number of aggregators: 2
Group Port-channel Protocol Ports
------+-------------+-----------+-----------------------------------------------
2 Po2(SD) LACP Gi1/0/21(I) Gi1/0/22(I) Gi1/0/23(I)
Gi1/0/24(I)
```

* <https://forum.proxmox.com/threads/mac-address-flappling-on-a-cisco-catalyst-2960-s.37478/>

Both captures also settle a second detail: the key and the two counts are printed *before* the table and are
identical to the unfiltered view's, so a filtered call is the same view with a shorter table - not a different
view. (The two boxes print different key line sets from each other, `M`/`w` on one and not the other; that is the
platform split `research/etherchannel-summary-layout.md` already records, and this console prints the IOS XE form.)

The unfiltered two-group table in Cisco's 4500 configuration guide has the same furniture over two rows, which is
the shape this console already printed:

* <https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/3-1-1SG/configuration/guide/config/channel.pdf>

## What the console did, measured

On `0e9b4c1`-era `main`, a `generic-switch` with groups 1 and 10:

```
sw1#show etherchannel 1 summary
% show etherchannel does not take "1": every group is listed - each group is headed by its number
```

The sentence is not a reservation about an unmodelled filter; it reads as "that word is a mistake", which sends an
operator who copied a line from a vendor document back to the whole table. `show port-channel 1` was refused the
same way, under the spelling the operator typed.

## What changed

* `engine/cli.js`, the `etherchannel` arm of `_show`: a leading whole number is read as the group filter (all
  digits, so `show etherchannel 10 summary` and `show etherchannel 10` both narrow); the rest of the words are
  still checked against the keywords the view takes, and a word it does not know is still refused - now with the
  advice `e.g. show etherchannel 1 summary` instead of "each group is headed by its number", because a number is
  something this view now does take.
* The rows come from the filtered list; **both counts are computed from every group on the box**, and the comment
  beside them says why, citing capture 1.
* Nothing else moved: the key, the header, the rule, the member annotations and the empty-device table are the
  same code path.
* `test/show-etherchannel-group-summary.test.js` (new): the filtered call prints the key, the device's two counts,
  the header and the rule; exactly one row; the row is the named group's; the unfiltered view is unchanged; a
  number that matches no group prints the furniture over no rows; the alias `show port-channel 1 summary` answers
  as the same view; and a non-numeric word is still refused, in the name that was typed.
* `test/show-view-phrase.test.js` and `test/command-word-abbreviation.test.js` used `show port-channel 1` as their
  example of an argument that is refused. That example is now a group filter, so both files use a word instead
  (`show port-channel flurbish`) to keep testing the rule they were written for - the refusal keeps the spelling
  the operator typed.

## What remains unresolved

* **A group number that names no group.** No capture was found of `show etherchannel 5 summary` on a box whose
  groups are 1 and 2. This console prints the furniture with the device's totals and no row, because that is
  exactly the shape an empty box prints (`research/etherchannel-summary-layout.md`, Cisco's errdisable-recovery
  page) and because the number is a filter over a table. A box may instead print nothing, or parse-error; a single
  capture from any switch would settle it.
* **A number outside the id space.** `show etherchannel 0 summary` and `show etherchannel 9999 summary` are
  accepted here as filters that match nothing. On a box the number is a keyword argument with a stated range
  (1-24 on a 2960-X, 1-48 on a 9200), and an id outside it is more likely `% Invalid input detected` than an empty
  table. Not modelled: this console has no per-platform ceiling to check against, and the config door's ceiling
  (`channel-group` 1-4096) is the console's own, not a platform's.
* **A number with a keyword other than `summary`.** The captures only show `summary`. This console has always
  printed the summary for `brief`, `detail`, `port`, `port-channel`, `protocol` and `load-balance`, filtered or
  not; whether a real box's `show etherchannel 2 detail` is a detail block is the same unanswered question the
  layout note records, and it is untouched here.
* **Two groups whose numbers differ by a leading zero.** Ids are compared as numbers here (`01` is group 1)
  because the config door stores what was typed; no capture exercises it.
