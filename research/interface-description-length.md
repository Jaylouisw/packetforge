# An interface description: how long may it be, and what does the box do past the limit?

**Question (one, narrow).** `description <text>` in interface configuration mode takes a free-text string, which
this console stores whole (`engine/cli.js:2957`) and prints back in `show interfaces <port>` (`desc: ...`,
`engine/cli.js:7931`) and in `show running-config` (`engine/cli.js:8123`). Is there a maximum length, what is it,
and what does an IOS-like box do with a string longer than it - refuse it, truncate it, or store it anyway?

**Verdict: half-settled, and still not implemented.** The first pass of this note said the number itself was
unknown. It is not: `description ?` in interface configuration mode answers
`LINE Up to 240 characters describing this interface` - captured on a **Catalyst switch** (a 2960-class `SW-4`)
and independently on two routers - which agrees with the four Catalyst configuration guides already in hand and
makes 240 the figure this device family advertises at the prompt rather than a figure read off a book. What the
box *does* with a line past 240 is still unrecorded: the only behavioural witness is a 12.2 router taking roughly
200 words "with no issues", which is an acceptance and stops there. So `engine/` is unchanged by this pass: the
console stores what was typed and prints it back, which is what that witness shows, and a refusal would still be
invented.

## The help line, captured

```
SW-4(config-if)#description ?
   LINE Up to 240 characters describing this interface
SW-4(config-if)#description VLAN used to connect all servers.
```

