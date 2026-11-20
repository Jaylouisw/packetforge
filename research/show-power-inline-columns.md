# `show power inline`: the port table's columns, and where the unit lives

**Question (one, narrow).** In the port table `show power inline` prints under its
`Available:/Used:/Remaining:` line, what are the columns called, how wide is each one, where does the *unit*
appear - in every cell or once in the heading - and what does a row look like for a port that supplies
nothing?

This is only about the table's furniture and cell format. The `Oper` vocabulary (`on`/`off`/`faulty`/
`power-deny`) is settled in [show-power-inline-power-deny.md](show-power-inline-power-deny.md), the `Admin`
column in [show-power-inline-admin-column.md](show-power-inline-admin-column.md), and the summary line above
the table in [show-power-inline-summary-line.md](show-power-inline-summary-line.md).

**Verdict: the columns are the vendor's - `Interface Admin Oper Power Device Class Max`, 10/7/11/8/20/6
characters wide in that order - the unit is a line of its own under `Power`, and the Power cell is a bare
figure to a tenth.** This console printed its own vocabulary in that table: `Draw` and `Powered device`, with
a ` W` suffix on every number (`12.95 W`, `0.0 W`). The names, the widths, the `(Watts)` line, the rule and
the cell format are now the capture's; the row set is not (see "What this change does not touch").

## What the vendor prints

A machine-recorded session, so the spacing survived, on an IOS XE switch with 802.3at ports:

```
Module   Available     Used     Remaining
          (Watts)     (Watts)    (Watts)
------   ---------   --------   ---------
1           740.0      330.0       410.0
Interface Admin  Oper       Power   Device              Class Max
                            (Watts)
--------- ------ ---------- ------- ------------------- ----- ----
Gi1/0/1   auto   on         30.0    AIR-AP1562I-E-K9    4     30.0
Gi1/0/5   auto   faulty     0.0     n/a                 n/a   30.0
Gi1/0/10  auto   on         23.2    C9120AXE-E          4     30.0
```

- ntc-templates, `tests/cisco_ios/show_power_inline/cisco_ios_show_power_inline.raw`
  <https://github.com/networktocode/ntc-templates/blob/master/tests/cisco_ios/show_power_inline/cisco_ios_show_power_inline.raw>

Three independent things fix the same widths, which is why they are not a guess:

1. **The header's own spacing** in that capture: `Interface` + 1 space (10), `Admin` + 2 (7), `Oper` + 7 (11),
   `Power` + 3 (8), `Device` + 14 (20), `Class` + 1 (6), then `Max`.
2. **The rule under it** - `--------- ------ ---------- ------- ------------------- ----- ----` - is one dash
   shorter than the field above it (9, 6, 10, 7, 19, 5, 4), the convention every table in this console already
   follows.
3. **The rows**: `Gi1/0/1   auto   on         30.0    AIR-AP1562I-E-K9` lands `auto` at column 10, `on` at 17,
   `30.0` at 28 and the device name at 36, which is the same five fields.

The same three lines, at the same indentation, are printed in four vendor configuration guides:

- Catalyst IR1800, *Power Over Ethernet* - <https://cisco.com/c/en/us/td/docs/IIOT/routers/IR1800/software/b-cisco-ir1800-scg/m-power-over-ethernet.pdf>
- ASR 920, *Power over Ethernet* (IOS XE 17.1) - <http://www.cisco.com/c/en/us/td/docs/routers/asr920/configuration/guide/chassis/17-1-1/b-Chassis-Guide-xe-17-1-asr920/m-poe-asr920.pdf>
- IR8340, *Power over Ethernet* (17.14) - <http://cisco.com/c/en/us/td/docs/routers/ir8340/software/configuration/b_ir8340_cg_17-14/m-power-over-ethernet.pdf>
- Catalyst IE3100, *Power over Ethernet* (17.15) - <https://www.cisco.com/c/en/us/td/docs/switches/lan/cisco_ie3X00/software/17_15/poe-config-ie3100.pdf>

and a 2960+ running 15.0(2)SE6 prints them in a Cisco support document (its text layer keeps the `(Watts)`
line and the rule, but not the runs of spaces):

