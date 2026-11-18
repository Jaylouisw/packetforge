# `speed` and `duplex` — what may follow the first word

**Question (one, narrow).** An interface's line rate and duplex are set by two one-word commands. What may
follow that first word on a real IOS switch — can `speed 100 flurbish` or `duplex full flurbish` set anything
— and what do the `no` forms take?

**Verdict: nothing may follow, in either command.** Both syntax lines are closed: one rate, one mode. The only
position that carries a second word is `auto`, which may be followed by the rates the port is allowed to
advertise. The two `no` forms do *not* match each other: `no speed` takes no argument at all, while
`no duplex {auto | full | half}` takes the same three words as the positive form and returns the port to the
default, `auto`. A word outside those shapes is the CLI's generic parse error and nothing is applied.

Measured against this console, four orders did something a box would not: `speed 100 flurbish` forced 100 Mb/s
and never mentioned the word, `speed auto 10` was answered as a plain `speed auto` (a different setting on
hardware), `speed nonegotiate` was called an *invalid rate* although it is a real keyword, and
`no speed flurbish` returned the port to autonegotiation anyway.

## The evidence

| Source | What it says |
| --- | --- |
| [Catalyst 2960-X Consolidated Platform Command Reference 15.2(6)E, Interface and Hardware Commands](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/command_reference/b_1526_2960x_cr/interface_and_hardware_commands.html), `speed` | `speed { 10 | 100 | 1000 | 2500 | 5000 | auto [ 10 | 100 | 1000 | 2500 | 5000 ] | nonegotiate }` and, on the next line, `no speed` — no argument on the form that resets it |
| same page, `speed` syntax description | "If you use the 10, 100, 1000, 2500, or 5000 keyword with the **auto** keyword, the port autonegotiates only at the specified speeds." — the only place a second word is legal |
| same page, `duplex` | `duplex { auto | full | half }` and `no duplex { auto | full | half }` |
| same page, `duplex` defaults | "The default is **auto** for Fast Ethernet and Gigabit Ethernet ports." — so `no duplex half` means "back to auto", not "unset the word half" |
| [Catalyst 3850 Interface and Hardware Commands, 3SE](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3850/software/release/3se/int_hw_components/command_reference/b_int_3se_3850_cr/b_int_3se_3850_cr_chapter_010.pdf), examples | "This example shows how to set a port to autonegotiate at only 10 Mb/s" — `speed auto 10`; then `speed auto 10 100` for "only 10 or 100 Mb/s". Two rates after `auto` in one line, from the vendor's own example |
| [same book, Using the Command-Line Interface](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/command_reference/b_1526_2960x_cr/using_the_command_line_interface.html), error table | `% Invalid input detected at '^' marker.` — "You entered the command incorrectly. The caret (^) marks the point of the error." |

## What is known

1. **One rate, one mode.** Both lines have a single value position and no optional tail. `speed 100 1000` is
   as much a parse error as `speed 100 flurbish`: there is no second slot to put a number in — that is what
   `auto` is for.
2. **`auto` is the exception, and it is a different command's worth of behaviour.** `speed auto 10` pins the
   advertisement to 10 Mb/s while leaving autonegotiation on. It is not shorthand for `speed 10`.
3. **`nonegotiate` is a real keyword on `speed`** — "Disables autonegotiation, and the port runs at 1000 Mbps.
   This option is valid and visible only on 10/100/1000 Mb/s ports." It is not a rate, so calling it an
   invalid rate names the wrong fault.
4. **The `no` forms are not symmetric.** `no speed` has nothing after it; `no duplex` repeats the three words
   of its positive form. Both return the port to the default, so the word on `no duplex` is a check on what
   was typed, not a second setting.
5. **The failure mode is the CLI's generic one, at parse time.** The caret rule means the line is rejected
   before the interface is consulted: a serial port, which has no line rate at all, still answers about the
   stray word rather than about its missing capability.

## What is inferred

