# `clear counters` — the confirmation line, the syslog receipt, and the "Last clearing" age

**Question (one, narrow).** When an IOS-like box is asked to zero its interface counters — bare
`clear counters` and `clear counters <interface>` — what exactly does it print *before* it acts, what must
the operator answer, what does it print *after*, and what does `show interfaces` then say about when the
counters were last cleared?

**Verdict: the box asks first, and the ask is part of its output.** The command does not clear anything when
it is parsed: it prints one confirmation line and waits. The line is

```
Clear "show interface" counters on all interfaces [confirm]
```

for the bare form and

```
Clear "show interface" counters on this interface [confirm]
```

for a named one; Enter or `y` accepts, and nothing else in the line is required. Once accepted the box prints
no success sentence — only a syslog receipt, `%CLEAR-5-COUNTERS: Clear counter on all interfaces by console`
(bare) or `... Clear counter on interface gigabitEthernet0/0` (named). `show interfaces` then carries
`Last clearing of "show interface" counters <age>`, where `<age>` is `never` until the first clear since the
last reload and otherwise an uptime-shaped figure (`00:05:52`, `2d22h`, `6w1d`; older images `0:00:06`).
Two consequences a simulator has to copy: the prompt appears even when the counters are already zero, and a
clear does not touch SNMP counters, the load/reliability figures, or the rate averages.

## What PacketForge does today

Measured on `51bd617f` + this branch, a `generic-router` at `r1#`:

```
r1#clear counters
% Unrecognized command: clear counters
r1#clear counters Gi0/0
% Unrecognized command: clear counters Gi0/0
r1#clear
% Unrecognized command: clear
```

| fact | where |
|---|---|
| no `clear` word: `EXEC_WORDS` is enable/configure/converge/show/ping/link/links/traceroute/exit/logout/quit/help | `engine/cli.js:185-197` |
| no pending-prompt state: `CliSession.run(line)` takes **one** line and returns `{output, actions}`; a second (blank) line is a no-op | `engine/cli.js:1134-1141` |
| one port's tally, and its shape with nothing counted | `emptyPort()` `engine/flow.js:382`; `portCounters()` `:516` |
| what the console prints of it | `engine/cli.js:7683-7686` |
| the one reset that exists | `resetFlowState()` `engine/flow.js:366`, called when a topology replaces its flow state |
| the promise in the docs | `docs/CLI.md:1103`: counters "accumulate over every run against that topology, like real interface counters - a second `ping` adds to the first" |
| the plan that would add the command (steps 1-3, step 4 needs approval) | `docs/plans/counter-reset.md` |

