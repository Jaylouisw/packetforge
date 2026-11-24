# What a box says - and does - when `hostname` is given a name that breaks the host-label rule

**Question (one, narrow).** Every IOS-like `hostname` reference publishes a rule for the name (ARPANET
host names) and shows one name that breaks it. Does the box refuse the name, warn about it, or warn
*and rename anyway* - and does it keep the name?

**Verdict: it warns and renames anyway, and only the all-numeric case is documented that far.** The line
is `% Hostname contains one or more illegal characters.`, and the prompt that follows carries the name it
just complained about. This console renamed in total silence - the one behaviour no IOS sample shows - and
now prints the vendor's sentence before taking the name. Every other breach shape (leading digit,
underscore, trailing dot, interior space, length) is left alone, because no document found shows the
outcome and the catalogue's own default names breach the rule.

## What the vendor publishes

| Source | Says |
| --- | --- |
| [Cisco IOS Configuration Fundamentals Command Reference, F through K - `hostname`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/command/cf_command_ref/F_through_K.html) | The rule: "They must start with a letter, end with a letter or digit, and have as interior characters only letters, digits, and hyphens. Names must be 63 characters or fewer." The outcome: "Creating an all numeric hostname is not recommended but **the name will be accepted after an error is returned**." Then the transcript: `Router(config)#hostname 123` / `% Hostname contains one or more illegal characters.` / `123(config)#`. |
| [Cisco IOS XE 17.7.x Catalyst 9600 Command Reference - System Management Commands](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/17-7/command_reference/b_177_9600_cr/system_management_commands.html) | The same paragraph word for word and the same `hostname 123` transcript, on a switch platform; default hostname `switch`. |
| [Cisco IOS XE 17.10.x Catalyst 9300 System Management Configuration Guide](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-10/configuration_guide/sys_mgmt/b_1710_sys_mgmt_9300_cg.pdf) | The rule restated in the procedure table ("Names can be up to 63 characters"), with no refusal path described. |
| [Cisco IOS XE 17.3.x Catalyst 9300 Command Reference](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-3/command_reference/b_173_9300_cr/system_management_commands.html) | The special-character note: `hostname \99` also answers `% Hostname contains one or more illegal characters.` - and the text stops there. No prompt, no running-config, no statement that the name was taken. |
| [Cisco IOS XE 17.11.x Catalyst 9500 Command Reference](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/17-11/command_reference/b_1711_9500_cr/system_management_commands.html) | Same rule, same wording, same transcript - the behaviour is stable across the 16.x-17.x references sampled. |
| [Cisco 1900/2900/3900 Software Configuration Guide, Appendix A CLI](https://www.cisco.com/c/en/us/td/docs/routers/access/1900/software/configuration/guide/Software_Configuration/appendixAcli.html) | The rule restated for ISR G2, and the factory default name `Router` - which is legal, so a box's own config never contains a flagged name. |
| [Cisco Catalyst 1200/1300 CLI Guide - System Management Commands](http://www.cisco.com/c/en/us/td/docs/switches/campus-lan-switches-access/Catalyst-1200-and-1300-Switches/cli/C1200-cli/system-management-commands.html) | A different lineage (small-business CLI): the same start/end/interior rule, a shorter limit (1-58 characters), and **no error text published at all** - the wording is IOS/IOS XE's, not universal. |
| [Cisco ASA 9.20 General Operations CLI Configuration Guide - Basic Settings](https://www.cisco.com/c/en/us/td/docs/security/asa/asa920/configuration/general/asa-920-general-config/basic-hostname-pw.html) | ASA restates the rule ("must start and end with a letter or digit, and have only letters, digits, or a hyphen"), up to 63 characters, and publishes no refusal text either. |

## What is known, and how sure

* **The warning is advisory, not a refusal: documented, twice over.** The usage note says the name "will
  be accepted after an error is returned", and the sample transcript shows the prompt after the error
  carrying `123`. Router and switch platforms, 15.x and 17.x references.
* **The wording, trailing full stop included: documented verbatim, and printed here unaltered.** It is not
  wrapped in this console's `% Warning:` prefix, because recognising the line is the whole value of
  printing it.
* **The rule itself: quoted identically across seven vendor documents.** Start with a letter, end with a
  letter or digit, interior letters/digits/hyphens only - and one message for every violation shown.
* **A box's own default name never breaches it.** IOS defaults to `Router`, IOS XE to `switch`; the
  catalogue here defaults to a vendor model string, which is a fact about this repository, not about a
  device. That asymmetry is what makes the next section necessary.

## Why only the numeric case is modelled

The published rule is broader than the published *outcome*. Only one breach gets the second half of the
story - the name being taken anyway - and it is the numeric one. The `\99` sample proves the message fires
for a special character but stops before the prompt. So the console warns exactly where a transcript
exists and stays silent everywhere else.

The second reason is mechanical and was found by running the change rather than by reading it: the
catalogue's default device names are vendor model strings, and many of them breach the rule -
`ZenWiFi ET8` (space), `FRITZ!Box 7590` (`!` and space), `7280R3-48YC8` (leading digit). Since
`show running-config` prints `hostname <name>` and `test/config-roundtrip.test.js` replays all 2198
models' configs back and asserts no complaint, a whole-rule check warned on every replay of every such
device. A box's own config never contains a flagged name because its default is `Router`/`switch`;
this repository's is a model string, so the wider check would have made a warning storm out of a
correct configuration. That is evidence about the model, not a get-out: the narrower check is the
honest one anyway, and the wider question is open below.

## Open questions, and what would settle them

1. **Is any non-numeric breach also accepted after the warning?** `hostname r1_r2`, `hostname 9r1`,
   `hostname r1.` - the console is silent. One console capture of the prompt (or a `show
   running-config`) after `hostname \99` on any IOS 12.4/15.x/17.x box would settle the class.
2. **What happens past 63 characters?** *Answered after this note was written*: a transcript of the
   boundary shows the 64-character name **refused**, in the sentence `% Hostname must have more than 1
   character and must not exceed the maximum 63 character length.`, with the old name still in the prompt.
   The console now refuses at that ceiling - `research/hostname-length-limit.md` carries the sources, the
   change and the half of that sentence (the lower bound) that no capture settles.
3. **What a real box does with a multi-word name** (`hostname core switch 1`). Not documented anywhere
   found. The console keeps every word (#19/#21) and stays silent; nothing here changes that.
4. **Whether the warning repeats on re-typing the same name.** The console warns every time, because the
   check is on the name and not on a transition. No sample of a repeated entry exists.
5. **Platforms that word it differently.** Catalyst 1200/1300 and ASA publish the rule with no error text;
   a box from either lineage may say something else entirely, or nothing.

## What changed

* `engine/cli.js`: `hostnameIsAllNumeric(name)`, and the `hostname` handler pushes the vendor's sentence
  *before* it stores the name, then stores it exactly as before - no early return, nothing skipped.
* `test/hostname-illegal-characters.test.js`: 45 checks - the exact line and the resulting `123(config)#`
  prompt, the name reaching `show running-config`, the line printed once and before the name is taken,
  a second identical rename warning again, four other breach shapes staying silent, four catalogue-style
  names staying silent, six legal names printing nothing, and `no hostname` restoring without a warning.
* `docs/CLI.md` and `CHANGELOG.md`: the before/after transcripts and the scope of what is modelled.