That the console should refuse rather than apply, and say which word it did not use. This console is not
byte-identical to IOS — its refusals are sentences, not a caret under the token — but the *outcome* it owes a
reader is the one the parse error produces: the word is not part of the command, nothing changed, and the
answer is about the word. That is the rule `ip address <ip> <mask> <word>` already follows
(`research/ip-address-trailing-word.md`) and the sweep in `test/no-command-swallows-a-word.test.js` enforces
for the value position.

## What changed

| Typed | Before | Now |
| --- | --- | --- |
| `speed 100 flurbish` | forced 100 Mb/s, word never mentioned | `% speed 100 takes one rate and nothing after it: the word "flurbish" was not used, and the rate is unchanged` |
| `speed 100 1000` | forced 100 Mb/s, `1000` dropped | the same refusal, quoting `1000` |
| `speed auto 10` | answered `Speed auto-negotiation on Fa0/1`, i.e. a plain `speed auto` | `% speed auto 10 is not modelled: a real switch autonegotiates only at the rates named there, this console offers the whole ladder …` |
| `speed auto flurbish` | answered as `speed auto` | `% speed auto takes a rate after it, not "flurbish" …` |
| `speed nonegotiate` | `% Invalid rate "nonegotiate" - give a number of Mbps or auto` | `% speed nonegotiate is not modelled: it is a real keyword …` |
| `no speed flurbish` | returned the port to autonegotiation | `% no speed takes no argument: it returns this port to autonegotiation (the word "flurbish" was not used, and the rate is unchanged)` |
| `duplex full flurbish` | set full duplex, word never mentioned | `% duplex full takes one mode and nothing after it: the word "flurbish" was not used, and the duplex is unchanged` |
| `no duplex flurbish` | returned the port to auto | `% no duplex takes auto, full or half: the word "flurbish" was not used, and the duplex is unchanged` |
| `no duplex half` | (unchanged) returned the port to auto | still returns it to auto — real syntax, and the default it returns to is `auto` |

Every refusal is answered before anything is written: `test/speed-duplex-grammar.test.js` (46 checks) compares
`show running-config` before and after each one, and `test/no-command-swallows-a-word.test.js` gained a fourth
section that hands a *good* value plus a stray word to both commands on both device kinds.

## What remains unresolved

* **`duplex nonegotiate`.** The `duplex` page of the 15.2(6)E book lists only `auto | full | half`, so a word
  outside those three is refused here, `nonegotiate` included. Older Catalyst 2960 pages are reported to list
  `nonegotiate` on both commands, which would make this console's `% Usage: duplex auto | full | half` a
  wrong refusal for a keyword a fiber port accepts. No page in hand shows that syntax line, so nothing was
  changed for it; what would settle it is a Catalyst 2960 (not 2960-X) command-reference `duplex` page from
  the 12.2 train, or a transcript of `duplex nonegotiate` answering anything but a parse error.
* **The same trailing word, ten other commands.** The sweep that found `speed`/`duplex` also measured these,
  and every one of them still reads its value and drops the word after it, changing state:
  `switchport mode access <word>`, `switchport access vlan 20 <word>`, `switchport voice vlan 20 <word>`,
  `switchport trunk native vlan 20 <word>`, `spanning-tree priority 4096 <word>`, `channel-group 1 mode active
  <word>`, `ip nat inside <word>`, `ip access-group 10 in <word>`, `ipv6 address 2001:db8::1/64 <word>`, and
  `vrrp 10 ip 10.0.0.254 <word>`. Two of those need a keyword decision before they can be refused cleanly:
  `vrrp <id> ip <address> [secondary]` and `encapsulation dot1q <vlan> [native]` both take a real optional
  word this console does not model, which is the `secondary` case `ip address` already answers by name. Each
  family deserves its own run, with its own syntax line, rather than one blanket guard.
* **`% Incomplete command.`** The vendor's message table prints a full stop after "Incomplete command"; this
  console's does not. That is a separate one-character question and was left alone here.
