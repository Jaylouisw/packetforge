# What surrounds `show mac address-table`: the title, the rule, and the count at the end

**Question (one, narrow).** On a real Cisco-style access switch, what does the box print *around* the MAC
address table — before the column headings and after the last row — and what does the trailing count count?

**Verdict: known, and adopted.** The table is furniture, not just rows. A Catalyst prints a centred title
`Mac Address Table`, a 43-dash rule under it, a blank line, the column headings with their own dash underline,
the entries, and one closing sentence: `Total Mac Addresses for this criterion: N`. That `N` counts the rows
just printed for the criterion the operator asked for — so on `show mac address-table interface <port>` it is
that port's entries, not the switch's.

PacketForge printed the headings and the rows and nothing else: no title, no rule, no underline, no total. On a
filtered view there was then nothing at all saying the count was the filter's rather than the box's, and a
pasted table gave a reader no way to tell how many entries they were looking at without counting them.

## The device's own output

Catalyst 9200, Cisco IOS XE 26.x, "Display MAC Addresses"
(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/26-x/configuration_guide/int_hw/b_26x_int_and_hw_9200_cg/checking_port_status_and_connectivity.html>):

```
Device# show mac address-table

          Mac Address Table
-------------------------------------------

Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
All    0100.0ccc.cccc    STATIC      CPU
...
   1    188b.45eb.cc01    DYNAMIC     Gi1/0/1
Total Mac Addresses for this criterion: 22
```

The same page's filtered example:

```
Device# show mac address-table interface Gi1/0/1

          Mac Address Table
-------------------------------------------

Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
   1    188b.45eb.cc01    DYNAMIC     Gi1/0/1
Total Mac Addresses for this criterion: 1
```

Two things in that second transcript settle the rule: the furniture is reprinted for a filtered view, and the
total is **1**, although the switch holds 22 entries. `N` is the count of the rows printed for the criterion.

The Catalyst 2960-X command reference shows the same closing sentence for `show mac address-table`,
`show mac address-table address`, `show mac address-table dynamic`, `show mac address-table interface` and
`show mac address-table vlan` — it is the sentence this view ends with, not an accident of one image
(<http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/command_reference/b_1526_2960x_cr/system_management_commands.html>).

**The underline is not the heading's own length.** In the transcript the dash runs are 4, 11, 8 and 5 for
`Vlan`, `Mac Address`, `Type` and `Ports`, while the rows above them print 14-character dotted MACs one space
past an 11-dash rule; `Type` is a four-letter word over eight dashes. The device's underline is a fixed field
width per column, not a measurement of what is printed. Copying the heading lengths would look tidier and be
less true, so PacketForge copies the device: 4, 11, 8, 5. Its `Age` column has no counterpart in the vendor
view — it is this model's own column, added when entries started ageing — so it is the one rule mark taken from
its heading.

## What each part is, and how sure

* **Title, rule, blank line, underline, total: documented.** Both Cisco pages above print all five.
* **The total counts the printed rows, not the table.** Documented by the filtered example (1 of 22).
* **An empty view prints `…: 0` rather than dropping the line: inferred, not documented.** No Cisco page shows
  an empty table. Arista EOS prints `Total Mac Addresses for this criterion: 0` under an empty table
  (<https://www.arista.com/en/um-eos/eos-data-transfer>), and the sentence is phrased as a count of a criterion,
  of which zero is a value. PacketForge prints 0. This is the one line of the change that rests on inference.
* **The total counts static rows too.** In the 9200 transcript the 22 is 21 `STATIC … CPU` rows plus one
  dynamic row, so the count is of rows, not of learned addresses. PacketForge's number is now its dynamic rows
  plus the reserved block — the next item, which a later run took up.
* **The reserved `STATIC … CPU` rows were left unmodelled here.** A real switch lists `All 0100.0ccc.cccc
  STATIC CPU`, the `0180.c200.00xx` multicast run and `ffff.ffff.ffff` before any traffic arrives, and the 9200
  page shows 21 of them. This run judged that the set varied too much per image to adopt one list.
  **Superseded:** `research/mac-table-reserved-rows.md` found a real 2960 paste beside the XE pages, showed the
  variance is one row (`0180.c200.0021`, IOS XE only) and not a different set per platform, and the console now
  prints the twenty rows every transcript shares, counted in the total.

## What PacketForge prints now

```
sw#show mac address-table

          Mac Address Table
-------------------------------------------

Vlan    Mac Address         Type        Age     Ports
----    -----------         --------    ---     -----
1       02:00:00:00:01:00   DYNAMIC     0s      Fa0/1
1       02:00:00:00:02:00   DYNAMIC     -       Fa0/2 (administratively down)
Total Mac Addresses for this criterion: 2
```

and filtered, on a port with nothing behind it:

```
sw#show mac address-table interface Fa0/8

          Mac Address Table
-------------------------------------------

Vlan    Mac Address         Type        Age     Ports
----    -----------         --------    ---     -----
(no entry learned on Fa0/8)
Total Mac Addresses for this criterion: 0
```

## What would settle the remaining question

One `show mac address-table` from a Catalyst with nothing learned — `show mac address-table` on a freshly
booted 9200 — would turn the inferred `…: 0` into a documented line. A 2960 (not -X) transcript would show
whether the 43-dash rule and the 4/11/8/5 underline are image-wide or page-specific; this run found them on
IOS XE only.
