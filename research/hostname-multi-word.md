# `hostname` with more than one word: a parse error, or a name with a space in it?

**Question (one, narrow).** `hostname` is quoted everywhere as taking one word (`hostname name`), and the ARPANET
rule the vendor publishes for that word has no space in it. What does an IOS-like box do with
`hostname core switch 1` - refuse it at the second word with the parser's caret error, warn and take the whole
string the way it takes an all-numeric name, or take it silently? This console takes it silently, and then prints
a prompt no box can print.

**Verdict: unresolved, and left alone - but the second half is now measured, and it is not one device.**
Every reference found says a space cannot be part of a host name, and none shows the command being given one, so
the outcome is still an open question (the same one `research/hostname-illegal-characters.md` left open as item 3).
What is new here is the size of the consequence: this console's *default* hostname contains a space on 2172 of
2352 catalogue models, so the illegal shape is not an operator's typo - it is what every lab is born with.

## What the vendor publishes

| Source | Says |
| --- | --- |
| [Cisco TAC E-Learning reprint, `hostname` command reference](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/hostname.htm) | The grammar is one word: `hostname name`, with `name` = "New host name for the network server". The rule: "They must start with a letter, end with a letter or digit, and have as interior characters only letters, digits, and hyphens. Names must be 63 characters or fewer." |
| [Cisco IOS Configuration Fundamentals Command Reference, F through K - `hostname`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/command/cf_command_ref/F_through_K.html) | The same rule verbatim, plus the only documented breach outcome: "Creating an all numeric hostname is not recommended but the name will be accepted after an error is returned", with `% Hostname contains one or more illegal characters.` and then `123(config)#`. |
| [Cisco 250 Series Managed Switches Administration Guide, *System Settings*](https://www.cisco.com/c/en/us/td/docs/switches/lan/csbms/250_/2_5_7/Admin_guide/tesla-250-ag/cb_250_chapter_07.html) | The one place found that names the space explicitly: "Use only letters, digits, and hyphens. Host names can't begin or end with a hyphen. No other symbols, punctuation characters, or **blank spaces** are permitted (as specified in RFC1033, 1034, 1035)." |
| [Catalyst 2960-X Network Management Configuration Guide 15.0(2)EX, *Common CLI Error Messages*](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-0_2_EX/network_management/configuration_guide/b_nm_15ex_2960-x_cg.pdf) | The parser's own table: "You entered the command incorrectly. The caret (^) marks the point of the error" - `% Invalid input detected at '^' marker.` |
| [Cisco Community, "Switch WS-C3650-48TQ Problem after update software"](https://community.cisco.com/t5/switching/switch-ws-c3650-48tq-problem-after-update-software/td-p/4491816) | The nearest behavioural witness: a 3650 on 16.6.4 loading a config prints both messages in one stream - `% Invalid input detected at '^' marker.` for lines the parser would not take, and a run of `% Hostname contains one or more illegal characters.` It shows the two outcomes exist side by side; it does not show which one a space gets. |

## What is known

* **The argument is one word.** The syntax line is `hostname name`, not `hostname line`; nothing in any reference
  gives the argument a multi-word form.
* **A space is not an interior character the rule allows.** Letters, digits and hyphens only - and the 250-series
  guide, the only document found that bothers to say it, rules out blank spaces by name.
* **A name the rule refuses can still be taken.** That is documented for the all-numeric case and only for that
  case: the error is printed and the prompt carries the name.
* **The parser has a second, different outcome for input it cannot parse at all** - the caret error, printed
  instead of taking anything.

## What is inferred (not witnessed)

* **That a second word is the caret error, not the illegal-characters warning.** Reading the line as
  `hostname <word> <extra>` leaves `switch 1` as input the grammar has no room for, which is the caret table's
  case. Reading it as one string containing spaces is the illegal-characters case. Both readings fit the
  documents; the caret one fits the *grammar* line, and the illegal-characters one fits the *rule* paragraph.
* **That the name is not taken when the caret error fires.** The all-numeric case is documented as an exception
  ("accepted after an error is returned"); nothing suggests the parse-error path takes anything.

## What PacketForge does today

Measured on this branch's base, `Catalyst2960`, device id `SW1`, nothing else configured:

```
Catalyst 2960-SW1(config)#hostname core switch 1
core switch 1(config)#
```

The line is accepted with no output, the prompt becomes `core switch 1(config)#`, and `show running-config`
prints `hostname core switch 1` as the first stanza - a line a real box would not have written and, by the
grammar above, would not read back. The same silence covers `hostname two words`, and it is not a corner:
`hostnameIsAllNumeric()` is the only shape the command checks (`engine/cli.js`), so a space is the one breach the
console never mentions.

**The default name has the shape too.** A device with no `hostname` takes its name from the catalogue entry
(`<label>-<id>`), so `Catalyst 2960-SW1` is the *first* prompt a lab shows. Counting the catalogue's own labels:

| | count |
| --- | --- |
| catalogue models (`loadCatalog('devices')`) | 2352 |
| models whose label contains a space, and so whose default hostname does | **2172** |
| models whose default hostname is a legal host label | 180 |

Examples of the 2172: `ICR-3231 industrial LTE router`, `eero Pro 6E`, `7280R3 48YC8 25G/100G router`,
`ASUS ZenWiFi ET8 (AXE6600)`, `RT-AC5300 tri-band router`. Several also breach the character rule outright
(the parentheses and the slash above), which is the fact `research/hostname-illegal-characters.md` already
recorded as the reason the warning could not be widened.

## Why nothing was changed

The console's policy on this command is "warn only where a transcript shows the outcome" - written down in
`research/hostname-illegal-characters.md` and implemented as the numeric-only check. The multi-word outcome is
exactly the missing transcript, so a refusal or a warning here would be the invention that policy forbids.

There is also a mechanical reason, and it is the interesting one: every catalogue default is multi-word, so a
check on spaces would fire on 2172 of 2352 devices the moment their config was replayed. `test/config-roundtrip`
replays all of them and asserts no complaint. That is not an argument for silence - it is evidence that the
*default naming* is the thing that cannot be reconciled with the rule, and that the parser rule has to wait for it.

## What remains unresolved, and what would settle it

1. **Which outcome a space gets.** **What would settle it:** one console capture of `hostname core switch 1` on
   any IOS/IOS XE box, showing either the caret under `switch` or the illegal-characters line, plus the prompt
   after it. `hostname two words` would do; a 15.2E 2960-X and a 17.x 9300 would settle whether the platform
   matters.
2. **Whether the name is taken on the caret path.** The same capture's prompt answers it.
3. **What a default device name should be.** The vendor's own default is `Router` / `switch` - legal, one word,
   and identical on every box. This catalogue wants the device's model in the prompt, which is a simulator
   decision rather than a device fact. **What would settle it:** a decision (a sanitised `Catalyst-2960-SW1`, a
   bare `SW1`, or the model kept and the parser left lenient), after which the prompt, `show running-config` and
   the roundtrip fixture all follow from one function.