| Source | Capture | What it shows |
| --- | --- | --- |
| [Cisco Learning Network, *Leave a comment in running-config*](https://learningnetwork.cisco.com/s/question/0D53i00000Kt3sdCAB/leave-a-comment-in-runningconfig) | the block above, from `SW-4` - a **switch**, in interface configuration mode, followed by `description VLAN used to connect all servers.` and `do show run` | the token is `LINE`, the sentence is `Up to 240 characters describing this interface`, and the box then accepts a 39-character description |
| [Network Enhancers, *Cisco Question Mark Magic* (2011)](http://networkenhancers.blogspot.com/2011/01/cisco-question-mark-magic.html) | `Router(config-if)#description ?` / `LINE Up to 240 characters describing this interface` on `gi3/0/0`, in an article about `Ctrl-V`/`Esc-Q` | the same sentence on a router, and the same behaviour of the help key: `?` is consumed by the parser, which is why the escape is needed to type one into the text |
| [Applied Cisco Networking (switching) lab book, PDF](https://asecuritysite.com/public/cisco_switch.pdf) | `(config-if)# description ?` / `  LINE  Up to 240 characters describing this interface`, then `(config-if)# description aironet 1200` | a third capture, a **switch** lab, with a real description typed after it |
| [Catalyst 3560 configuration guide, 12.2(25)SEA, "Adding a Description for an Interface" (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3560/software/release/12-2_25_sea/configuration/guide/3560scg/swint.pdf) | "Add a description (up to **240 characters**) for an interface", with `show interfaces gigabitethernet0/2 description` printing `Interface Status Protocol Description` | an older Catalyst generation with the same 240, so the figure is not IOS XE-only |

The padding between `LINE` and the sentence differs in all three captures (`   LINE`, `LINE`, `  LINE  `), which
is extraction collapsing the help column rather than three different boxes: the sentence itself is identical in
each, and that is the fact this note keeps. The claim that matters - that the box states the ceiling at the
prompt - is settled.

## What is known

* The field is a **comment**, not a protocol value: the command reference says it is "meant solely as a comment",
  and the only places it surfaces are `show interfaces`, `more system:running-config` and
  `more nvram:startup-config`.
* **A Catalyst advertises 240 at the prompt**, in the help text above, on a switch and on routers.
* **Every book that states a maximum states a different one**: 64 (Catalyst 1200/1300 CLI guide), 200 (IOS XE
  SD-WAN qualified reference), 238 (IOS Interface and Hardware Component Command Reference), 240 (Catalyst
  2960-X, 3850 and 3650 configuration guides, the 3560 12.2(25)SEA guide, and the help line itself).
* **The command is accepted past any of those numbers.** The one person who tested it pasted about 200 words on
  a 12.2 1700 and got "no issues". Whatever the box did, it did not refuse.
* **The console here answers the help key in its own words.** `description ?` prints:

```
% "?" is the help key, not a description: `description <text>` - the description of Fa0/1 is unchanged
```

That answer is a sentence rather than a `LINE` row (`engine/cli.js:2950`, the sentence built at `:1386-1389`), so the captured line is recorded for
reference and not adopted as this console's help text.

## What is inferred

* That the box **truncates** past its ceiling rather than refusing. A line five times the limit being taken
  without a word is consistent with truncation and with no enforcement at all, and no source in this note
  distinguishes the two. This is inference from one unquoted claim, not from a transcript.
* That the family this console models - an IOS-like Catalyst access switch - is the **240** family: the help line
  says so on a switch, and four Catalyst configuration guides across 12.2(25)SEA, 15.2(4)E and IOS XE 3SE/16.1 say
  240, while 238 comes from an IOS *router* command reference and 200 from an SD-WAN-qualified book for a
  different product line. The help line is the strongest reading available, and it is still not a witness of
  enforcement.
* That the 238-versus-240 gap is **off by two in the measurement, not in the field** - probably the text versus
  the text plus a terminator or a line prefix. No source states what either figure counts, so this is a guess
  and is recorded as one.

## What remains unresolved

1. **Refuse, truncate, or store.** The community transcript shows acceptance and stops there, and the help
   line does not say which. **What would settle it:** one console capture on a named image of
   `description <300 chars>`, then `show interfaces <port> description` and `show running-config interface
   <port>` - a truncated value appears there at its real width, a refused one does not appear at all - plus the
   `% ` line (if any) printed by the over-long command.
2. **Whether the help text is enforced at all.** A help row is a claim by the parser about its `LINE` token, and
   the 12.2 1700 witness suggests the token took well over 240. **What would settle it:** the same capture, or
   `description <241 chars>` on any Catalyst - one character over is the cheapest test.
3. **What the 64 in the Catalyst 1200/1300 CLI guide counts.** That book documents `Length: 1-64 characters` for
   the same command word on a different CLI generation. It is either a different product's real ceiling or a
   documentation limit on the type field. Out of scope here; recorded so a later reader does not average 64 and
   240.
4. **Where a rule would live, if one is ever added.** A limit enforced at the CLI door only would disagree with
   the loader, which assigns the description straight from a saved config (`engine/device.js:1831`, no length
   rule), and a lab restored from a real backup carrying a 300-character description would then be configurable
   one way and not the other - the seam `test/switchport-agreement.test.js` exists to guard. Any future rule has
   to be one function used by both doors.

## What the engine does today

Nothing, and that is a choice rather than an oversight. `description <text>` stores the whole joined line
(`engine/cli.js:2957`), `show interfaces <port>` prints it after `desc:` (`engine/cli.js:7931`), and
`show running-config` prints it as `  description <text>` (`engine/cli.js:8123`). Measured on the generic switch
in this catalogue: a 300-character description is stored as 300 characters, is echoed in full by the receipt and
by both views, and makes a 314-column line in running-config. Nothing overflows a column, because the
description is printed as a trailing free-text field and not inside a fixed-width cell - which is why the VLAN
name case (below) needed a rule and this one does not yet.

**Why the VLAN name has a rule and this does not.** `research/vlan-name-length.md` and
`engine/vlan.js` `VLAN_NAME_MAX` rest on three independent references that all say 1-32 *and* on the Name column
of `show vlan` being exactly 32 dashes wide - the field and its print are the same fact, so the limit is
over-determined. Here the references contradict each other, no printed field is bounded by the value, and the
only witness shows the box not refusing. Implementing 240 on that evidence would put a refusal on a command no
capture shows being refused - and the new help-line capture says nothing about enforcement either.

**If a future increment wants the rule**, it should not start from 240 because a help row said so. It should start
from the over-long capture in "what would settle it" above, and the note should then be rewritten with the number
and the behaviour that capture shows.
