# An interface description: how long may it be, and what does the box do past the limit?

**Question (one, narrow).** `description <text>` in interface configuration mode takes a free-text string, which
this console stores whole (`engine/cli.js:2320`) and prints back in `show interfaces <port>` (`desc: ...`,
`engine/cli.js:6337`) and in `show running-config` (`engine/cli.js:6487`). Is there a maximum length, what is it,
and what does an IOS-like box do with a string longer than it - refuse it, truncate it, or store it anyway?

**Verdict: unresolved, and deliberately not implemented.** The published maximum for this one command is four
different numbers depending on which Cisco book is open - 64, 200, 238 and 240 - and the only transcript in hand
of an over-long description shows the CLI taking roughly 200 words (well over a thousand characters) "with no
issues" on a 12.2 router. Two facts a length rule needs are therefore both missing: *which* number belongs to the
device family this console models, and whether the box refuses or truncates at it. The console's present
behaviour - store what was typed, print it back - is closer to that transcript than any refusal would be, so
`engine/` is unchanged by this note.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco IOS Interface and Hardware Component Command Reference, `description (interface configuration)`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book/ir-d1.html) ([PDF](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book.pdf)) | "Comment or a description to help you remember what is attached to this interface. **This string is limited to 238 characters.**" The same chapter's `description (controller)` says "up to **80** characters" - two numbers for the same command word in one book. Usage guidelines: "meant solely as a comment to be put in the configuration"; "appears in the output of the following EXEC commands: more nvram:startup-config, show interfaces, and more system:running-config" |
| [Software Configuration Guide, Cisco IOS Release 15.2(4)E (Catalyst 2960-X), "Configuring Interface Characteristics"](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_4_e/configurationguide/b_1524e_consolidated_2960x_cg/b_1524e_consolidated_2960x_cg_chapter_010.pdf) | `description string` - "Adds a description (**up to 240 characters**) for an interface." Same page's defaults table: "Port description - None defined." |
| [Interface and Hardware Component Configuration Guide, Cisco IOS XE Release 3SE (Catalyst 3850)](https://cisco.com/c/en/us/td/docs/switches/lan/catalyst3850/software/release/3se/int_hw_components/configuration_guide/b_int_3se_3850_cg.pdf) (and the [3650 edition](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3650/software/release/3se/int_hw_components/configuration_guide/b_int_3se_3650_cg.pdf)) | The same sentence and the same figure: "up to 240 characters", with the verification step `show interfaces gigabitethernet1/0/2 description` printing `Interface Status Protocol Description / Gi1/0/2 admin down down Connects to Marketing` |
| [Cisco Catalyst 1200 Series CLI Guide, `description`](https://www.cisco.com/c/en/us/td/docs/switches/campus-lan-switches-access/Catalyst-1200-and-1300-Switches/cli/C1200-cli/ethernet-configuration-commands.html) | "**string** - Specifies a comment or a description of the port to assist the user. (**Length: 1-64 characters**)." This is also the closest grammar to this console's one-line form, `description <text>` / `no description` |
| [Cisco IOS XE Catalyst SD-WAN Qualified Command Reference Guide, Interface Commands, `description (interface configuration)`](https://cisco.com/c/en/us/td/docs/routers/sdwan/command/iosxe/qualified-cli-command-reference-guide/m-interface-commands.html) | "This string is limited to **200** characters." Same prose as the IOS book, a third number |
| [Cisco Community: "Int description statement - how many characters allowed?" (2006, solved)](https://community.cisco.com/t5/routing/int-description-statement-how-many-characters-allowed/m-p/629940) | The only behavioural witness found. The asker: "I tested this question today by **copying around 200 words into a 1700 int with no issues** ... My 12.2 based 1700 did not appear to have any limitation". Accepted answer: "It appears 240 characters is the limit as per the documentation below. I checked a couple of routers, running different images, and a switch in my lab and they seem to support the same. Actually, when you do the **'description ?' on the int it tells you what the character limit is**." The asker's follow-up thanks him and reports the answer accepted; **no capture of the resulting `show running-config` is posted** |

## What is known

* The field is a **comment**, not a protocol value: the command reference says it is "meant solely as a comment",
  and the only places it surfaces are `show interfaces`, `more system:running-config` and
  `more nvram:startup-config`.
* **Every book that states a maximum states a different one**: 64 (Catalyst 1200/1300), 200 (IOS XE SD-WAN
  qualified reference), 238 (IOS Interface and Hardware Component Command Reference), 240 (Catalyst 2960-X,
  3850 and 3650 configuration guides).
* **The command is accepted past any of those numbers.** The one person who tested it pasted about 200 words on
  a 12.2 1700 and got "no issues". Whatever the box did, it did not refuse.
* **The console advertises the limit itself.** The accepted answer says `description ?` prints it - so the
  ceiling is visible at the prompt on a real box, which is the cheapest place to read it and the one capture
  nobody posted.

## What is inferred

* That the box **truncates** past its ceiling rather than refusing. A line five times the limit being taken
  without a word is consistent with truncation and with no enforcement at all, and nothing in the six sources
  distinguishes the two. This is inference from one unquoted claim, not from a transcript.
* That the family this console models - an IOS-like Catalyst access switch - is the **240** family: two
  Catalyst 2960-X configuration guides and two IOS XE Catalyst guides say 240, while 238 comes from an IOS
  *router* command reference and 200 from an SD-WAN-qualified book for a different product line. Three books
  agreeing on 240 is the strongest single reading available, and it is still not a witness.
* That the 238-versus-240 gap is **off by two in the measurement, not in the field** - probably the text versus
  the text plus a terminator or a line prefix. No source states what either figure counts, so this is a guess
  and is recorded as one.

## What remains unresolved

1. **238 or 240** for an IOS-like Catalyst, and therefore what `description 300 characters` leaves behind.
   **What would settle it:** one console capture on a named image of `description <300 chars>`, then
   `show interfaces <port> description` and `show running-config interface <port>` - a truncated value appears
   there at its real width, a refused one does not appear at all.
2. **Refuse, truncate, or store.** The community transcript shows acceptance and stops there.
   **What would settle it:** the same capture, plus the `% ` line (if any) printed by the over-long command.
3. **What `description ?` prints.** The responder says it states the limit; the text is not in hand, and this
   console answers its own help key with its own usage line, so the real one is a fidelity fact in itself.
   **What would settle it:** a capture of `description ?` in interface configuration mode.
4. **Whether the ceiling varies by platform on switches too.** The forum question was explicitly "is there an
   IOS, platform or device based difference", and the accepted answer tested "a couple of routers ... and a
   switch" without stating which switch. **What would settle it:** the figure from `description ?` on two or
   three different Catalyst families.
5. **Where a rule would live, if one is ever added.** A limit enforced at the CLI door only would disagree with
   the loader, which assigns the description straight from a saved config (`engine/device.js:1583`, no length
   rule), and a lab restored from a real backup carrying a 300-character description would then be configurable
   one way and not the other - the seam `test/switchport-agreement.test.js` exists to guard. Any future rule has
   to be one function used by both doors.

## What the engine does today

Nothing, and that is a choice rather than an oversight. `description <text>` stores the whole joined line
(`engine/cli.js:2320`), `show interfaces <port>` prints it after `desc:` (`engine/cli.js:6337`), and
`show running-config` prints it as `  description <text>` (`engine/cli.js:6487`). Measured on the generic switch
in this catalogue: a 300-character description is stored as 300 characters, is echoed in full by the receipt and
by both views, and makes a 314-column line in running-config. Nothing overflows a column, because the
description is printed as a trailing free-text field and not inside a fixed-width cell - which is why the VLAN
name case (below) needed a rule and this one does not yet.

**Why the VLAN name has a rule and this does not.** `research/vlan-name-length.md` and
`engine/vlan.js` `VLAN_NAME_MAX` rest on three independent references that all say 1-32 *and* on the Name column
of `show vlan` being exactly 32 dashes wide - the field and its print are the same fact, so the limit is
over-determined. Here the references contradict each other, no printed field is bounded by the value, and the
only witness shows the box not refusing. Implementing 240 on that evidence would put a refusal on a command no
capture shows being refused.

**If a future increment wants the rule**, it should not start from 240. It should start from the capture in
"what would settle it" above, and the note should then be rewritten with the number that capture shows.
