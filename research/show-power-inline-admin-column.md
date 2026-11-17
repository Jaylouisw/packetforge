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

* That a shut port keeps `auto` in the Admin column. **Settled on 2026-11-17** - see "The shut-port row,
  settled" below. The 3750 PoE troubleshooting guide's *"Most Cisco switches turn off port power when the port is
  shut"*
  (https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3750/software/troubleshooting/g_power_over_ethernet.html)
  is about *power*, i.e. `Oper`, not about the configured mode, and that is exactly how the vendor's own example
  reads.
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

* **Whether the model should ever say `static` or `off`.** It cannot today: there is no `power inline` command,
  so there is no configuration path to those modes. Adding the command is a feature, and out of scope for a
  fidelity pass.
* **The summary block.** A 2960-X prints `Module Available Used Remaining` above the table (a 2960+ does not),
  where this console prints one `Total:` line below it. That is a layout question, deliberately answered with
  a sentence rather than a table, and it was not touched here.

## The shut-port row, settled

**Question.** A PoE port that is administratively shut, with no `power inline` line configured: does `Admin`
still read `auto`, and what happens to the power it was supplying?

**Verdict: known. `Admin` stays `auto`; the power goes.** The vendor's own worked example of
`show power inline police` on a stacking-capable Catalyst 3850, IOS XE 16.9, lists thirteen ports and then
explains each one in turn
(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3850/software/release/16-9/command_reference/b_169_3850_cr/interface_and_hardware_commands.html>,
"show power inline", Examples):

```
Admin  Oper        Admin      Oper       Cutoff Oper
Interface State  State       Police     Police     Power  Power
--------- ------ ----------- ---------- ---------- ------ ------
Gi1/0/1   auto   off         none       n/a        n/a    0.0
Gi1/0/2   auto   off         log        n/a        5.4    0.0
Gi1/0/3   auto   off         errdisable n/a        5.4    0.0
Gi1/0/4   off    off         none       n/a        n/a    0.0
Gi1/0/5   off    off         log        n/a        5.4    0.0
Gi1/0/6   off    off         errdisable n/a        5.4    0.0
```

with the notes: *"The Gi1/0/1 port is shut down, and policing is not configured."* ... *"Device detection is
disabled on the Gi1/0/4 port, power is not applied to the port, and policing is disabled."*

So the two words come from two different facts, and this example separates them:

| Port state | `Admin State` | `Oper State` | `Oper Power` |
|---|---|---|---|
| shut, `power inline` untouched | `auto` | `off` | 0.0 |
| `power inline never` (not shut) | `off` | `off` | 0.0 |
| up, PD detected | `auto` | `on` | non-zero |

`Admin` is the configured mode - shutting the link does not configure PoE - while `Oper` and the allocation
follow the link: a shut port supplies nothing. `off` in `Admin` is reachable only through `power inline never`.

That is what this model already does, and it is now pinned rather than inferred: the engine's allocation walk
iterates `activeInterfaces()`, so a shut PSE port drops out of `sim.poe` and its powered device loses its
allocation; `show power inline` then prints the port from the fallback branch as `auto / off`, draw `-`,
reason `administratively down`. `test/show-power-inline.test.js` gained three assertions for exactly the case
this note called unresolved - a PD cabled to a port that is then shut: the row reads `auto / off`, the engine
allocates no watts to the port, and the device total stays the whole budget
(`Total: 0 W of 370 W in use, 370 W left ...`).

Nothing in `engine/cli.js` changed for this: the question was asked, the vendor answered it, and the answer
matched the code.
