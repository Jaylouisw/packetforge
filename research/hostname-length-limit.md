# A hostname past 63 characters: refused, truncated, or taken?

**Question (one, narrow).** On an IOS-like box, what happens when `hostname` is given a name longer than the
63 characters every reference calls the ceiling — is the name refused, silently cut, or stored anyway — and
what exactly does the console print?

**Verdict: refused, in a fixed sentence, and the name is left alone.** The console had no length rule at all,
so a 64-character name renamed the device: the config line, `device.name`, the prompt, the canvas label and
every surface that renders the name. It now refuses anything past 63 characters with the box's own line and
keeps the name it had.

```
sw1(config)# hostname aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
% Hostname must have more than 1 character and must not exceed the maximum 63 character length.
  64 characters, so the name is still "sw1"
```

The second line is this console's, not the box's: it states the count and what was kept, which is the rule
the missing-argument refusal already follows (`% Incomplete command: hostname <name> (the name is unchanged)`,
#1497). The first line is verbatim.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco IOS Configuration Fundamentals Command Reference, F through K — `hostname`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/command/cf_command_ref/F_through_K.html) | "Names must be 63 characters or fewer" — stated as a rule of the command, in the same paragraph as the ARPANET character rules. |
| [Cisco IOS XE 17.12.x Catalyst 9300 command reference — System Management Commands, `hostname`](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-12/command_reference/b_1712_9300_cr/system_management_commands.html) | The same sentence on IOS XE, plus the prompt-length paragraphs quoted below. |
| [Cisco IOS XE 17.18.x Catalyst 9500 command reference — System Management Commands, `hostname`](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/17-18/command_reference/b_1718_9500_cr/system_management_commands.html) | Same limit, same words, a different platform. |
| [Cisco Learning Network, "Hostname length"](https://learningnetwork.cisco.com/s/question/0D53i00000KsyjTCAR/hostname-length) — a practitioner walking the boundary on a live IOS session | Takes a 63-character name, then: `a2345678901234567890(config)#hostname a234…90123` → `% Hostname must have more than 1 character and must not exceed the maximum 63 character length.` → `a2345678901234567890(config)#`. The prompt after the refusal is the *old* name, so the command was refused, not applied and truncated. (The same session notes the typed line itself is cut at 77 columns with a `$`, which is the terminal, not the name.) |
| [Cisco Community, "Maximum length Hostname"](https://community.cisco.com/t5/other-network-architecture-subjects/maximum-length-hostname/td-p/529327) | The contradiction worth recording: a CAT6500 on 12.1(20)E2 reported hostnames "truncated to 12 characters", and a reply says names up to 30 are "acceptable and anything longer will get truncated in the display". That is the **prompt** losing characters, not the name: the same thread quotes the 63-character rule and the recommendation to keep names under 10 characters. |
| [Aruba AOS-CX `hostname` reference](https://arubanetworking.hpe.com/techdocs/AOS-CX/10.18.xxxx/HTML/Fundamentals_6300-6400/switch-system-and-hardware-commands/hostname.html) | A different vendor refusing the same shape in its own sentence ("The hostname cannot exceed 63 characters in length."), so a ceiling at 63 is not one vendor's quirk. |

## What is known

1. The ceiling is 63 characters, published as a rule of the command on IOS, IOS XE and a third-party OS, and
   the one recorded session that tests it shows 63 taken and 64 refused.
2. The refusal is **one fixed sentence naming both bounds at once** — "must have more than 1 character and
   must not exceed the maximum 63 character length" — printed with the `%` prefix the parser errors carry.
3. The name is **unchanged** by a refusal: the prompt in the transcript still reads the pre-existing name.
4. It is not a truncation. Cut-to-fit only happens to the *prompt*, which every reference describes separately
   ("a field of 30 characters is used for the hostname and the prompt ... the full prompt for service profile
   configuration mode is `(config-service-profile)#` ... with the hostname `Router` you will only see
   `Router(config-service-profil)#`").

## What is inferred

* **That the sentence is the answer for the upper bound alone.** It is one string covering both bounds, so an
  IOS box almost certainly tests `len < 2 || len > 63` in one place. Only the upper half is enforced here,
  because only the upper half is captured: the transcript's author tested 63 and 64, never 0 or 1.
* **That the sentence is fixed rather than parameterised.** No capture shows a variant with the number in it,
  and the same sentence appears for both the 64-character and the (cut-off) longer line in the transcript.

## What was changed

* `engine/cli.js`: `HOSTNAME_MAX = 63` and `hostnameLengthRefusal()`, asked in the `hostname` handler after the
  help-key refusal and **before** the all-numeric warning — a 64-digit name breaches both rules and the box
  answers the one that stops the command. No early return above it changes: the name, `device.name`,
  `nameBeforeHostname` and `show running-config` are all untouched by a refusal.
* `test/hostname-length-limit.test.js`: 25 assertions — the 63-character name taken whole (config, `device.name`,
  prompt, running-config), 64 refused with both lines and every piece of state unchanged, a 200-character name
  refused with its own count, a 64-digit name answered by the length rule and not the numeric warning, spaces
  counted as characters at the boundary in a multi-word name, and `no hostname` still working after a refusal.
* `test/config-roundtrip.test.js`: four catalogue models (`huawei/netengine-8000-m14`, `-m6`, `-m8`, and the
  Aruba `Instant On 1830 24G …`) have a *default device name* longer than 63 characters, because this
  simulator derives the name from the model string; the printer writes that name as the `hostname` line, so the
  sweep was replaying a name a box refuses. The sweep now seeds a legal name for those four and says why — the
  fixture was the impossible part, the same call this file already makes for routes on media converters.

## What remains unresolved

1. **The lower bound.** Whether a box refuses `hostname a` (one character) is stated by the sentence and by
   nothing else. A capture of `hostname a` and `hostname ab` on hardware settles it; until then a one-character
   name is still taken here.
2. **Whether an unrenamed device should print a `hostname` line at all.** The printer writes
   `hostname (config.hostname || device.name)`, which is what put a 100-character line in the four configs
   above. On a factory-fresh box the default name is short and the question is whether the line is printed for
   it — a printer question, not a parser one, and its own run.
3. **The 30-column prompt field.** Every reference says "on most systems" and gives one worked example per
   platform; whether this console's prompts should clip the mode word to keep 30 columns is unmodelled, and the
   CAT6500 thread's 12-character report shows the field is not the same size on every box.
