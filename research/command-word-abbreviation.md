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
  `research/show-tail-abbreviation.md` (later) keeps that decision for the `show ip` position and applies the rule
  at four slots where the vendor's syntax leaves no rival - `show vlan br`, `sh lldp nei`, `show ether summ`, and
  `show ip interface br`.
* **The refusal is the console's sentence, not IOS's.** A real box prints `% Ambiguous command:  "show con"`;
  this console has printed `% Ambiguous command "c": configure | converge (type more characters)` since #1661, and
  that spelling is kept rather than adding a second style for the same fact. IOS's own wording (and whether the
  colon inside the quotes and the double space are stable across releases) is a separate question about message
  text, not about which commands are accepted.

## Second pass: the same rule at `(config)#`

The bullet below said config mode was a larger question than that run's. It was answered the next run, against one
transcript that settles both halves at once. Connected Dots' CLI-error page prints a real box doing exactly this:

```
Router(config)#int gi0/1
Router(config-if)#ip adress 10.100.100.1. 255.255.255.0
```

and, three paragraphs later, the same page showing why a shortened *view* needs `do` inside config mode:

```
Router(config)#sh run
Router(config)#s^
% Invalid input detected at '^' marker.
Router(config)#do sh run
Building configuration...
```

https://www.connecteddots.online/resources/cisco/invalid-input-detected-at-marker

A Cisco community thread prints the same two lines from four different boxes
(`D11(config)#do sh run int g0/1`, `SW1(config)#do sh run int gi0/1`), and a guide page prints
`SW1(config)#interface gi0/1` accepted:

* https://community.cisco.com/t5/routing/hsrp-standby-router-is-unknow/td-p/4602792
* https://www.connecteddots.online/resources/cisco/switchport-trunk-native-vlan

So: a box accepts a shortened **first word** of a config line, accepts a shortened EXEC word after `do`, and does
**not** accept a bare `show` at `(config)#` - the third fact is a divergence this console already had and this run
did not change (`show version` is accepted at `(config)#` here; a box wants `do show version`).

`engine/cli.js` now resolves the first word of a config line against `CONFIG_WORDS`, a 21-entry table whose every
`word` is a `head ===` the config dispatcher already compares against - so a shortening can only reach a door the
whole spelling reaches - and the word after `do` against `EXEC_WORDS`. A shared prefix is refused in the console's
existing sentence, with the mode left alone:

```
sw1(config)#i     -> % Ambiguous config command "i": interface | ip | ipv6 (type more characters)
sw1(config)#e     -> % Ambiguous config command "e": exit | end (type more characters)
sw1(config)#host r1   -> r1(config)#       (was: % Unrecognized config command: host r1)
sw1(config)#vla 20 name lab   -> VLAN 20 created (name: lab)
sw1(config)#sp priority 4096  -> Bridge priority set to 4096
sw1(config)#do sh ver         -> the version banner
```

`test/command-word-abbreviation.test.js` pins 54 new assertions: each shortened line answers byte-for-byte as its
whole spelling, the ambiguity refuses and leaves `mode === 'config'`, a word no door has (`enabl`) keeps its old
refusal, and the second word of a config line is still not resolved (`ip ro ...`, `no vla 20`) - asserted so it
stays a decision.

## What remains unresolved

* **Sub-modes had no table.** `(config-if)#` refused `ip add 10.0.0.1 255.255.255.0`, `sw mo acc`, `desc uplink`
  and `do sh run`. The third pass below answers this one, with an `IFACE_WORDS` table built from `_ifaceMode()`'s own
  `head ===` comparisons plus the five positions after it; `do` itself is still not an interface command here.
* **`sh run` at `(config)#` is accepted here and refused by a box.** Pre-existing, unchanged by this pass: this
  console answers `show` at `(config)#` where a box prints `% Invalid input detected at '^' marker`. Because the
  `show` door is in the table, `sh ver` reaches it too - consistent within the console, divergent from a box. What
  would settle it: whether the console should refuse `show` at config (a behaviour change with its own test) rather
  than teaching config mode to abbreviate a door a box does not open.
* **`en` at `(config)#` is `end` here.** A 2960 also has `enable password`/`enable secret` at config, so a box
  would call `en` ambiguous. This console has neither command, so `enable` cannot be a rival without inventing a
  door - the word set is this console's, as the first pass already stated for short prefixes.
* **Words after `show ip`.** `show ip int br` needs a table for `interface` and for `brief`, and each further
  `show ip <x> <y>` form needs its own. Not attempted.
* **Whether IOS's uniqueness is per mode or across the whole image.** `co` is ambiguous at EXEC on a box
  (`configure`, `connect`, `copy`); whether a word that exists only in config mode can make an EXEC prefix
  ambiguous was not settled by any source read here.

## Third pass: `(config-if)#`, the position operators type in most

