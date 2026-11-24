# `show ip ROUTE`: is a keyword matched in any case?

**Question (one, narrow).** When an operator types the words of a `show` command in upper or mixed case - `show
ip ROUTE`, `show ip interface BRIEF`, `show mac ADDRESS-TABLE` - does an IOS-like box accept the line, and does
this console?

**Verdict: known, and it was wrong here.** A box matches a command's keywords in any case, and says so in its own
documentation. This console lowercased the **first** word only: `show ip ARP`, `show ip VRRP` and
`show POWER INLINE` worked (their words are compared lowercased), while every view dispatched by a literal
comparison refused the capitalised spelling as an unknown view. Same console, same class of word, two rules.
Fixed in `engine/cli.js` (`_show` now compares the words after `show` through one lowercased copy) with
`test/show-keyword-case.test.js` (37 checks).

## Evidence

| Source | Says |
| --- | --- |
| [Configuration Fundamentals Configuration Guide, Cisco IOS Release 15.1S, *Using the Cisco IOS Command-Line Interface*](https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/configuration/guide/TIPs_Conversion/cf_15_1s_book/cf_cli-basics.html) | "**Note** You can enter commands in uppercase, lowercase, or mixed case. Only passwords are case sensitive. However, Cisco IOS documentation convention is to always present commands in lowercase." And, in the editing-shortcuts table: "Cisco IOS commands are generally case-insensitive, and are typically all in lowercase." |
| [Software Configuration Guide for the Cisco 5900 Series Embedded Services Routers, IOS 15.2(4)GC, *Using the Command Line*](https://www.cisco.com/c/en/us/td/docs/solutions/GGSG-Engineering/15-4-3M/config-guide/Configuration-Guide/CLIintro.html) | "Commands are not case-sensitive. You can abbreviate commands and parameters if the abbreviations contain enough letters to be different from any other currently available commands or parameters." |
| [Using Cisco IOS XE Software (Secure 8200 series software configuration guide, PDF)](http://www.cisco.com/c/en/us/td/docs/routers/secure-routers/sec-8200-series/software-config-guide/secure-8200-series-scg/using_cli.pdf) | The same two sentences on IOS XE: "Commands are not case sensitive." / abbreviation rule. |
| [ASR 5000 CLI reference, *About this Guide* (PDF)](http://www.cisco.com/c/en/us/td/docs/wireless/asr_5000/21-28/mode_i-q-cli-reference/21-28-cli-reference-i-q/m_about_cli.pdf) | "This document always gives the full form of a command in lowercase letters. Commands are not case sensitive." |

The Cisco 5900 page also carries the abbreviation rule in the same breath, which is why this note and
`research/command-word-abbreviation.md` are about the same sentence from two directions: a box folds the case of
a keyword **and** resolves a prefix of it. This note settles only the first half.

## What was wrong here, measured

One session on `generic-router` and one on `generic-switch` (before the change):

```
r1# show ip ARP                     -> the ARP table            (word compared lowercased)
r1# show ip VRRP                    -> % VRRP is not configured (same)
r1# show ip ROUTE                   -> % Invalid show command: ip ROUTE
r1# show IP ROUTE                   -> % Invalid show command: IP ROUTE
r1# show ip interface BRIEF         -> % Invalid show command: ip interface BRIEF
r1# show ip DHCP binding            -> % Invalid show command: ip DHCP binding
r1# show ip OSPF neighbor           -> % Invalid show command: ip OSPF neighbor
r1# show ipv6 ND                    -> % Invalid show command: ipv6 ND
r1# show mac ADDRESS-TABLE          -> % Invalid show command: mac ADDRESS-TABLE
```

`% Invalid show command:` is this console's sentence for *a view it does not have*. Every line above named a view
it does have, and `show ip ARP` three lines earlier proved the console already knew the rule - the words just
reached different comparisons.

## What changed

`engine/cli.js`, `_show()`: after the alias rewrite, the line is copied once with every word lowercased (`kw`), and
the view branches compare through that copy instead of the typed token. The branches affected were the seven
`what === 'ip' && tokens[1] === ...` comparisons (`nat`, `interface` + `brief`, `route`, `dns`, `dhcp`, `ospf`,
`bgp`), plus `show ipv6 nd` and `show mac address-table`. The handlers were already case-insensitive internally
(each builds its own lowercased copy of the words it was given), so no view needed a second implementation.

The **values** on the line are untouched: `show ip route EXTRA` still quotes `EXTRA` back, `show mac
address-table FLURB` still quotes `FLURB`, and a port name that reaches nothing is named in the spelling it was
typed in.

`test/show-keyword-case.test.js` pins: eleven case variants answer byte-identically to their lower-case twins and
none is refused as an unknown view; `show ip ROUTE` prints the connected and candidate-default rows of a real
table; `show ip interface BRIEF` prints the brief header and the address it was given; `show mac ADDRESS-TABLE`
and `show ipv6 ND` reach their views; a stray argument keeps its case in the refusal; `show ip FLURB` is still
refused and `show i` is still ambiguous; and the source keeps the rule in one place (no view branch compares a
typed token against a lower-case literal).

## What remains unresolved

* **An interface name.** This console resolves a port name case-insensitively (`show interfaces FA0/1` finds
  `Fa0/1` on a box whose ports are `Fa*`) and prints the panel's spelling in the block. Whether a box folds the
  *name* as opposed to the keyword, and what it prints, is not settled by the pages above - they are about
  commands. An operator's capture of `show int FA0/1` and `show int fa 0/1` on one switch would settle it. A first
  reading of this console's own behaviour got this wrong once: `show interfaces FA0/1` was refused on a Catalyst
  2960X because that model's ports are `Gi1/0/1`, not because of the case.
* **The words after a two-word view that are not keywords of this console.** `show ip dhcp BIN` is still refused,
  because the console does not shorten the words after `show ip dhcp`; case and abbreviation are separate
  decisions and only case was in scope here.
* **IOS's own refusal.** A real box answers a bad word with `% Invalid input detected at '^' marker.`, which this
  console does not print at all (`research/parse-error-caret.md`). Whether the caret's column counts the typed
  case is moot until that sentence exists here.
