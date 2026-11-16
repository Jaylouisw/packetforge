# A line the box cannot parse: which message, and where the caret sits

**Question (one, narrow).** When an IOS-like box is handed a line it cannot parse, what exactly does it print
— and, in the `% Invalid input detected at '^' marker.` answer, at which column does the `^` land?

**Verdict: known, and not adopted.** The four answers a real box gives are documented and the caret rule is
pinned by two transcripts below. PacketForge gives none of them: it prints one line that *quotes the word*
(`% Unrecognized command: flurbish`). That is a deliberate, tested design decision (docs/CLI.md, "A word the
console does not know is never swallowed"), not an oversight, so this run changed no engine code. What is
genuinely unresolved is which of the two answers a real box gives at an **EXEC** prompt, because that depends
on a console setting PacketForge does not model.

## The vendor's own table

Every IOS/IOS-XE CLI chapter carries the same three rows (Catalyst 2960-X 15.2(6)E, Catalyst 1000 15.2(7)E,
Catalyst 3750-X 15.2(1)E, Catalyst 9200 17.18.x — verbatim identical):

| answer | when | caret? |
|---|---|---|
| `% Ambiguous command: "show con"` | the prefix matches more than one command | no |
| `% Incomplete command.` | the line stopped where more is required | no |
| `% Invalid input detected at '^' marker.` | "You entered the command incorrectly. The caret (^) marks the point of the error." | yes |

* http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/command_reference/b_1526_2960x_cr/using_the_command_line_interface.html
* https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst1000/software/releases/15_2_7_e/command_reference/b_1527e_1000_cr/using_the_command_line_interface.html
* http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3750x_3560x/software/release/15-2_1_e/configuration/guide/scg3750x/swcli.html
* http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-18/command_reference/b_1718_9200_cr/using_the_command_line_interface.html

The Cisco IOS Configuration Fundamentals guide adds the sentence the table implies: the `^` "appears at the
point in the command string where the user has entered incorrect or unrecognized command syntax"
(https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/configuration/guide/12_2sr/cf_12_2sr_book/cf_cli-basics.html).

## Where the caret goes: the first character the prefix match loses

Two transcripts, both measured character by character rather than eyeballed.

```
R1#show ip interface brif
                     ^
% Invalid input detected at '^' marker.
```

The caret line is 22 characters: 21 spaces and a `^` at column 22. The typed text is `show ip interface brif`
(22 characters; the `R1#` prompt is not counted), and `brif` occupies columns 19-22, so the caret sits under its
**last** character. `brief` shares `b`, `r`, `i` with what was typed and diverges at the fourth character —
which is exactly where the caret is.
(https://routelearn.net/ccna/cisco-ios/cli-modes — "Example output · based on Cisco documentation")

```
Router#conft
           ^
% Invalid input detected at '^' marker.
```

Same arithmetic: seven characters of prompt, eleven spaces, `^` at column 12, i.e. the fifth character of
`conft` — `conf` is a valid abbreviation of `configure` and `t` is where it stops being one.
(https://2007.blog.dest-unreach.be/2009/04/22/avoiding-the-typo-penalty-in-cisco-ios/)

**The rule, as far as two independent transcripts can carry it:** the caret marks the first character that no
valid completion shares with what was typed — measured from the start of the typed text, not from the prompt,
and with no prompt echo on the caret line. Where the very first character already matches nothing the caret
would be at column 1; no transcript in hand shows that case, so it is inference (see unresolved, below).

## The fourth answer: an unknown first word at EXEC is a hostname

At `>` or `#`, a word that is not a command is first treated as the name of something to connect to:

```
Router#conft
Translating "conft"...domain server (255.255.255.255)
 (255.255.255.255)
Translating "conft"...domain server (255.255.255.255)
% Unknown command or computer name, or unable to find computer address
```

Cisco documents this as intended behaviour — "when a command in user or enable mode is entered ... and this
command or input is not recognized, the router believes that this is the host name of a device that the user
attempts to reach via telnet" — and gives two ways out: `no ip domain-lookup`, or `transport preferred none`
on the line, after which the same typo answers with the caret form
(http://www.cisco.com/c/en/us/support/docs/routers/10000-series-routers/46253-ipdomain-lookup.pdf).

Note the boundary the sources draw: the translation happens only when the **first** word is the unknown one.
`show ip interface brif` (above) is an EXEC line with a bad *third* word, and it answers with the caret form,
no lookup. So "EXEC mode answers with the caret" and "EXEC mode answers with Translating" are both true; the
choice between them is a line setting, not the mode.

## What PacketForge prints today

Measured on a Catalyst-2960-class `generic-switch` in this worktree, one session, real prompts:

```
Switch (L2)-sw1>flurbish                      -> % Unrecognized command: flurbish
Switch (L2)-sw1#flurbish                      -> % Unrecognized command: flurbish
Switch (L2)-sw1>configure foo                 -> % Invalid input: configure foo
Switch (L2)-sw1(config)#flurbish              -> % Unrecognized config command: flurbish
Switch (L2)-sw1(config-if)#ip addres 10.0.0.1 -> % Unrecognized interface command: ip addres 10.0.0.1
```

Three properties follow from the code, not from the run:

* **No caret line, ever.** The fallbacks push a single string: `engine/cli.js:168` (EXEC), `:147` (`configure`
  with a word that is not `terminal`), `:828` (config), `:1038` (interface, relabelled from the config answer),
  `:2361` (DHCP pool). Nothing in the repo prints `Invalid input detected`, and exactly one test asserts a
  current string: `test/help-key-works-in-every-prompt.test.js:85`, `/Unrecognized command: flurbish/`.
* **The word is quoted instead of pointed at.** That is the documented product decision — "**quoted** | names
  the word back — the shortest route from a typo to a correction" (docs/CLI.md, "A word the console does not
  know is never swallowed"), enforced by `test/no-command-swallows-a-word.test.js` across 33 command families.
  A real box never quotes the word in this situation; it points at it.
* **No `% Ambiguous command` and no bare `% Incomplete command.`** This console answers an ambiguous prefix
  with a usage line that lists the alternatives, and an incomplete line with `% Incomplete command: <the form>`
  plus a hint (docs/CLI.md, "A short line is not a wrong value"). Both are more informative than IOS, and both
  are deliberate.

## Why no engine code changed

1. **The caret column is not something this parser knows.** Every fallback reports the whole line; a line is
   resolved by walking a switch, not by returning "the first character that failed". Computing the column means
   knowing the keyword set of the command that *matched* — available for the first word (the exec command list
   is a table), not for arbitrary later words.
2. **At EXEC the real default answer is not the caret form.** PacketForge models neither `ip domain lookup` nor
   `transport preferred none`, so it cannot choose between "Translating ..." and the caret without inventing a
   state it does not have. Printing the translation pair would also promise DNS behaviour the simulator does
   not implement: there is a `show ip dns`, but no lookup-on-typo.
3. **Changing it would delete a tested affordance.** Quoting the word is the shortest route from a typo to a
   correction, and several suites hold the project to it (`test/no-command-swallows-a-word.test.js`,
   `test/command-answers-the-question.test.js`, `test/help-completeness.test.js`). Replacing it with `^` is a
   policy call for the owner of the project, not a fidelity fix a worker loop should land unasked.

## What would settle it

* A console capture from a real 2960 or IOS-XE box of one unknown **first** word at each of `>`, `#`,
  `(config)#`, `(config-if)#`, plus `configure foo` at `#`. Only the `#` case has a transcript in hand.
* The same capture after `line con 0` / `transport preferred none`, and separately after `no ip domain-lookup`
  **alone** — they are not the same setting, and nothing read here says what the second one alone prints (the
  blog shows the caret only after `transport preferred none`).
* A capture of a first word that matches the first character of no command at all, to confirm the caret lands
  at column 1 rather than after the longest common prefix of every command.

## If it is adopted later

The narrow, defensible slice is the **first word**: the exec command list is a table, so for a first word the
console already computes the abbreviation set (that is how `conf t` works). The same computation yields the
caret column — the length of the longest prefix shared with any command keyword, plus one — and the answer
becomes two lines instead of one. Later words need per-command keyword tables that do not exist in that shape.
Ambiguous and incomplete answers are a separate, larger question and are out of scope here.
