# A `show` word with nothing after it: incomplete command, or invalid one?

**Question (one, narrow).** When the first word of a `show` line is a word the box knows but the line is still not
complete — `show` with no view at all, or `show mac` / `show power`, whose commands are `show mac address-table`
and `show power inline` — which of the parser's two refusals does a real IOS-like switch print, and which one did
PacketForge print?

**Verdict: settled for the class of refusal, and the console printed the wrong one.** A recognised keyword whose
required words are missing draws `% Incomplete command.`; `% Invalid input detected at '^' marker.` is for a word
the parser does not know at that position. PacketForge answered all three shapes with
`% Invalid show command: …` — telling the operator the console had never heard of `show`, `mac` or `power`, which
is the one thing certainly untrue about each. The engine now answers `% Incomplete command: …` and names the word
that completes the line. One behaviour changed, one test file added
(`test/show-incomplete-view-word.test.js`, 23 checks).

## What PacketForge did (before)

Measured on `0649142a`, one 8-port `generic-switch`, nothing configured:

```
sw1#show
% Invalid show command: (empty)
sw1#show mac
% Invalid show command: mac
sw1#show pow
% Invalid show command: power          <- and the spelling echoed is not the one typed
sw1#show power
% Invalid show command: power
sw1#show po
% Ambiguous command "show po": port-channel | power (type more characters)
```

The console already had both facts it needed: `SHOW_VIEW_TAILS` (`engine/cli.js`) names `mac -> address-table` and
`power -> inline`, and the `show ?` listing prints each row *as a completion* of `show `, "because printing the
bare words would be advertising two commands this console refuses". The refusal one line above that table called
the same two words invalid.

## Evidence

| Source | Says |
| --- | --- |
| [Command Reference, Cisco IOS XE 17.18.x (Catalyst 9200), "Using the Command-Line Interface", Table 3](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-18/command_reference/b_1718_9200_cr/using_the_command_line_interface.html) | The three common CLI errors, defined: `% Ambiguous command: "show con"` — "You did not enter enough characters for your switch to recognize the command."; **`% Incomplete command.` — "You did not enter all the keywords or values required by this command."**; `% Invalid input detected at '^' marker.` — "You entered the command incorrectly. The caret (^) marks the point of the error." |
| [Consolidated Platform Command Reference, IOS 15.2(7)E (Catalyst 2960-X), PDF, Table 3](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/command_reference/b_1527_2960x_cr.pdf) | The same table, same wording, on the access-switch line this catalogue mostly imitates — and the chapter is the one that documents `show mac address-table`. |
| [Command Reference, IOS XE 17.15.x (Catalyst 9600), "Using the Command-Line Interface"](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/17-15/command_reference/b_1715_9600_cr/using_the_command_line_interface.html) | Third platform, third release train, identical table. |
| [Cisco Community, "Clearing mac address help how to?" (3750)](https://community.cisco.com/t5/switching/clearing-mac-address-help-how-to/td-p/3325072) | A captured session of exactly this shape — a keyword chain that needs one more word: `SW1#clear mac address-table` -> **`% Incomplete command.`** (then the thread's answer: it needs `dynamic`). Same parser, same family, and the reply is the bare sentence. |

## What is known

1. The parser distinguishes three faults and names them in a fixed vocabulary: ambiguous prefix, incomplete
   keyword chain, invalid input with a caret. The definitions are in every IOS/IOS XE command reference's CLI
   chapter, in the same words on 15.2(7)E, 17.15.x and 17.18.x.
2. "Incomplete" is what a **known** keyword draws when the words it requires are absent — captured for
   `clear mac address-table` on a 3750.
3. The sentence a box prints for it is `% Incomplete command.` and nothing else: no caret, no echo of the typed
   line, no hint (the table's "How to Get Help" column is advice about `?`, not text the box prints).

## What is inferred

* `show` on its own, and `show mac` / `show power`, fall in that second class. The inference is the parser rule
  plus the fact that all three words are valid keywords of a longer command (`show mac address-table`,
  `show power inline`). No capture in hand shows a bare `show` drawing the refusal; the 3750 `clear mac
  address-table` transcript is the nearest printed instance of the same rule.
* IOS would abbreviate the second word too (`show mac addr`), since `address-table` is a keyword like any other.
  **This console still refuses that** (`% Invalid show command: mac addr`) — it is a different question (tail
  abbreviation) and was left alone.
* The word after `show` was matched case-insensitively by this console's resolver while the tail was compared
  with `===` (`tokens[1] === 'address-table'`), so `show mac Address-Table` was refused. **That half is settled:**
  a box matches a keyword in any case, and the tail is now compared through the same lowercased copy as the rest
  of the line, so `show mac Address-Table` and `show ip ROUTE` reach their views - `research/show-keyword-case.md`
  has the sources. What is still refused is the *abbreviation* of the tail (`show mac addr`), the bullet above.

## What is unresolved

1. **The bare sentence versus the house hint.** The box prints `% Incomplete command.` with no advice. This
   console appends a hint to the same sentence everywhere else (`% Incomplete command: give a VLAN id (1-4094)`),
   and the change keeps that habit: `% Incomplete command: name a view after \`show\` (type \`show ?\` for the
   list)`. Whether to drop the hint in favour of the vendor's exact line is a house-style decision, not an
   evidence question; it is recorded here rather than decided silently.
2. **A capture of a bare `show` on a factory switch.** Any `switch#show` in a pasted session log would turn the
   inference in the first bullet into a reading.
3. **What a box does with `show mac` when the model has no MAC table at all** (a router). This console resolves
   the word before it checks the device, so the answer is the same "incomplete" on every platform; nothing was
   found that says whether a router's parser knows the keyword `mac`.

## What changed

* `engine/cli.js`, `_show()`: an empty view word returns the incomplete line; a resolved view word that has an
  entry in `SHOW_VIEW_TAILS` and nothing after it returns the incomplete line naming that completion, echoing the
  spelling the operator typed.
* `test/show-incomplete-view-word.test.js` (23 checks): the three shapes at `#` and from `do` in config mode,
  shortened spellings (`show m`, `show pow`), and the three things that must not move — an unknown word is still
  `% Invalid show command: <word>`, `show po` is still ambiguous, and both completed views still print.
