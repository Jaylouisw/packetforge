# A shortened command word: `sh ver` is `show version`

**Question (one, narrow).** When an operator shortens a **command keyword** at the EXEC prompt - `sh ver`,
`sh int`, `conf t` - does an IOS-like box accept it, how short may the shortening be, what does it print when the
shortening could mean more than one command, and at which words must a simulator stop applying the rule?

**Verdict: known for the command word, and it was wrong here.** IOS accepts any abbreviation that is still
unique, states so in its own words, and refuses a shared prefix as ambiguous. This console accepted exactly one
abbreviated command word (`configure`, since #1661) and refused every other one: `sh ver`, the spelling
operators actually type, answered `% Unrecognized command: sh ver`. The rule is now applied at the two positions
where this console keeps a complete table of what may stand there, with the boundary stated below.

## What is known

The vendor states the rule twice, in the same sentence, in two configuration guides:

> You can abbreviate commands and keywords to the number of characters that allow a unique abbreviation. For
> example, you can abbreviate the **configure terminal** command to **config t**. Because the abbreviated form of
> the command is unique, the router will accept the abbreviated form and execute the command.

* Cisco IOS XE 16 Configuration Fundamentals, *Using the Cisco IOS Command-Line Interface* -
  https://cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/configuration/xe-16/fundamentals-xe-16-book/cf-cli-basics.html
* Cisco IOS 12.2SR Configuration Fundamentals, same chapter, same wording -
  https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/configuration/guide/12_2sr/cf_12_2sr_book/cf-cli-basics.html

The answer to a shared prefix is in the same chapter family's error table, and is a message with no caret line:

> `% Ambiguous command: "show con"` - the prefix matched more than one command

* Catalyst 2960-X 15.2(6)E CLI chapter, *Understanding CLI Error Messages* -
  https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/command_reference/b_1526_2960x_cr/using_the_command_line_interface.html

That `sh` reaches `show` is not inference. It is in every Cisco community thread where somebody pastes a version
banner, because that is how people type it:

```
Switch#sh ver
Cisco IOS Software, C2960 Software (C2960-LANBASE-M), Version 12.2(35)SE5, RELEASE SOFTWARE (fc1)
```
https://community.cisco.com/t5/routing/sh-version/td-p/1506039

and on a current image:

```
SWITCH#sh ver
Cisco IOS XE Software, Version 16.09.03
```
https://community.cisco.com/t5/switching/schedule-9200-software-upgrade/td-p/4176330

## What was wrong here, measured

One session on a `generic-switch`, before the change:

```
sw1#en                 -> (enable mode)                     the one abbreviation this console knew
sw1#conf t             -> (config mode)                     the second, from #1661
sw1#sh ver             -> % Unrecognized command: sh ver
sw1#sh int             -> % Unrecognized command: sh int
sw1#show ver           -> version banner                    a whole spelling, always accepted
```

So a console that has the view refused the way an operator asks for it, and the refusal named the whole line as an
unknown command - which reads as "this box has no such command", the one thing that was not true.

## What changed

`engine/cli.js` now resolves a typed word against a table of the words that may stand in that position, and does
so at exactly two positions - the ones where such a table exists and is complete:

| position | table | example |
|---|---|---|
| the first word of an EXEC line | `EXEC_WORDS` (12 words) | `sh ver`, `en`, `conf t`, `trac` |
| the view word after `show` | `SHOW_VIEW_WORDS` (14 words) | `sh ver`, `sh int`, `sh sp`, `sh acc` |

`resolveCommandWord()` returns the word the dispatcher tests, or the words it could have meant. An exact spelling
wins over a longer one that starts with it (`link` is not made ambiguous by `links`); one prefix match is the
answer; more than one is refused in the console's existing words -
`% Ambiguous command "show i": interfaces | ip | ipv6 (type more characters)` - which is the same sentence
`configure` has answered with since #1661, and which names the *spellings* the operator could have meant, not the
doors they open (`show p` is ambiguous between `power` and `port-channel`, never "etherchannel").

A word that matches nothing is refused exactly as before, and the spelling that reached a door is still the one a
later refusal names: `sh port-c 1` answers `% show port-c does not take "1"`, not the canonical
`show etherchannel`.

## What is inferred, and where the rule deliberately stops

* **The word set is this console's, not the box's.** IOS resolves a prefix against the hundreds of commands the
  image has; this console has twelve at EXEC and fourteen after `show`. A prefix that is unique here may well be
  ambiguous on a real box: `sh s` answers the spanning tree here, and on a 2960 it is also the first letters of
  `snmp`, `ssh` and `spanning-tree`. Nothing in the console can know the rest of the vendor's grammar, so the
  honest position is that the rule is applied to the table that exists, and the short-prefix difference is stated
  rather than hidden. A capture of `sh s` and `sh p` on a 2960 would show exactly how far the two tables differ.
* **Where there is no complete table, nothing is resolved.** The words after `show ip` (`int`, `br`), a keyword
  such as `brief`, and a value such as a port name all have neighbours this console cannot enumerate, so a short
  word there cannot be told from an ambiguous one. `show ip int br` is still refused, and the test asserts it -
  that is a decision, not an omission. Guessing in those positions would accept lines a box refuses for reasons
  this console does not model (see research/parse-error-caret.md for the same reasoning about the caret).
* **The refusal is the console's sentence, not IOS's.** A real box prints `% Ambiguous command:  "show con"`;
  this console has printed `% Ambiguous command "c": configure | converge (type more characters)` since #1661, and
  that spelling is kept rather than adding a second style for the same fact. IOS's own wording (and whether the
  colon inside the quotes and the double space are stable across releases) is a separate question about message
  text, not about which commands are accepted.

## What remains unresolved

* **Config mode is not resolved.** `int Gi0/1` and `host r1` are still refused, though a box accepts both. Config
  mode has its own keyword table and its own sub-modes (`interface` opens a mode, so a wrong resolution changes
  state rather than printing a table), which is a larger question than this run's.
* **`do sh ver`.** `do` accepts only the whole word `show` today, so the same abbreviation that works at `#` does
  not work inside `(config)#`. One line, but it belongs with the config-mode question above.
* **Words after `show ip`.** `show ip int br` needs a table for `interface` and for `brief`, and each further
  `show ip <x> <y>` form needs its own. Not attempted.
* **Whether IOS's uniqueness is per mode or across the whole image.** `co` is ambiguous at EXEC on a box
  (`configure`, `connect`, `copy`); whether a word that exists only in config mode can make an EXEC prefix
  ambiguous was not settled by any source read here.