- <https://www.cisco.com/c/en/us/support/docs/switches/catalyst-2960-series-switches/200371-Mismatching-consumed-power-inline-valu.pdf>

The field table that names the columns is unchanged from the notes above - `Admin`, `Oper`, `Power` ("maximum
amount of power that is allocated to the powered device, in watts"), `Device`, `Class`, `Max` - in the
Catalyst 2960-X 15.2(7)E command reference,
<http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/command_reference/b_1527_2960x_cr/interface_and_hardware_commands.html>,
and the `show power inline fastethernet0/1` sample in the Catalyst 2960 12.2(44)SE configuration note,
<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_44_se/configuration/note/ol14988.html>.

## What is known, and how sure

* **The names and the widths: known, three ways.** The header's spacing, the rule's dash counts and the row
  positions agree, and four vendor guides plus one 2960 transcript print the same line.
* **The unit is in the heading, not the cells: known.** Every capture prints `30.0`, `23.2`, `0.0`, `13.7` in
  the Power column and `(Watts)` - aligned under it, at column 28 - on the line below the header. A cell that
  reads `12.95 W` is this console's invention, and it also cost a column: the ` W` pushed `Device` two places
  to the right of where a box puts it.
* **One decimal: known for every row sampled** (13 samples across three platforms), and the same precision the
  `Available:/Used:/Remaining:` line uses, so a reader who adds the rows up gets the printed `Used:`.
* **`0.0` is what a port that allocates nothing prints** - `off`, `faulty` and `power-deny` rows alike - with
  `n/a` in `Device` for a port that detected nothing (two independent captures; the `faulty` row above).
* **The `(Watts)` line and the rule are not on every generation.** The 12.2(44)SE sample transcribed in
  [show-power-inline-admin-column.md](show-power-inline-admin-column.md) has neither: header, then rows. The
  15.x captures all have both. This console follows 15.x, the generation its other tables already follow.

## What this change does not touch, and why

* **`Class` is not printed.** It needs the powered device's IEEE classification (0-4); nothing in this model
  negotiates one, so a port cabled to a phone would print `n/a` where the box prints `3` - a wrong cell, not a
  missing one.
* **`Max` is not printed either**, although this catalogue does declare a per-port wattage for every PSE port
  (`poeOut`: 15.4, 30, 60, 90). It sits *behind* `Class` in the capture, so printing it after `Device` would
  put the number under a heading it does not belong to. The table stops at the last column it has data for,
  the rule `show spanning-tree` follows with `Prio.Nbr` and `Type`.
* **The row set is still this console's.** Idle ports are summarised in one line rather than printed as rows
  of `off 0.0 n/a`, and a port that allocates nothing carries the *reason* in the `Device` cell ("the far end
  is not a powered device", "administratively down") instead of `n/a`, with `-` in `Power` for "the engine has
  no allocation record for this port". A box distinguishes those four situations only by `Oper` and by the
  absence of a device; the reason is the thing an operator is reading this table for, and it is the one cell
  here that deliberately does not speak the box's vocabulary.
* **The `Device` vocabulary is not the field table's either.** A box prints `n/a`, `unknown`,
  `Cisco powered-device`, `IEEE powered-device` or a name learned over CDP. This model runs no CDP, so it
  prints the neighbour's hostname - informative, but it is the console naming a device a box could only name
  after a CDP exchange.

## Open questions, and what would settle them

1. **Does any generation print the unit in the cells instead of the heading?** Nothing found does; a capture
   from a platform whose `show power inline` reads `Power(Watts)` in one token would settle it.
2. **Is the half-tenth rounded up or down?** The catalogue's 802.3af phone draws 12.95 W; this console prints
   `13.0` (the figure the summary line uses too). No capture has a value ending in `.x5`, so the direction is
   unobserved.
3. **What does a *stack* print?** The 2960-X adds the per-member `Module Available Used Remaining` block above
   this table and a `Totals:` line under it; this console models one box and prints neither.
4. **An empty `Device` cell.** The ntc-templates capture has one row (`Gi1/0/4   auto   off        0.0` ) with
   nothing after the Power cell - not even `n/a`. One sample is not a rule; a second capture with an empty
   device cell would say whether that is a rendering of `n/a` or a state of its own.
