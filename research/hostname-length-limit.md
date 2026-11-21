# A `hostname` past 63 characters: refused, shortened, or taken?

**Question (one, narrow).** Every IOS-like `hostname` reference publishes the same rule - "Names must be 63
characters or fewer" - and none of them says what the CLI *does* with a name that breaks it. Does the box refuse
the name and keep the old one, take it and shorten what it displays, or take it whole - and does the same answer
hold on the platforms this catalogue models?

**Verdict: the answers disagree, so nothing was changed.** One capture, on a Catalyst 3560 running IOS
12.2(55), refuses 64 characters with a specific sentence and leaves the prompt on the old name; the same thread
reports an IOS XE virtual router (CSR1Kv) and an IOS 15 7200 taking a longer name with no complaint and only
shortening the *prompt* to 20 characters, the running-config keeping the whole name. A third platform family in
this catalogue documents a different ceiling again (Catalyst 1200/1300: 1-58 characters). A single rule would be
right for one lineage and wrong for the others, and PacketForge's catalogue makes even the 63-character rule
unimplementable without a separate decision (36 of 2,351 models are labelled longer than 63 characters, below).

## What the vendor publishes

| Source | Says |
| --- | --- |
| [Cisco IOS Configuration Fundamentals Command Reference, F through K - `hostname`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/command/cf_command_ref/F_through_K.html) | The rule only: "They must start with a letter, end with a letter or digit, and have as interior characters only letters, digits, and hyphens. **Names must be 63 characters or fewer.**" The one outcome the page publishes is the all-numeric one ("the name will be accepted after an error is returned"), not the length. |
| [IOS XE 17.3.x Catalyst 9300 Command Reference, System Management](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-3/command_reference/b_173_9300_cr/system_management_commands.html) | The same rule, the same all-numeric transcript, nothing about length. Also the platform note that matters later: "a field of 30 characters is used for the hostname and the prompt in the CLI. Note that the length of your hostname may cause longer configuration mode prompts to be truncated." |
| [IOS XE 17.12.x Catalyst 9500 Command Reference](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/17-12/command_reference/b_1712_9500_cr/system_management_commands.html) | The same two paragraphs again; the catalogue's IOS XE switches inherit this text. |
| [Catalyst 1300 CLI Guide, System Management Commands](http://cisco.com/c/en/us/td/docs/switches/lan/campus-lan-switches-access/Catalyst-1200-and-1300-Switches/cli/C1300-cli/system-management-commands.html) | A **different ceiling in the same vendor's CLI**: "**Name** - Specifies the device host name. (Length: **1-58 characters**)." The [C1200 guide](http://www.cisco.com/c/en/us/td/docs/switches/lan/campus-lan-switches-access/Catalyst-1200-and-1300-Switches/cli/C1200-cli/system-management-commands.html) prints the identical line. |
| [NX-OS Fundamentals Command Reference, `hostname`](https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus6000/sw/command/reference/fund/7x/n6k-fund-cr/n6k-fund_cmds_h.html) | "The name is alphanumeric, case sensitive, can contain special characters, and can have a maximum of **63 characters**", and "The character limit of a hostname is increased from 32 to 63" - a fourth number in the same product line's history. |
| [Aruba AOS-CX CLI, `hostname`](https://arubanetworking.hpe.com/techdocs/AOS-CX/10.17.1000/HTML/CLI_6300-6400/GUID-7A901425-E7B5-4941-A54A-3770483882D4.html) | Not Cisco, and the contrast that shows the *sentence* is a vendor's, not a law: `switch(config)# hostname ThisIsAVeryLongHostnameThatExceedsTheMaximumLengthLimitOf64Characters` → "The hostname cannot exceed 63 characters in length." Its parameter table also says "Length: 1 to 32 characters" two paragraphs above the 63-character error - the same vendor contradicting itself inside one page. |

## What the two captures show

Both are on Cisco's own community site, in one thread, posted by the same lab author
(<https://learningnetwork.cisco.com/s/question/0D53i00000KsyjTCAR/hostname-length>). The page body is
JS-rendered and did not extract, so these are quoted from the page's indexed text, where two different queries
returned the same lines and annotations verbatim:

> `! next I try 64 chars and it fails.`

```
a2345678901234567890(config)#$78901234567890123456789012345678901234
% Hostname must have more than 1 character and must not exceed the maximum 63 character length.
a2345678901234567890(config)#
```

and, in the same thread's later reply, the platform split stated in words:

> N1Kv (NX-OS) - 32 characters max; CSR1Kv (IOS-XE) and 7200 (IOS 15) - there seems to be no limit but IOS will
> always shorten the output into 20 characters for what will be shown in all modes but will display the whole
> name in the running-config; 3560 (IOS 12.2(55)) - 63 characters max

Three facts follow, and only the first is a transcript of a box refusing:

1. **Refusal, with a sentence and a trailing full stop**, on a 3560: the prompt after the error is the *old* name,
   so the name was not taken. The sentence also names a lower bound ("more than 1 character") that no document
   states and no capture here exercises.
2. **Acceptance with a shortened prompt**, on IOS XE CSR1Kv and IOS 15 7200: the name is stored whole (it shows in
   the running-config) and only the display is cut, to 20 characters on that author's boxes.
3. **No single number**: 32 (NX-OS), 58 (Catalyst 1200/1300), 63 (IOS/IOS XE references and the 3560).

## What PacketForge does today

No limit at all, and no prompt field: the name is stored, printed in the prompt at full length and written to the
config. Measured on a `C2960X-24TS-L` at this tree (the prompt is 72 characters after the 63-character name,
because `(config)#` is nine of them):

```
sw1#configure terminal
sw1(config)#hostname aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa(config)#
sw1(config)#hostname aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa(config)#
```

Neither rename printed a line. `show running-config` then carries `hostname <64 a's>` (73 characters with the
keyword), and a 97-character name is accepted the same way. The start prompt is `Catalyst 2960X-24TS-L-sw1>` -
21 characters of catalogue label plus the lab id, 26 with the `>` - so the "30-character field" the IOS XE
reference describes is not modelled either.

## Why no engine change

A refusal is one `if` in the `hostname` branch (`engine/cli.js`, beside `hostnameIsAllNumeric()`), but it cannot
land without answering a question about this repository's data rather than about a device:

* **36 of the 2,351 catalogue models carry a label longer than 63 characters** (11 Huawei, 9 Aruba, 4 Opengear,
  2 each Edgecore/Hikvision/Phoenix Contact, ...). The longest is 97: `Huawei NetEngine 8000 M14 DC (2x
  CR5DE2NE4X14, 1x CR5D00E8XM25, 3x CR5D00LAXF91, 1x CR5D00EAGF95)`.
* `show running-config` prints `hostname <dev.config.hostname || dev.name>` (`engine/cli.js:7630`), so those 36
  models print their own over-long label as a `hostname` line, and `test/config-roundtrip.test.js` replays every
  model's config through the CLI and fails on any `%` line. A blanket refusal would fail 36 models on a rule
  about hardware that never had a 97-character name to begin with - the same trap
  `research/hostname-illegal-characters.md` documents for the character rule, and the reason that note narrowed
  its check to the all-numeric case.

The three ways out, none of them one narrow increment:

1. **Per-platform predicate** (a `hostnameLimit()` beside `routingDefault()`): refuse at 58 for Catalyst
   1200/1300, 63 for IOS/IOS XE Catalyst and NX-OS, no ceiling for IOS XE virtual platforms. Needs the CSR1Kv
   "no limit" claim to be more than one forum reply, and needs the catalogue's Cisco small-business specs to be
   split from the IOS XE ones.
2. **A legal default name per device** (a box's default is `Router`/`switch`, never a model string), keeping the
   label for display only. That is the principled fix and it moves the canvas label, the inspector header and
   every suite that asserts a default name.
3. **Treat the device's own current name as a no-op** (accept `hostname <the name it already has>` even past the
   limit). It preserves the round-trip sweep, but the exemption is unreachable on hardware and would have to be
   documented as a simulator accommodation, not as a device rule.

## What is known, inferred, unresolved

**Known.** The 63-character rule is published by four IOS/IOS XE references and refused at 64 on a 3560 with
`% Hostname must have more than 1 character and must not exceed the maximum 63 character length.`; the prompt is
a fixed field that truncates the displayed name on at least one IOS XE build; the ceiling differs by platform
family (32/58/63) within one vendor.

**Inferred.** That the 15.2E/17.x Catalyst switch lineage the catalogue models behaves like the 3560 rather than
like the CSR1Kv - the 3560 is the only Catalyst capture, and IOS XE switches are not the same image as IOS XE
virtual routers. Also inferred: that the length check runs before the all-numeric *warning*, so an over-long
all-numeric name would draw only the refusal; no capture shows the two together.

**Unresolved, and what would settle it.**

1. **64 characters on a Catalyst 2960X (15.2E) or 9300 (17.x)**: the prompt and `show running-config | include
   hostname` after the attempt. That single capture decides whether the catalogue's main family refuses.
2. **The CSR1Kv claim.** "No limit" on IOS XE comes from one reply, not a transcript with a 64+ character
   `show running-config`; a capture would decide whether IOS XE really dropped the check or only the display.
3. **The prompt field.** 20 characters (that reply) against the reference's "30 characters ... on most systems",
   and whether the cut is per mode (`(config-if)#` needs more room than `#`). A capture of one long name in three
   modes settles the width and the truncation rule.
4. **What a real box prints at 1 character**, the lower bound the refusal sentence names and no document states.
