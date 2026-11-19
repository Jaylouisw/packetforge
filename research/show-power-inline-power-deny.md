# `show power inline`: what a refused port says in `Oper`, and what its power cell holds

**Question (one, narrow).** A PSE port has detected a powered device and cannot give it power. What does
the `Oper` column say — `off`, the word an empty socket gets, or one of the vendor's other states — and
what number sits in the power column on that row?

**Verdict: `power-deny`, and `0.0`.** `Oper` has four documented values — `on`, `off`, `faulty`,
`power-deny` — and `power-deny` is the one for "a powered device is detected, but no PoE is available".
`off` is defined as "No PoE is applied", which is what a port with nothing on it prints: the two rows were
indistinguishable here. The power cell is the power **allocated**, so a refusal carries `0.0`; the figure
the device asked for belongs to the denial sentence under the table, which already carries it.

PacketForge printed `off` and the requested wattage, with a local `(denied)` annotation:

```
1/1/2      auto   off   12.95 W  PD2  (denied)
```

That row says three times over that something was refused, in one word the box never prints there, and
prices a draw that never happened. The engine's own research note on this table
(`show-power-inline-admin-column.md`) had already quoted the four-word field table; nothing had read the
denial case out of it.

## Evidence

| Source | Says / prints |
| --- | --- |
| [Catalyst 2960-X, IOS 15.2(7)E, Interface and Hardware Commands, `power inline`](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/command_reference/b_1527_2960x_cr/interface_and_hardware_commands.html) | "If the switch denies power to a powered device (the powered device requests more power through CDP messages or if the IEEE class maximum is greater than the maximum wattage), the PoE port is in a **power-deny state**. The switch generates a system message, and the **Oper column** in the `show power inline` privileged EXEC command output **shows power-deny**." |
| [Catalyst 2960-X, IOS 15.2(2)E, command reference (PDF)](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_2_e/int_hw_components/command_reference/b_int_1522e_2960x_cr.pdf) | The `show power inline` field table: `Oper` — `on` (PD detected, power applied), `off` (no PoE is applied), `faulty`, `power-deny` (PD detected, but no PoE is available). Sample output: `Gi3/0/1 auto power-deny 4.0 n/a n/a 15.4` |
| [Catalyst 2960-X, IOS 15.2(5)E, Interface and Hardware Commands](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_5_e/command_reference/b_1525e_consolidated_2960x_cr/b_1525e_consolidated_2960x_cr_chapter_011.html) | Same sample row and field table under `show power inline module 3` |
| [Catalyst 3850, IOS XE 16.1, Interface and Hardware Commands (PDF)](https://cisco.com/c/en/us/td/docs/switches/lan/catalyst3850/software/release/16-1/command_reference/b_161_consolidated_3850_cr/b_161_consolidated_3850_cr_chapter_0100.pdf) | Same field table; `Oper` `power-deny` — "A powered device is detected, but no PoE is available, or the maximum wattage exceeds the detected powered-device maximum" |
| [Catalyst 9300, IOS XE 17.12, Interface and Hardware Commands](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-12/command_reference/b_1712_9300_cr/interface_and_hardware_commands.html) | Same field table and the same `Gi3/0/1 auto power-deny 4.0 n/a n/a 15.4` row |
| [Cisco Community, "IE-4000-8GT8GP4G-E POE - 240w budget problem"](https://community.cisco.com/t5/switching/ie-4000-8gt8gp4g-e-poe-240w-budget-problem/td-p/3939396) | A **budget-exhausted** paste, which is the shape this model produces: `Gi1/13 auto power-deny 0.0 n/a n/a 30.0` directly above `Gi1/14 auto on 15.4 Ieee PD 3 30.0`, `Gi1/15 auto on 15.4 Ieee PD 0 30.0`, `Gi1/20 auto on 30.0 Ieee PD 4 30.0` |
| [Cisco Learning Network, "PoE issue"](https://learningnetwork.cisco.com/s/question/0D53i00000Kt2uWCAR/poe-issue) | Same shape at the tail of a working stack: `Gi3/0/21 auto on 7.0 Ieee PD 2 30.0` then `Gi3/0/22 auto power-deny 0.0 n/a n/a 30.0`, `Gi3/0/23`, `Gi3/0/24` |
| [Cisco Community, "Cisco 1810W drawing 24.5W on Cisco 3650 PoE Switch"](https://community.cisco.com/t5/wireless/cisco-1810w-drawing-24-5w-on-cisco-3650-poe-switch/td-p/4404306) | `Gi1/0/9 auto power-deny 0.0 n/a n/a 30.0` between powered APs; and after `power inline static`, the same port reads `Gi1/0/9 static power-deny 15.4 n/a n/a 15.4` |
| [Cisco Community, "3560X Combined/Redundant Power Supplies"](https://community.cisco.com/t5/switching/3560x-combined-redundany-power-supplies/td-p/3020626) | `Fa1/0/6 static power-deny 10.0 n/a n/a 10.0`, explained as "Port 6 is a static port in the power-deny state because its maximum wattage is configured for 10 W" |

## What is known

1. `Oper` is one of four words and `power-deny` is the one for a detected device that gets no power. The
   same sentence, in the same words, is in four command references (2960-X 15.2(7)E, 2960-X field table,
   3850, 9300), so it is the software's rule and not one image's habit.
2. `off` is not that word: the field table defines it as "No PoE is applied" - the state of a socket with
   nothing on it, a port set to `power inline never`, or (per the 3850 worked example cited in
   `show-power-inline-admin-column.md`) a shut port. Printing it for a refusal described an empty socket.
3. The power cell on these rows is the **allocated** power: `0.0` when the budget ran out (IE-4000, CLN,
   3650 pastes), the configured port maximum when the *maximum wattage* was the reason (4.0, 10.0, 15.4 in
   the command-reference and 3560X samples). It is never the device's request.
4. `power-deny` appears with `Admin auto` and with `Admin static`, and it is orthogonal to the link: the
   3650 paste shows it on an up port with an AP behind it.

## What is inferred

* That the model's only denial - the budget ran out part-way down the port list - belongs with the
  **budget-exhaustion** captures (rule 3, `0.0`) rather than with the maximum-wattage ones. The engine has
  no `power inline max`, so the other cause is not reachable; the IE-4000 and CLN pastes are that exact
  cause and that exact cell.
* That the row should keep naming the powered device it found. A real box prints `n/a` in `Device` on a
  budget denial (nothing was classified), but this console's Device column carries the device's name on
  every other row, and the question "which box is plugged into 1/1/2" is answered better by `PD2` than by
  `n/a`. That column was already console-native and is not what this note settles.

## What remains unresolved

* `faulty` - the third unreachable word. No fault path exists in the model (no short, no class mismatch),
  so nothing prints it; a bench capture would not help, since a command to *cause* a fault is a feature.
* Whether a denial caused by real-time power policing prints `errdisable` in this view rather than
  `power-deny`. The 3850/9300 references show `errdisable` only in the `show power inline police` view,
  which this console does not model.
* The `Class` and `Max` columns (a real row ends `... n/a n/a 30.0`). This console's table stops at
  `Powered device`; adding the two columns is a layout question of its own, and the existing summary-line
  note already records that the stackable 2960-X summary table is not modelled either.

## What changed

* `engine/cli.js`, `_showPowerInline()`: a row whose device was refused reads `Oper = power-deny` and
  `Draw = 0.0 W`; the `(denied)` annotation is gone, because the word now says it and the sentence under
  the table (`1/1/2: PSE budget exhausted: 12.95 W requested, 12.05 W left`) is unchanged and carries the
  arithmetic. The `Oper` column is eleven characters wide, the width the box's own heading holds, so
  `power-deny` does not push the columns behind it out of line; idle and shut ports keep `off`.
* `test/show-power-inline.test.js`: the denied row is asserted cell by cell (`auto power-deny 0.0 W PDB`),
  and the neighbouring rows are asserted to stay `on` / `off` / `off`, so the change cannot pass by
  printing the new word everywhere.
* `test/poe-allocation-order.test.js`: the lowest port that does not fit now reads `power-deny` in the
  console view, with the denial sentence beneath it.
* `docs/CLI.md`: the sample table and the bullet on the denied row.
