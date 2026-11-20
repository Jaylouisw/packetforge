# `interface range`: a command the box has, answered as a missing port

**Question (one, narrow).** What does a Catalyst do with `interface range Fa0/1 - 3`, and what should this
console answer when it cannot model a range? Before this run it answered as if a socket were missing:

```
s1(config)#interface range Fa0/1 - 3
% Interface not found: range Fa0/1 - 3
s1(config)#
```

That is the sentence a misspelt port name gets (`interface Fa9/9`), about a command every IOS switch has. A
reader is told the box has no socket called `range Fa0/1 - 3`, which is true and useless: the reader has to
work out that the *command* is missing, not the port.

## Known: what `interface range` is and what it does

* The syntax is `interface range {port-range | macro macro_name}`. Cisco: *"Use the interface range global
  configuration command to configure multiple interfaces with the same configuration parameters. When you
  enter the interface-range configuration mode, all command parameters that you enter are attributed to all
  interfaces within that range until you exit this mode."*
  ([Cisco IOS XE 17 Interface Characteristics Configuration Guide, *Configure a range of interfaces*](https://www.cisco.com/c/en/us/td/docs/switches/lan/c9000/infra/interface-characteristics/interface-characteristics-configuration-guide.html)).
* It enters a mode of its own, `(config-if-range)#`. Cisco's example:
  ```
  Device# configure terminal
  Device(config)# interface range tengigabitethernet 1/1/1-2
  Device(config-if-range)# shut
  ```
  (same page, *Example: Configuring a range of interfaces*). The Catalyst 2960 command reference prints the
  same prompt for `Switch(config)# interface range gigabitethernet0/1 - 2`
  ([Catalyst 2960 Switch Command Reference, 12.2(44)SE, `interface range`](http://www.cisco.com/en/US/docs/switches/lan/catalyst2960/software/release/12.2_44_se/command/reference/cli1.html)).
* The shapes a box accepts are documented on the same page: a hyphen-separated range that does not repeat the
  type (`tengigabitethernet 1/1/1-2`), and up to five comma-separated ranges, each repeating its type and
  separated by spaces around the comma (`tengigabitethernet1/1/1 - 3 , twentyfivegige1/1/1 - 2`). "In a
  hyphen-separated *port-range*, you do not need to re-enter the interface type, but you must enter a space
  before the hyphen."
* The range is a session object, not configuration: "All configuration changes that are made to a port range
  are saved to NVRAM, but the port ranges that are created with the interface range command do not get saved
  to NVRAM" (2960 command reference, quoted in the search result for that section); the macro form needs the
  macro defined first with `define interface-range`.
* Commands are executed as they are typed, not batched at `end`: "If you enter multiple configuration
  commands in interface-range mode, the system executes each command as you enter it" (IOS XE 17 guide, note
  under the example).

So on a box the line is accepted, opens a mode, and applies later lines to N ports. This console opens one
port per line - `interface Fa0/1` - and has no range object and no `(config-if-range)#` mode. Nothing in this
model can carry "these lines go to five ports".

## Verdict: name the command, not a missing socket

The console's convention for a real command it cannot model is a sentence that says what a box does, what
this console does instead, and that nothing changed - the `vlan 10-12` refusal is the same shape:

```
% VLAN list "10-12" is not modelled: a box takes a range (10-12) or a comma-separated list (10,12) on `vlan`,
  and this console takes one id per line - nothing was changed
```

`interface range` now answers the same way:

```
s1(config)#interface range Fa0/1 - 3
% interface range "Fa0/1 - 3" is not modelled: a box takes `interface range <first> - <last>` (or
  `interface range macro <name>`) and applies each line to every port in it, and this console opens one port
  per line - no port was opened
```

and `no interface range ...` ends `nothing was removed`. `interface range ?` is answered as the help key rather
than quoted back as a range (`% "?" is the help key, not a value: ... is a command this console does not
model`), the rule `vlan 10 ?` already follows. The keyword is looked for before the port table,
because `range` is a keyword on every IOS switch and no panel in the catalogue names a socket `range...`
(checked: no device port name begins with `range`). A line with no keyword - `interface Fa0/1 - 3` - is still
a name and keeps `% Interface not found: Fa0/1 - 3`; the port-name door is untouched.

What this is not: a claim that the range was parsed. Nothing is opened, no mode is entered, and the cursor
stays where the line was typed - the rule already established for a refused interface name
([`research/interface-refusal-mode.md`](interface-refusal-mode.md)).

## Inferred, not known

* **The prompt string.** `(config-if-range)#` is quoted by the guides above and by the 2960 reference; the
  catalogue's devices are not all Cisco, and this run did not try to model the mode at all, so nothing here
  depends on the string.
* **Which member refuses the line.** It is unknown whether a range naming a port the box does not have
  (`interface range fa0/1-99` on a 24-port switch) is a caret error for the whole line, or applies to the
  members that exist. Nothing was implemented on that guess.

## Unresolved, and what would settle it

* **Per-port receipts.** If a range mode is ever modelled, what does a box print for each line - nothing, one
  line per port, or one receipt for the range? Cisco's examples show no output at all (`shut` prints
  nothing), so the receipts this console prints for single-port commands (e.g. `Description set: ...`) may not
  belong in a range.
* **A range that spans a type or a module**, and a range naming a port that is administratively down or a
  deleted access VLAN - the same lines the single-port doors already answer. **What would settle it:** a
  2960X/9200 capture of `interface range fa0/1-99` and `interface range fa0/1, gi0/1` (mixed types), plus the
  `no interface range ...` form, showing the prompt and any output after each line.
