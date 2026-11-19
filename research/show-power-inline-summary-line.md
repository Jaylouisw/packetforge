# `show power inline`: where the budget summary sits, and what it says

**Question (one, narrow).** On a standalone Cisco access switch, does `show power inline` print the switch's
PoE budget as a line above the port table or below it, and exactly how is that line worded - which labels, which
unit, how many decimals - and is `Remaining` the subtraction of the two numbers printed beside it?

**Verdict: one line, above the table, `Available:<n>(w) Used:<n>(w) Remaining:<n>(w)` to one decimal.**
PacketForge printed its own `Total: ... W of ... W in use, ... W left` sentence *after* the table. That sentence
is not a shape the box produces: on a fixed-configuration 2960 the budget is the first line of the answer, before
the column headings, in the vendor's three labels and with `(w)` on each number.

## What the device prints

Cisco's own 2960 support document, "Mismatching consumed power inline value with SNMPWalk and Switch CLI"
(200371), prints the whole answer:

```
Switch# Show power inline
Available:370.0(w) Used:279.9(w) Remaining:90.1(w)
Interface Admin  Oper       Power   Device              Class Max
(Watts)
--------- ------ ---------- ------- ------------------- ----- ----
Fa0/1     auto   off        0.0     n/a                 n/a   15.4
Fa0/5     auto   on         3.3     IP Phone 7821       1     15.4
Fa0/14    auto   on         13.7    IP Phone DX650      4     15.4
```

The same page defines the three fields: `Available` is "the total amount of PoE in the system", `Used` is
"the amount of PoE allocated to ports", and `Remaining` is "the amount of PoE not allocated to ports
(Available - Used = Remaining)".

* <https://www.cisco.com/c/en/us/support/docs/switches/catalyst-2960-series-switches/200371-Mismatching-consumed-power-inline-valu.pdf>

A CCNA-level training page reproduces the same standalone form on a 2960 - summary first, one decimal, `(w)` -
with a different load:

```
Switch#show power inline
Available:370.0(w) Used:60.0(w) Remaining:310.0(w)
Interface Admin Oper Power Device Class Max
(Watts)
--------- ------ ---------- ------- ------------------- ----- ----
Fa0/2     auto   on         10.0    IP Phone 7960       3     15.4
Fa0/4     auto   off        0.0     n/a                 n/a   15.4
```

* <https://www.networkacademy.io/ccna/ethernet/power-over-ethernet>

A third fixed switch in a Cisco community thread prints the same sentence with its own numbers
(`Available:720.0(w) Used:277.2(w) Remaining:442.8(w)`):

* <https://community.cisco.com/t5/switching/3560x-combined-redundany-power-supplies/td-p/3020626>

## The variant this engine does not have

A stackable 2960-X prints a *per-member* table where the standalone box prints the one line:

```
Module  Available  Used  Remaining
        (Watts)    (Watts) (Watts)
------  ---------  -----  ---------
3       370.0      243.6  126.4
4       370.0      229.2  140.8
```

The 2960-X command reference shows that table, the same field definitions, and then the `Interface Admin Oper
Power Device Class Max` table below it:

* <http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/command_reference/b_1527_2960x_cr/interface_and_hardware_commands.html>

PacketForge models one box, not a stack, so the standalone line is the shape it can honestly print. The
stack-member table is a different view with a `Module` column the engine has no member number for.

## What changed

`engine/cli.js` `_showPowerInline()` now prints, before the `Interface Admin Oper Draw Powered device` header:

```
Available:25.0(w) Used:13.0(w) Remaining:12.0(w)
```

The numbers are the engine's own `sim.poe` allocation - `entry.budget`, `entry.used` and their difference - not a
second arithmetic. Both are rounded to one decimal *before* `Remaining` is computed, so the three printed numbers
add up as the field table says they do. The old `Total:` sentence and its `N ports denied` count are gone; the
per-row `(denied)` mark and the engine's `PSE budget exhausted: ...` sentence under the table remain, because
they say *why*, which the vendor summary does not.

`test/show-power-inline.test.js` and `test/c2960x-48fps-poe.test.js` now pin the line's position, labels,
one-decimal format and arithmetic; `docs/CLI.md` ("Reading `show power inline`") prints the new shape and cites
this note.

## What is unresolved

* **Does `show power inline <port>` print the summary?** One training-page capture of a single-interface query
  (`show power inline FastEthernet 1/5`) shows `Available:750(w)  Used:11(w)  Remaining:739(w)` above a
  *different*, two-row detail table (`Power(Watts) From PS / To Device`, then `AdminPowerMax /
  AdminConsumption`). That is a different platform and a different table, so it cannot decide the question for
  the 2960's all-ports table. This engine keeps the device summary off the one-port answer, where it is a fact
  about something other than the port asked about.
* **The stack-member form.** The 2960-X's `Module Available Used Remaining` table is recorded above but not
  modelled; a stack is not a device this engine has.
* **Rounding at a half.** The samples never show a `.x5` draw. This note uses ordinary rounding to one decimal;
  whether a box rounds or truncates there is not observable in the captures in hand.