The first pass's unresolved list named the sub-modes as the biggest hole: `(config-if)#` refused `ip add
10.0.0.1 255.255.255.0`, `sw mo acc`, `desc uplink` and `do sh run`, and that prompt is where a session is spent.
The vendor's rule is written for "commands and keywords", with no mode in it - the same sentence the first pass
quoted - so the mode is a dispatcher to fix, not a question to re-ask. What was missing was evidence that operators
actually write it that way on real gear. Four transcripts answer that:

```
SW2950(config)#int vlan1
SW2950(config-if)#ip add 192.168.1.2 255.255.255.0
SW2950(config-if)no shut
```
https://community.cisco.com/t5/switching/cisco-2950-switch/td-p/1007218

```
Rack1R1(config)#int f0/1
Rack1R1(config-if)#ip add 0.0.0.1 255.255.255.0
```
https://community.cisco.com/t5/switching/what-is-the-lowest-prefix-possible-and-the-lowest-ip/td-p/1214384

```
CiscoR1(config-if)#ip add
CiscoR1(config-if)#ip address 192.168.1.2 255.255.255.0
Router(config-if)#ip na
Router(config-if)#ip nat ou
Router(config-if)#ip nat outside
```
https://community.cisco.com/t5/switching/cisco-887va/td-p/4749176

```
R1(config-subif)#no ip add
```
https://community.cisco.com/t5/networking-blogs/leak-map-eigrp-some-leaks-are-useful/ba-p/3102498

and a CCNP lab transcript uses the switchport pair throughout: `sw mo acc`, `sw ac vlan 2`, `sw acc vlan 4`
(https://www.scribd.com/document/814808735/Ccsi-Notepad). The 887VA thread is the one that settles the *depth*:
the operator shortens the second word (`ip na`) and the third (`ip nat ou`), not only the first.

`engine/cli.js` now resolves the words of an interface line against six tables, each built from a `head ===` or
`tokens[1] ===` the dispatcher already compares against, so a shortening can only reach a door the whole spelling
reaches:

| position | table | example |
|---|---|---|
| the first word | `IFACE_WORDS` (17 words) | `shut`, `sh`, `desc uplink`, `ip add ...` |
| the word after `no` | `IFACE_NO_WORDS` (10) | `no shut`, `no sw`, `no ip add` |
| the word after `ip` / `ipv6` | `IFACE_IP_WORDS` (4) / `IFACE_IPV6_WORDS` (1) | `ip ad`, `ip o cost 10`, `no ip ac 101 in` |
| the word after `switchport` | `IFACE_SWITCHPORT_WORDS` (5) | `sw ac vlan 20`, `sw mo acc` |
| the value of `switchport mode` | `IFACE_SWITCHPORT_MODE_WORDS` (2) | `sw mo acc`, `sw mo t` |
| the word after `encapsulation` / `clock` | one word each | `encap dot1q 10`, `cl rate 64000` |

A shared prefix is refused in the console's existing sentence with the mode in it, and the line is quoted as the
operator typed it, not as it would have resolved:

```
sw1(config-if)#no s     -> % Ambiguous interface command "no s": shutdown | switchport | speed (type more characters)
sw1(config-if)#ip a     -> % Ambiguous interface command "ip a": address | access-group (type more characters)
sw1(config-if)#d        -> % Ambiguous interface command "d": description | duplex (type more characters)
```

`sh` is ambiguous there too (`show` and `shutdown`), which is what a box says at that prompt - the command word is
decided before the view word after it is read, so `sh flurbish` is an ambiguity, not an invalid view.

`test/iface-word-abbreviation.test.js` pins 117 assertions: nineteen shortenings answer byte-for-byte as their
whole spelling and are shown to *change the device* (so a console that resolved both to the same refusal cannot
pass), seven shared prefixes refuse and leave `mode === 'iface'`, `switchport mode`'s two values resolve, and the
values - a description, an address, a VLAN id, a rate - are asserted untouched.

## What this pass did not settle

* **`sp` is `speed` at `(config-if)#` here, and ambiguous on a box.** `spanning-tree` is not a word this
  dispatcher compares against: the mode hands an unrecognised line to the config handler, which is how
  `spanning-tree portfast` and `vlan 20` are answered at that prompt. Including `spanning-tree` in the table would
  make `sp` ambiguous, but by the same argument `vlan`, `hostname`, `router` and `access-list` would have to be in
  it too, and then the table is no longer "the words this dispatcher dispatches". The table keeps its invariant and
  the divergence is stated here and asserted in the test.
* **The `no` asymmetry between modes is deliberate.** At `(config)#` the words after `no` are an open set (`no
  vlan`, `no ip dhcp pool`, `no dns zone`, `no scion`, `no hostname`...) and stay unresolved, as the second pass
  decided. At `(config-if)#` the set is closed and ten words long, so it is resolved. `no vla 20` at `(config)#`
  is still refused, and the test asserts that too.
* **The third position is untouched.** `ipv6 address auto` does not reach `autoconfig`, and `switchport trunk
  allowed vlan add 5` has its leaf words unresolved. Each needs its own table and its own evidence; nothing here
  guessed at them.
* **`do` in interface mode is still refused.** The first pass noted `do sh run` at `(config-if)#` as an IOS form
  this console does not take. This pass resolved the words, not the door: `do` is still not an interface command
  here, so the transcript line that motivated the sub-mode work is only half answered.
* **The refusal sentence is still the console's, not IOS's.** A box prints `% Ambiguous command: "no s"` here;
  this console keeps `% Ambiguous interface command "no s": ...`, on the same reasoning as the first pass.
