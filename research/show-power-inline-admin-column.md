# `show power inline`: what the `Admin` column actually holds

**Question (one, narrow).** On an IOS-like PoE switch, is the `Admin` column of `show power inline` the
port's **link** administrative state (`up`/`down`) or the port's **PoE administration mode** - and if the
latter, which words can appear in it before anybody configures anything?

**Verdict: known, and it was wrong here.** The column carries the PoE mode, not the link. Cisco's own field
table for the command names the three words: *"Admin - Administration mode: auto, off, static"*. The factory
default is `auto`. PacketForge printed the *link's* words in that column (`up` for every working port, `down`
for a shut one), so a shut port read as though its PoE mode had been configured to something, and every
healthy port read a word the column never contains. Changed to `auto` (see "What changed" below).

## What is known

The field table is verbatim in at least four command references, and the wording is identical in all of them:

| Field | Description |
|---|---|
| Admin | Administration mode: auto, off, static. |
| Oper | Operating mode: on (PD detected, power applied), off (no PoE applied), faulty, power-deny. |
| Power | Maximum power allocated to the powered device, in watts. |
| Device | Detected device type: `n/a`, `unknown`, `Cisco powered-device`, `IEEE powered-device`, or the CDP name. |
| Class | IEEE classification: `n/a` or 0-4. |
| Max | Maximum power allocated to the powered device, in watts. |

* Catalyst 2960-X, IOS 15.2(6)E, Interface and Hardware Commands -
  http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/command_reference/b_1526_2960x_cr/interface_and_hardware_commands.html
* Catalyst 2960-X, IOS 15.2(7)E (same table, same words) -
  http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/command_reference/b_1527_2960x_cr/interface_and_hardware_commands.html
* Catalyst 2960, IOS 12.2(44)SE, PoE configuration note (older, shorter table, same three words) -
  https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_44_se/configuration/note/ol14988.html

`auto` is the default, from the interface command's own "Command Default" block: *"The default is auto
(enabled)."* (Catalyst 2960-L, `power inline`, https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960l/software/15-2_7_e/command_reference/b_1527_2960l_cr/interface_and_hardware_commands.html,
and the 2960-X 15.2(2)E consolidated guide). The same page confirms the `Oper` vocabulary independently:
*"If the switch denies power to a powered device ... the Oper column in the show power inline privileged EXEC
command output shows power-deny."*

A real 2960+ running 15.0(2)SE6, in a Cisco support document, prints the column exactly as the table says:

```
Interface Admin  Oper       Power   Device              Class Max
Fa0/6     auto   off        0.0     n/a                 n/a   15.4
Fa0/9     auto   on         3.3     IP Phone 7821       1     15.4
Fa0/14    auto   on         13.7    IP Phone DX650      4     15.4
```
https://www.cisco.com/c/en/us/support/docs/switches/catalyst-2960-series-switches/200371-Mismatching-consumed-power-inline-valu.html

So on a factory-default box every PSE port reads `auto` - powered, idle and denied alike - and the only way
to see another word is to configure one (`power inline never` -> `off`, `power inline static` -> `static`).

## What changed

`show power inline` here printed `i.enabled ? 'up' : 'down'` in the `Admin` column (engine/cli.js, both the
table and the no-budget fallback). That is the link's word:

* a port supplying power read `up`, which is not one of `auto|off|static`;
* a shut port read `down`, which reads as "the PoE mode was configured off" - the exact confusion the column
  exists to prevent, since the row's own reason column already says `administratively down` and `Oper` says
  `off`;
* the console's `Oper` word was already right (`on`/`off`), so only one of the two columns was wrong.

One method, `_poeAdminMode()`, now answers the column, and it returns `auto`: the factory default, and the only
mode reachable here because this model has no `power inline` command. The test
`test/show-power-inline.test.js` pins it - including a lab where one PSE port is shut, so the regression is
"A shut port is still `auto`", not just "the word changed".

## What is inferred

* That a shut port keeps `auto` in the Admin column. No transcript in hand shows `show power inline` for a
  port that is shut but whose PoE mode is untouched. The inference is that the two are separate settings -
  the 3750 PoE troubleshooting guide says *"Most Cisco switches turn off port power when the port shutdowns"*
  (https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3750/software/troubleshooting/g_power_over_ethernet.html),
  which is about *power*, i.e. `Oper`, not about the configured mode - and that `Admin` mirrors the `power
  inline` line in the running config. If it turns out a shut port prints `off`, this is a one-line change in
  `_poeAdminMode()` and one assertion.
* That `power inline never` displays as `off` rather than `never`. The field table lists `off` among the three
  words and `never` among none of them, and a 2960 transcript in a Cisco community thread shows
  `Fa0/24 off off 0.0 n/a n/a 15.4` right after `power inline never`
  (https://community.cisco.com/t5/switching/interface-in-catalyst-2960-x-poe-show-down-down/td-p/3040112 -
  the page is JS-rendered and I could only read the indexed text, so this is secondary evidence; the primary
  evidence is the field table itself).
* That the same rule holds on the non-Cisco vendors in the catalogue. It does not, and it does not need to:
  this view is IOS-shaped (the headers `Interface`/`Admin`/`Oper` are IOS's), and the model has one PoE view
  for every device. Cisco Business/Catalyst 1200/1300 switches print `Auto`/`Never` capitalised with extra
  `Priority` and `Searching` columns - a different view, not a different answer to this question.

## What remains unresolved

* **A shut port's Admin word** (above). One `show power inline <port>` capture from a box with `shutdown` on a
  PoE port and no `power inline` line would settle it in one line.
* **Whether the model should ever say `static` or `off`.** It cannot today: there is no `power inline` command,
  so there is no configuration path to those modes. Adding the command is a feature, and out of scope for a
  fidelity pass.
* **The summary block.** A 2960-X prints `Module Available Used Remaining` above the table (a 2960+ does not),
  where this console prints one `Total:` line below it. That is a layout question, deliberately answered with
  a sentence rather than a table, and it was not touched here.
