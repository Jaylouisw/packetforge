# A VLAN name: how long, and what the console does with a longer one

**Question (one, narrow).** A VLAN's name is typed as `vlan <id> name <text>` (or `name <text>` in the
config-vlan sub-mode). How long may that string be, and what does the box do with one that is too long —
refuse it, truncate it, or store it?

**Verdict: 1 to 32 characters, and it is the same 32 as the width of the Name column in `show vlan`.**
Every Cisco reference that documents the field states that range, on both IOS/IOS XE and NX-OS, and the
`show vlan` header rule draws exactly 32 dashes under the Name. The two facts are one fact: a name the table
cannot print inside its cell is not a name the box can hold. This console had no length rule at all, so
`vlan 4094 name <40 characters>` was stored and `show vlan` printed a row **eight columns wider than every
other row**, pushing `Status` and the ports list right — on the one table an operator holds against a change
record. The name is now refused above 32 characters, before the VLAN is created, so a rejected name leaves
nothing behind (`engine/vlan.js` `VLAN_NAME_MAX`, `engine/cli.js` the `vlan` branch;
`test/vlan-name-length.test.js`, 18 checks).

## Evidence

| Source | Says |
| --- | --- |
| [Cisco IOS LAN Switching Command Reference, `show vlan`](https://www.cisco.com/c/en/us/td/docs/ios/lanswitch/command/reference/lsw_book/lsw_s2.html) | Both halves in one page. `show vlan ... name name`: "valid values are an ASCII string from 1 to 32 characters"; and the sample output is the header `VLAN Name Status Ports` over a rule whose Name segment is 32 dashes, with rows `1 default active Fa5/9` and `2 VLAN0002 act/lshut Fa5/9` |
| [Catalyst 2960-X 15.2(6)E command reference, `vlan` (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/command_reference/b_1526_2960x_cr.pdf) | "**name** *vlan-name* — Names the VLAN with an ASCII string from 1 to 32 characters that must be unique within the administrative domain. The default is VLANxxxx where xxxx represents four numeric digits (including leading zeros) equal to the VLAN ID number." |
| [Catalyst 2960-X 15.2(5)E VLAN chapter (PDF)](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_5_e/command_reference/b_1525e_consolidated_2960x_cr/b_1525e_consolidated_2960x_cr_chapter_01100.pdf) | The same sentence for the same field, plus "the VLAN name is an ASCII string from 1 to 32 characters" on the `show vlan name` keyword |
| [Catalyst 1200/1300 CLI guide, VLAN commands](https://www.cisco.com/c/en/us/td/docs/switches/campus-lan-switches-access/Catalyst-1200-and-1300-Switches/cli/C1300-cli/vlan-commands.html) | The range again ("vlan-name — Specifies the VLAN name. (range: 1–32 characters)"), **and the one-line grammar this console uses**: `vlan {vlan-id [name vlan-name]}` in global configuration, `name <string>` (length 1–32) in the VLAN interface mode |
| [Cisco IOS XE 17.4 command reference (Catalyst 9300), VLAN commands](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-4/command_reference/b_174_9300_cr/vlan_commands.html) | The range on current IOS XE, so this is not an artefact of the 12.2-era pages |
| [NX-OS 5600 Layer 2 configuration guide, "Configuring VLANs"](https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus5600/sw/interfaces/7x/b_5600_Layer2_Config_7x/config_vlans.html) | The only **transcript** found of an over-long name, and it is a refusal: `switch(config-vlan)# name 33Char1234567890987CiscoBangalore` → `ERROR: Long VLAN name is not enabled: Vlan name greater than 32 is not allowed!` Without the long-name feature the limit is 32; a 129-character name is cut off by the parser's own length check (`% String exceeded max length of (128) at '^' marker.`). The guide also states what the display does with a long name once allowed: "the show vlan commands will show the output in multiple lines with each line containing a maximum of 32 characters" |

## What is known

* The field is **1 to 32 ASCII characters** — stated identically by IOS, IOS XE and NX-OS references, and by
  the `show vlan name` keyword description, which is the reader's half of the same fact.
* The **Name column in `show vlan` is 32 characters** wide, with a 32-dash rule under the heading (already
  pinned character for character in `research/show-vlan-columns.md`).
* A name **cannot be set on VLAN 1** (it is `default` and cannot be renamed), which this console already
  refuses; the 32-character rule is the other half of the same "the name field has rules" door.
* A too-long name is **not printed as one long line**: NX-OS wraps the cell at 32 characters when long names
  are enabled, and refuses the name outright when they are not.

## What is inferred

* That an IOS console **refuses** rather than stores-and-truncates. This is inference. The range is
  documented, and the one transcript in hand (NX-OS, without the long-name feature) refuses with an explicit
  error; but IOS was not witnessed. Truncation would also be consistent with "the value is 32 characters" from
  the reader's side — a truncated name is still a 32-character name.
* That the right refusal here is the console's own sentence rather than a vendor string, for the reason this
  project uses everywhere: a vendor sentence is reproduced when it has been seen, and invented never.

## What remains unresolved

* **The exact IOS/IOS XE sentence** for `name <33 characters>`. Not found in any command reference (they give
  the range, never the breach) or in any forum transcript. Candidates, by analogy: the parser's
  `% Invalid input detected at '^' marker.` (if the token simply exceeds the string length it accepts), or a
  vendor-worded `% Invalid VLAN name...` line. **What would settle it:** one capture from a Catalyst console of
  `vlan 100` → `name <33 characters>`, or the IOS CLI reference page that lists the `name` token's parser type
  and its overrun behaviour.
* **Whether IOS truncates instead.** The NX-OS transcript shows refusal; nothing shows IOS either way. **What
  would settle it:** the same capture, followed by `show vlan brief | include 100` and `show running-config |
  include "vlan 100"` — a truncated name appears there, a refused one does not.
* **Non-ASCII names.** The references say "ASCII string"; this console counts JavaScript string length, so a
  name of 17 astral-plane characters counts 34 and is refused, where a byte-counting parser might too. Not
  witnessed, and no lab in the catalogue names a VLAN in a non-Latin script.
* **The `name` keyword's own limits elsewhere.** `switchport voice vlan` and the interface `description` are
  separate fields with their own documented maxima (description 240 characters is the usual figure); neither
  has been asked yet.
