# `spanning-tree priority` off the 4096 ladder: what a box says, line for line

**Question (one, narrow).** A bridge priority that is inside `0`–`61440` but not a multiple of `4096` is
refused by the box rather than rounded. What exactly does the box print when it refuses it - how many lines,
what wording, and how wide is the field each allowed value sits in? This console refused the value with a
sentence of its own:

```
% 4500 is not a valid bridge priority: it must be a multiple of 4096 (the low 12 bits are the system ID
  extension); the nearest valid values are 4096 and 8192
```

**Verdict: known and adopted for the step case.** The box prints four lines - two sentences, then its sixteen
allowed values eight to a line - in which each value occupies a six-character field. The console now prints
those four lines verbatim. The *range* refusal (`61441`) is unchanged and remains this console's own sentence,
because the captures are of the step check, not of IOS's parser refusing a number outside `<0-61440>`.

## The evidence

The block appears, unchanged, in the Catalyst 4500 configuration guides across fifteen years. Two of them are
PDFs whose Courier text layer survives extraction, and that is what pins the spacing:

| Source | What it prints |
| --- | --- |
| [Catalyst 4500 Software Configuration Guide 12.2(37)SG, "Configuring MST Instance Parameters"](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/37sg/configuration/guides/config/spantree.pdf) | `% Bridge Priority must be in increments of 4096.` / `% Allowed values are:` / `0     4096  8192  12288 16384 20480 24576 28672` - `0` followed by five spaces, then two-space gaps after the four-digit values |
| [Catalyst 4500, IOS XE 3.9.xE / 15.2(5)Ex](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/XE3-9-0E/15-25E/configuration/guide/xe-390-configuration/spantree.pdf) | the same four lines, the same six-wide column |
| [Catalyst 4500 12.2(50)SG, "Configuring MST Instance Parameters"](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/50sg/configuration/guide/Wrapper-46SG/spantree.html) (also 12.2(20)EWA, 12.2(31)SG, 12.2(25)EWA) | `Switch(config)#spanning-tree mst 1 priority 1` then the block; HTML collapses the runs of spaces |
| [Cisco Community, "Spanning Tree VLAN Priority Issue"](https://community.cisco.com/t5/switching/spanning-tree-vlan-priority-issue/td-p/2506756) | `Core-switch(config)#spanning-tree vlan 10 priority 100` then the block - the per-VLAN form draws the same message |
| [Cisco Learning Network, "Bridge priority in PVST+"](https://learningnetwork.cisco.com/s/question/0D53i00000KswsyCAB/bridge-priority-in-pvst) | `spanning-tree vlan 1 priority 1` then the block |
| [Cisco Community, "STP Priority Values"](https://community.cisco.com/t5/switching/stp-priority-values/m-p/891247) | the same block on "real switches & PVST", plus the fact that a CST box (Dynamips) accepts `priority 1`; "whether you can enter 1 or not depends on whether extended sysid feature is enabled" |
| [traceroute.home.blog, "Spanning Tree Protocol (STP) – Part 1"](https://traceroute.home.blog/2019/06/24/spanning-tree-protocol-stp-part-1/) | the block in a fenced code block - single spaces, i.e. transcribed from a page that had collapsed them |
| [Cisco Community, "Can network professionals answer this question?!"](https://community.cisco.com/t5/switching/can-network-professionals-answer-this-question/m-p/5300031) (2025) | all sixteen values on **one** line: `0 4096 8192 ... 57344 61440` |

The two PDF text layers agree value for value: `0` occupies six characters (`0` plus five spaces), `4096` and
`8192` six each (two spaces after), `12288`–`28672` six each (one space after), and the second line is eight
five-digit values separated by single spaces. That is one left-aligned six-character column, wrapped after the
eighth value.

## What is known

1. The message is **four lines**: the sentence, the heading, and two rows of eight values.
2. It is the *value* check's message, not the command's usage: the entered number is not echoed back, the
   command name does not appear, and the same block comes from `spanning-tree vlan <id> priority`,
   `spanning-tree mst <n> priority` and (per the 4500 books) the MST instance form.
3. The sixteen values are every multiple of 4096 from 0 to 61440 - the set the check accepts.
4. Values sit in a six-character column, eight to a row at the default terminal width.
5. Whether a non-multiple is accepted at all depends on the extended system ID: on a PVST+ box (and on the
   older 16-bit-priority images that predate 12.1(12c)EW) the low 12 bits belong to the VLAN id, so the
   priority can only move in 4096 steps. This console runs one tree per device and has always enforced the
   step, which is the PVST+ behaviour.

## What is inferred

* **The global form draws the same block.** This console's command is `spanning-tree priority <n>` (one tree,
  no VLAN id), and no capture of that exact spelling was found. The block is produced by the shared value
  check - the same four lines come from two different commands that reach it - so the global form is inferred
  to draw it too. Nothing in the message names a VLAN, an instance or a command.
* **The 8 + 8 split is a wrap, not part of the text.** The 2025 paste shows all sixteen on one line, which is
  what a wider terminal produces. The console has no terminal width, so it prints the default-width form.

## What is unresolved

* **The wrap at other widths.** `terminal width 0`/`120` (or a narrow window) would re-flow the list; the
  console prints the 80-column arrangement unconditionally. A capture at `terminal width 120` on a box that
  prints all sixteen on one line, and one at a narrow width, would settle the algorithm.
* **Whether the rows are indented.** PDF text extraction trims leading spaces at the start of a line, and every
  HTML source collapses them, so the captures cannot say whether the box begins each row at column 0 or two
  spaces in. The console prints them at column 0, matching every transcript as rendered.
* **`%` prefix on the value rows.** Both PDFs show the rows without a `%`, which is what the console prints; a
  capture in a code block that preserves the leading characters would confirm it independently.
* **The out-of-range refusal.** `spanning-tree priority 70000` is a parser error on a box (`<0-61440>` is the
  token's range), almost certainly the caret form `% Invalid input detected at '^' marker.`; no capture was
  collected for it, so this console keeps its own sentence there.

## What changed

`engine/cli.js`: a value in range that is not a multiple of 4096 now returns the four box lines
(`STP_PRIORITY_STEPS` / `stpPriorityStepRefusal()`), with each value padded to six characters and trailing
padding trimmed (the repo's control-byte check refuses trailing whitespace, and a capture would not show it).
The range check is unchanged and still runs first, so `61441` is still answered with the range - the fix from
#1505 that stopped the old step rule from suggesting `65536`.

Regression: `test/stp-priority.test.js` pins all four lines byte for byte, the absence of the rejected number,
the count of sixteen, and - the part that matters for #1505 - that **every** value the refusal lists is one the
command accepts (all sixteen are replayed). `test/command-answers-the-question.test.js` moved to the new
wording, and `docs/CLI.md` "Setting the root" quotes the block.
