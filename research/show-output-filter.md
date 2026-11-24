# A pipe on a `show` line: an output modifier, not a word of the name

**Question (one, narrow).** When a `show` line carries a `|`, does the box read the words after it as part of the
object being asked about, or as a filter applied to the answer — and what should this console answer when it has no
filter?

**Verdict: known, and adopted as a parse, not as a filter.** The pipe ends the command; the object named on the
left is complete at the pipe. PacketForge read the whole rest of the line as a name, so `show interfaces Port 1 |
include packets` answered `% No interface Port 1 | include packets on Cambium cnMatrix EX2010-P-sw1` — it reported
a socket missing that the same command without the pipe prints. The pipe is now parsed before any view opens
(`engine/cli.js`, `showFilterRefusal`), and the four answers are pinned by `test/show-output-filter.test.js`. No
output filter is implemented.

## The vendor grammar

The same section appears verbatim in every IOS/IOS-XE CLI chapter:

> enter a show or more command followed by the pipe character (|), one of the keywords begin, include, or exclude,
> and an expression … `command | {begin | include | exclude} regular-expression`

with a worked example, `Device# show interfaces | include protocol`, printing only the matching lines, and the
note that "Expressions are case sensitive" (so `| exclude output` does not drop a line holding `Output`).

* Command Reference, Cisco IOS XE 17.12.x, Catalyst 9500, *Searching and Filtering Output of show and more Commands*
  — http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/17-12/command_reference/b_1712_9500_cr/using_the_command_line_interface.html
* The same text in the Catalyst 9200 17.18.x book
  — http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-18/command_reference/b_1718_9200_cr/using_the_command_line_interface.html
* and in the Catalyst 2960-X 15.2(7)E book
  — http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/command_reference/b_1527_2960x_cr/using_the_command_line_interface.html

Two properties follow and neither is this console's to invent: the pipe is a **delimiter** (the interface name is
what stands before it), and the keyword after it is one of three words. Nothing in the grammar makes the pipe a
character an interface name can hold, so the "a port name is the whole rest of the line" rule — correct and
necessary for a Cambium `Port 1` or a Ubiquiti `SFP+ 1` (#1401) — has to stop at a `|`.

## What changed

`_show()` splits the line at the first token that is exactly `|` before any door opens, so every view is parsed the
same way rather than one door at a time. Four answers, all one line, none printing the unfiltered block:

| typed | answer |
|---|---|
| `show interfaces Port 1 \| include packets` | `\| include packets` is an output modifier, and this console has no output filter: a box would print only the lines of the answer that match the expression - `show interfaces Port 1` on its own prints every line |
| `show ip route \| flurbish 10.` | not an output modifier: after the pipe a box takes `begin`, `include` or `exclude` and an expression |
| `show ip route \|` or `show ip route \| ?` | `% Incomplete command:` … naming the three words |
| `show \| include vlan` | an output modifier with no view before it: name a view before the pipe |

The filter word is compared lowercased, like any keyword (`| INCLUDE` is a filter, not a bad word); the expression
after it is not touched. `show running-config | include vlan`, which had its own sentence for this case, now gets the
same answer as every other view.

## What is inferred, and what is still unresolved

* **No filter is modelled, on purpose.** Printing the whole block under a filter the box would have applied is the
  same class of error as the `show ip route <prefix>` drop: the reader trusts lines that were meant to be gone. So
  the answer is a refusal. Implementing `include`/`exclude`/`begin` is a feature, and is not done here.
* **`show run|inc vlan`, with no spaces around the pipe, is untested.** IOS's parser is character-oriented enough
  that the glued form very likely filters too, but no capture in hand shows it, the parser here tokenises on
  whitespace, and either answer would be a guess. The two spellings are a follow-up question, not this one.
* **Whether `?` after a pipe prints the three-word menu on a real box** is not captured. This console answers
  `% Incomplete command:` and names the three words in the same line, which is the house form for a line that stops
  early; a capture of `show ip route | ?` would settle it.
* `section` (an IOS-XE/NX-OS modifier) is deliberately not listed, because the three cited books list three words.
  A box running a release that has four would answer the fourth as a bad word here.