Nothing in this run changed that: adding the command is the plan's step 2, i.e. new surface, and this run is
for fidelity of behaviour that already exists. The note exists so that step 2 does not have to guess the
words.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco, *Interface and Hardware Component Command Reference, IOS XE 3SE (3850)*, `clear counters`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-xe-3se-3850-cr-book/channel_group_through_cut_through.html) | "To clear the interface counters, use the **clear counters** command in **user EXEC or privileged EXEC** mode"; syntax `clear counters [ interface-type interface-number ]`; "This command clears all the current interface counters from the interface unless the optional arguments interface-type and interface-number are specified to clear only a specific interface type"; the note: "This command does not clear counters retrieved using SNMP … However, variables seen with the **show interfaces** command that could affect routing, such as load and reliability, or non-cumulative variables, such as input or output rates, are not cleared". Its single-interface example prints the **all** wording — see *unresolved* 1 |
| [Cisco, *Troubleshoot T1 PRI*, doc 8131](https://www.cisco.com/c/en/us/support/docs/wan/t1-e1-t3-e3/8131-T1-pri.html) | the bare form, byte for byte: `maui-nas-03#clear counters` / `Clear "show interface" counters on all interfaces [confirm]` / `maui-nas-03#` / `*Apr 12 03:34:12.143: %CLEAR-5-COUNTERS: Clear counter on all interfaces by console`. The prompt returns only after the operator answers; the receipt is a syslog line with the timestamp prefix |
| [Cisco, *Software Configuration Guide for IOS 15.4(3)T* (GGSG), "Clearing and Resetting the Interface Counters" (PDF)](http://cisco.com/c/en/us/td/docs/solutions/GGSG-Engineering/15-4-3M/config-guide/Configuration-Guide/Config.pdf) | the named form: `Router#clear counters gigabitEthernet 0/0` / `Clear "show interface" counters on this interface [confirm] y` / `*Sep 30 08:42:55: %CLEAR-5-COUNTERS: Clear counter on interface gigabitEthernet0/0`; and "The **clear counters** command (without any arguments) clears all the current interface counters from all interfaces" |
| [Cisco, *System Monitoring Command Reference for CRS / ASR 9000 / NCS 5500* — `clear counters`](http://cisco.com/c/en/us/td/docs/routers/crs/software/system_monitoring/command/reference/b-sysmon-cr-crs/m_or40stat.html) | the IOS XR spelling and the semantics stated in words: syntax `clear counters interface [all \| type interface-path-id]`; "When you enter this command, the system prompts you for confirmation. You must then press **Enter** or the **y** key for the clear counters command to take effect"; examples print `Clear "show interface" counters on all interfaces [confirm]` and, for one port, `Clear "show interface" counters on this interface [confirm]`; same SNMP note |
| [Ansible, `cisco.ios.ios_command`](https://docs.ansible.com/ansible/2.10/collections/cisco/ios/ios_command_module.html) and the [current collection docs](https://docs.ansible.com/projects/ansible/15/collections/cisco/ios/ios_command_module.html) | the module's worked example for prompting commands *is* this command, and it gives the prompt as a regex: `Clear "show interface" counters on this interface \[confirm\]`, answered `y`, and `[confirm]` answered `"\r"` — so a bare carriage return confirms. Its captured stdout is `Clear "show interface" counters on this interface [confirm]y`, i.e. the answer is echoed on the same line |
| [Netmiko guidance](https://www.rconfig.com/netmiko) and [r/networking thread](https://www.reddit.com/r/networking/comments/8zeni7/clearing_counters_with_netmiko_python/) | tooling has to read until `[confirm]` and then send a newline before the command returns — the prompt blocks the session, it is not a cosmetic echo |
| [Cisco, *Catalyst 2960-XR 15.2(5)E Consolidated Configuration Guide* — EEM Tcl sample](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15-2_5_e/configuration_guide/b_1525e_consolidated_2960xr_cg/eem_4_0_event_tcl_command_extensions.html) | five consecutive `Device#clear counters`, each printing the same confirm line and each producing its own `%CLEAR-5-COUNTERS: Clear counter on all interfaces by console` — the prompt is printed whether or not anything was counted, and the receipt is not a one-off |
| [Cisco, *Troubleshoot Switch Port and Interface Problems*, doc 12027](https://cisco.com/c/en/us/support/docs/switches/catalyst-6500-series-switches/12027-53.pdf) | defines the field: "**Last clearing of show interface counters** - The last time the **clear counters** command was issued since the last time the switch was rebooted"; prints `never`, `16:47:42` and `2d22h` in its samples |
| [Cisco, *show interfaces* command reference (12.0)](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/show_interfaces.htm) | `Last clearing of "show interface" counters 0:00:00` and `... 0:00:06` — one-digit hour on that image |
| [Cisco, *Understand Output Drops on Catalyst 9000*](https://www.cisco.com/c/en/us/support/docs/switches/catalyst-9600-series-switches/220491-understand-output-drops-on-high-speed-in.html) | a live Cat9k block: `Last input 00:00:06, output 00:00:10, output hang never` / `Last clearing of "show interface" counters 6w1d` — the two-digit form and the weeks/days abbreviation |
| [Catalyst 4500 12.2 configuration guide](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/52sg/configuration/guide/config/sw_int.pdf) | `Last clearing of "show interface" counters never` on an SVI that had never been cleared |
| [Stack Overflow, "Perl Net::SNMP::Interfaces / interface errors"](https://stackoverflow.com/questions/6448794/perl-netsnmpinterfaces-interace-errors) | a real capture of the named form: `switch1#clear counters fa0/1` / `Clear "show interface" counters on this interface [confirm]y`, then `show int fa0/1` a second later reads `1229 packets input` — traffic is not stopped by the clear, and the counters start again from the next frame |
| [Cisco, *Catalyst 2960-XR Interface and Hardware Component Configuration Guide* 15.0(2)EX1 (PDF), Table 6](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15-0_2_EX1/int_hw_components/configuration_guide/b_int_152ex1_2960-xr_cg.pdf) | the platform's own table: `clear counters [interface-id]` — "Clears interface counters", listed under privileged EXEC, beside `clear interface <id>` and `clear line` |
| [Cisco, *Layer 2/3 Command Reference, IOS XE 3.6E (3850)* (PDF)](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3850/software/release/3e/layer2/command_reference/b_Layer2_3_3e_3850_cr.pdf) | the CLI chapter's own words: user EXEC offers "one-time commands, such as **show** commands … and **clear** commands, which clear counters or interfaces" — see *unresolved* 2 |
| [Cisco, *Cisco Routers for the Desperate* ch. 5 (No Starch sample PDF)](https://nostarch.com/download/cisco2_ch5.pdf) | an operator transcript: `router# clear counters` / `Clear "show interface" counters on all interfaces [confirm]` / `router#`, then "This resets all the counters on all the interfaces to zero" |
| [Cisco, *Catalyst 3850 `clear lacp counters`* (same page as `clear counters`)](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-xe-3se-3850-cr-book/channel_group_through_cut_through.html) | the control case: `Router# clear lacp 1 counters` returns straight to the prompt with **no** confirmation line and no receipt — so "a clear command prompts" is not a rule of the word `clear`, it is a property of this command |

## What is known

1. **Both forms exist and the named one is optional.** Bare `clear counters` clears every interface; a
   type+number clears that one (`clear counters gigabitEthernet 0/0`, `clear counters fa0/1`,
   `clear counter port-channel 1` — the type word is the usual prefix-matched keyword, so `count`,
   `counter`, `counters` all reach it).
2. **The prompt is printed, not assumed.** The whole line, including the quoted `"show interface"`, is the
   vendor's: the quotes around `show interface` are part of the output in every capture above.
3. **The two sentences differ by one phrase**: `on all interfaces` vs `on this interface`, and both end
   ` [confirm]` — one space before the bracket, no colon, no question mark.
4. **Enter or `y` confirms.** IOS XR's reference says so in words; Ansible's example answers the same prompt
   with `y` in one task and `"\r"` in the next. The answer is echoed after the bracket
   (`…[confirm]y`), which is ordinary terminal echo, not output the box composes.
5. **Nothing is printed on success except the syslog line.** `%CLEAR-5-COUNTERS: Clear counter on all
   interfaces by console` for the bare form; `%CLEAR-5-COUNTERS: Clear counter on interface
   gigabitEthernet0/0` for a named one. The facility/mnemonic (`CLEAR-5-COUNTERS`) and the free-text tail
   (`by console`) are the vendor's; the timestamp in front (`*Apr 12 03:34:12.143:`) is `service timestamps`
   output and appears only when timestamps are on.
6. **The clear is idempotent and unconditional.** A cleared-just-now port still draws the prompt
   (2960-XR EEM sample, five times in a row) — there is no "nothing to clear" path and no state check.
7. **`show interfaces` dates the clear** with `Last clearing of "show interface" counters <age>`, and `never`
   means "not since the last reload" (12027's definition). The age is uptime-shaped: `00:05:52`, `16:47:42`
   under a day (older images `0:00:06`, one-digit hour), then `2d22h`, `6w1d`.
8. **What a clear does not touch**: SNMP counters, load/reliability, and the non-cumulative rate averages.
   Only the cumulative counters `show interfaces` prints.
9. **Traffic is not interrupted.** The Stack Overflow capture shows counters restarting within a second of
   the clear.
10. **The command's mode is stated inconsistently by Cisco itself** — see *unresolved* 2.

## What is inferred

* **The prompt is the parser's, so it comes before any state is read.** Every capture prints it immediately
  after the command word, and the receipt is the only thing that follows the answer; that is the shape of a
  command that prints its question while parsing and then runs. What is *not* shown by any capture in hand
  is whether a bad interface name is refused *before* or *after* the question (see *unresolved* 3).
* **A declined answer leaves both the counters and the screen alone.** No capture of an `n` answer was found;
  the two-line transcripts above return to `#` with no sentence, and the vendor documents no abort message
  for this command (contrast `delete`, which prints nothing either). The safe reading is: no output, nothing
  cleared.
* **The age is a wall-clock-style rendering of one timestamp, not a per-interval counter.** `never` →
  `6w1d` in the Cat9k capture is the same field as `0:00:06` in the 12.0 reference, so the format is a
  presentation rule, and the only stable half is the `<w>w<d>d` / `hh:mm:ss` split.
* **A named clear moves only that port's timestamp.** This follows from "clears only the counters for that
  interface", but no capture prints two ports' `Last clearing` lines side by side (see *unresolved* 4).

## What is unresolved

1. **Whether the named form says "this interface" on every IOS.** The 3850 command reference's own example
   for a port-channel prints `Clear "show interface" counters on all interfaces [confirm] Y` after
   `clear counter port-channel 1`, with the receipt `Clear counter on all interfaces by console 1`. Every
   other source here — the GGSG chapter, the IOS XR references, Ansible's prompt regex, the Stack Overflow
   capture — prints `on this interface`. The 3850 example also writes `counter` (singular) and carries a
   stray trailing `1`, so it reads as a copy of the all-interfaces example with the wrong first line; the
   majority wording is `on this interface`. **Would settle it:** a Catalyst 9300/3850 capture of
   `clear counters gi1/0/1` with the answer visible.
2. **Whether the command is available at `>` (user EXEC).** The 3850 command reference's header says "user
   EXEC or privileged EXEC", and the same book's CLI chapter gives `clear` commands as its example of
   user-EXEC one-time commands; every switch configuration guide's table calls it "privileged EXEC". No
   capture shows `Switch>clear counters`. This matters because this console has both prompts and would have
   to choose. **Would settle it:** a `>` transcript from a 2960/9300, or one config guide that shows the
   prompt at `>`.
3. **What a bad interface name does.** No capture of `clear counters gi9/99` (or a misspelt type) was found.
   The two possible shapes are the caret refusal (`% Invalid input detected at '^' marker.`) with no prompt,
   or the prompt followed by a failed clear. **Would settle it:** one transcript.
4. **Whether `Last clearing` is per-interface.** Inferred above from the command's scope; a two-port capture
   after clearing one of them would settle it.
5. **Whether the syslog receipt is printed when console logging is off.** It is a syslog message, so
   `no logging console` should hide it while the clear still happens; no capture found. **Would settle it:**
   a box with console logging disabled, `clear counters`, and the absence of the `%CLEAR-5-COUNTERS` line.
6. **NX-OS and the CBS/220 families.** NX-OS's `clear counters` reference documents no confirmation, and the
   220-series CLI guide's example clears without one; both are different CLIs, and this console's door is
   the IOS one. Out of scope here, recorded so a later reader does not average the two.

## What the counter-reset plan should take from this

* Step 2's acknowledgement is **not a sentence**: it is one pre-action line ending ` [confirm]`, printed
  even when every counter is already zero, and afterwards only the syslog receipt.
* The two strings, verbatim (with the quotes), are
  `Clear "show interface" counters on all interfaces [confirm]` and
  `Clear "show interface" counters on this interface [confirm]`.
* A confirm prompt needs a second line of input, which `CliSession.run()` does not have today; a console that
  cannot be answered would have to either accept the command without the question (and say so in its help)
  or grow the one-line pending state. That choice is the plan's, not this note's.
* Step 3's signpost and the `show interfaces` block are where `Last clearing of "show interface" counters
  never` belongs once a clear can move it; before that the line would be a constant, and this console's
  block is deliberately not the vendor's 30-line one.
* Nothing here changes the plan's step 1 (`clearPortCounters` deletes the row): the vendor evidence is about
  what is printed, and deleting the tally is what makes the printed zero true.

## Why this run changed no engine code

The behaviour does not exist yet in this tree: `clear counters` is `% Unrecognized command`, and adding the
word, the prompt and the receipt is the counter-reset plan's step 2 — new surface. The honest increment is
the wording above, with its sources, so that step is written from a capture rather than from memory.
