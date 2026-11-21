# `no channel-group 1 mode on`: what the undo form takes, and what this console used to drop

**Question (one, narrow).** The `channel-group` command takes a mode keyword. Does its **undo** form take
one too — and what does an IOS-like switch do with `no channel-group 1 mode on`, the line a half-remembered
configuration produces?

**Verdict: the undo takes the group number and nothing else, and a box refuses every word after it as a
parse error. This console read the id, threw the rest away, and removed the port from the bundle** — so a
line the hardware rejects changed the link and reported success. The refusal is now the console's own
sentence, because the project does not print the vendor's caret message (`research/parse-error-caret.md`),
and the bundle is left exactly as it was:

```
sw1(config-if)#no channel-group 1 mode on
% no channel-group takes the group number and nothing after it: the word "mode on" was not used, and nothing was changed
```

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 2960-X Layer 2 Commands, 15.2(4)E](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_4_e/command_reference/b_1524e_consolidated_2960x_cr/b_1524e_consolidated_2960x_cr_chapter_0101.html) | The two syntax lines, side by side: `channel-group channel-group-number mode { active \| auto [non-silent] \| desirable [non-silent] \| on \| passive }` and `no channel-group`. The `mode` keyword belongs to the setting form only. |
| [Catalyst 9300 Command Reference, IOS XE 16.5](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/16-5/command_reference/b_165_9300_cr/b_165_9300_cr_chapter_0111.html) | The same two lines, character for character, three releases and a platform family later. |
| [Catalyst 9300 Command Reference, IOS XE 17.3](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-3/command_reference/b_173_9300_cr/layer_2_3_commands.html) and [26.x](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/26-x/command_reference/b_26x_9300_cr/layer_2_3_commands.html) | Still the same pair. The absence of `mode` from the undo line is not one book's typesetting. |
| [Cisco Community, "Remove commands", Aug 2022](https://community.cisco.com/t5/switching/remove-commands/td-p/4667709) | A CCNA candidate's transcript of the exact mistake: `no channel-group 1 mode on` → `% Invalid input detected at '^' marker.` The thread's answer is the valid form, `no channel-group 1`. |
| [Catalyst 4500 configuration guide, *Configuring EtherChannel* (PDF)](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/3-1-1SG/configuration/guide/config/channel.pdf) | The worked removal examples are `no channel-group 1` (members leave the bundle) and, separately, `no interface port-channel 1` (the interface is removed). A number after the undo is a documented spelling; a mode after it is not. |

## What is known

1. The setting form's grammar is `channel-group <number> mode <one keyword>`; the undo form's grammar carries
   no `mode` keyword at all. Four command references across 15.2 and IOS XE 16.5–26.x print the same pair of
   lines.
2. A word after the undo's number is answered with the parser's refusal (`% Invalid input detected at '^'
   marker.`) and nothing is applied — the community transcript is one line of input and one line of output,
   with the bundle still present afterwards (the thread continues by using the valid form).
3. The numbered undo itself is real, even though the syntax blocks print the bare form: the 4500 guide's
   example types `no channel-group 1`. Cisco's books are inconsistent about printing the optional number;
   they are unanimous that `mode` is not part of the undo.

## What is inferred

* **Where the caret lands.** The capture does not show the caret line under the text, only the sentence. The
  grammar makes the first unconsumed word (`mode`) the error, which is where a parser would point, but this
  note does not claim it.
* **Whether every image words it identically.** Only one live capture was found; the references describe the
  grammar but not the refusal. The console therefore uses its own sentence, in the shape it uses for the
  other commands that took a word they do not take (`switchport mode`, #2315).

## What this console did, and what changed

Before this run, `_channelGroup()`'s remove branch read `tokens[1]` as the id and ignored the remainder, so:

```
sw1(config-if)#no channel-group 1 mode on
Gi1/0/1 removed from channel group 1 (the group had no other members)
```

— the port left the bundle, on a line the box rejects. The id is still validated first (so
`no channel-group mode on` keeps the "not a group number" sentence), and any token after the id is now
refused before membership is read, before any group is touched, and before the removal receipt is built. The
bare form, the numbered form and `no channel-group 9999` behave exactly as they did.

## Unresolved

1. **The caret line.** No capture in hand prints it under this command; the console does not print caret
   messages by design.
2. **Other vendors.** Huawei/HPE have their own grammar for undoing a link aggregation; this console speaks
   one IOS grammar for every vendor, so the sentence would appear on all of them. That is the existing
   decision, not new evidence.
3. **`no channel-group 1 mode` with the mode word omitted.** Also refused here (it is a word after the id);
   no capture shows whether a box's parser stops at `mode` before noticing the missing value. The behaviour
   is the same either way — nothing is applied.
